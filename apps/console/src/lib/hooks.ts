import { useEffect, useRef, useState } from 'react';
import type { ClipboardState } from '../../../../shared/contracts';

export function useDebounced<T>(value: T, delay = 250): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebounced(value), delay);
		return () => window.clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}

export function useClipboardEvents(onState: (state: ClipboardState) => void, onRefresh: () => void): boolean {
	const callbacks = useRef({ onState, onRefresh });
	callbacks.current = { onState, onRefresh };
	const [live, setLive] = useState(false);
	useEffect(() => {
		let socket: WebSocket | undefined;
		let retryTimer = 0;
		let refreshTimer = 0;
		let retries = 0;
		let cursor: number | undefined;
		let disposed = false;
		const refresh = () => {
			window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(() => callbacks.current.onRefresh(), 200);
		};
		const connect = () => {
			if (disposed) return;
			const url = new URL('/api/v1/clipboards/default/events', window.location.href);
			url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
			if (cursor !== undefined) url.searchParams.set('after', String(cursor));
			socket = new WebSocket(url);
			socket.onopen = () => {
				if (!disposed) {
					setLive(true);
					retries = 0;
				}
			};
			socket.onmessage = (message) => {
				try {
					const event = JSON.parse(String(message.data));
					if (event.type === 'clipboard.changed' && Number.isSafeInteger(event.revision)) {
						cursor = event.revision;
						callbacks.current.onState(event as ClipboardState);
						refresh();
					} else if (event.type === 'sync.reset' && event.state && Number.isSafeInteger(event.state.revision)) {
						cursor = event.state.revision;
						callbacks.current.onState(event.state);
						refresh();
					} else if (event.type === 'sync.ready') {
						cursor = event.revision;
					}
				} catch {
					/* A malformed notification must not affect the content view. */
				}
			};
			socket.onclose = () => {
				if (disposed) return;
				setLive(false);
				retryTimer = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)));
			};
			socket.onerror = () => socket?.close();
		};
		const connectTimer = window.setTimeout(connect, 0);
		const onVisible = () => {
			if (!document.hidden) refresh();
		};
		window.addEventListener('focus', onVisible);
		document.addEventListener('visibilitychange', onVisible);
		const poll = window.setInterval(onVisible, 30000);
		return () => {
			disposed = true;
			window.clearTimeout(connectTimer);
			window.clearTimeout(retryTimer);
			window.clearTimeout(refreshTimer);
			window.clearInterval(poll);
			socket?.close();
			window.removeEventListener('focus', onVisible);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, []);
	return live;
}

export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const field = document.createElement('textarea');
	field.value = text;
	field.style.position = 'fixed';
	field.style.opacity = '0';
	field.setAttribute('aria-hidden', 'true');
	document.body.append(field);
	field.select();
	try {
		if (!document.execCommand('copy')) throw new Error('Copy is unavailable in this browser. Select the text and copy it manually.');
	} finally {
		field.remove();
	}
}
