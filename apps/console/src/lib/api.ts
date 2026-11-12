import type { ClipboardState, Content, FileDescriptor, ItemResult, LibraryPage, Limits, Share } from '../../../../shared/contracts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api/v1${path}`, {
		...init,
		headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
	});
	if (!response.ok) {
		if (response.status === 401 || response.status === 403)
			throw new Error('Your session could not be verified. Refresh the page to continue.');
		const body = await response.json().catch(() => null);
		throw new Error(body?.error?.message ?? `Request failed (${response.status}). Please try again.`);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

export interface Filters {
	q: string;
	type: 'all' | 'text' | 'image' | 'files';
	sort: 'newest' | 'oldest';
	since: string;
}
export const fileUrl = (id: string) => `/api/v1/files/${encodeURIComponent(id)}/content`;

export const api = {
	items: (filters: Filters, signal?: AbortSignal, cursor?: string) => {
		const params = new URLSearchParams({ limit: '30', type: filters.type, sort: filters.sort });
		if (filters.q) params.set('q', filters.q);
		if (filters.since) params.set('since', filters.since);
		if (cursor) params.set('cursor', cursor);
		return request<LibraryPage>(`/items?${params}`, { signal });
	},
	item: (id: string, signal?: AbortSignal) => request<ItemResult>(`/items/${encodeURIComponent(id)}`, { signal }),
	config: () => request<Limits>('/config'),
	head: () => request<{ state: ClipboardState }>('/clipboards/default'),
	create: (content: Content | { text: string }, mutationId: string = crypto.randomUUID()) =>
		request<{ state: ClipboardState }>('/clipboards/default', {
			method: 'POST',
			body: JSON.stringify({ content, mutationId }),
		}),
	setCurrent: (itemId: string, baseRevision: number) =>
		request<{ state: ClipboardState }>('/clipboards/default', {
			method: 'PUT',
			body: JSON.stringify({ itemId, baseRevision, mutationId: crypto.randomUUID() }),
		}),
	share: (itemId: string, expiresIn: number | null) =>
		request<{ share: Share }>('/shares', { method: 'POST', body: JSON.stringify({ itemId, expiresIn }) }),
	revokeShare: (id: string) => request<void>(`/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
	upload: async (file: File, signal?: AbortSignal) => {
		const response = await fetch(`/api/v1/files?${new URLSearchParams({ name: file.name, size: String(file.size) })}`, {
			method: 'POST',
			headers: { 'Content-Type': file.type || 'application/octet-stream' },
			body: file,
			signal,
		});
		if (!response.ok) {
			const payload = await response.json().catch(() => null);
			throw new Error(payload?.error?.message ?? `Could not upload ${file.name}.`);
		}
		const { file: saved } = (await response.json()) as { file: Omit<FileDescriptor, 'available'> };
		return { ...saved, available: true };
	},
	deleteFile: (id: string) => request<void>(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export async function textFile(file: FileDescriptor, signal: AbortSignal, limit = 262144): Promise<string> {
	const response = await fetch(fileUrl(file.id), {
		signal,
		headers: { Range: `bytes=0-${Math.max(0, Math.min(file.size ?? limit, limit) - 1)}` },
	});
	if (!response.ok) throw new Error('This file is no longer available.');
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new Error('This file is too large to preview. Download it instead.');
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}
