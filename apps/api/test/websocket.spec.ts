import { afterEach, describe, expect, it } from 'vitest';
import { env, evictDurableObject } from 'cloudflare:test';
import { createItem, request, write } from './helpers';

const sockets: WebSocket[] = [];
const channel = () => `ws-${crypto.randomUUID()}`;

async function subscribe(name: string, after?: number, token?: string) {
	const response = await request(`/api/v1/clipboards/${name}/events${after === undefined ? '' : `?after=${after}`}`, {
		headers: { Upgrade: 'websocket' },
		token,
	});
	expect(response.status, response.status === 101 ? '' : await response.text()).toBe(101);
	const socket = response.webSocket!;
	sockets.push(socket);
	const messages: unknown[] = [];
	const waiting: ((value: unknown) => void)[] = [];
	socket.addEventListener('message', (event) => {
		let data: unknown;
		try {
			data = JSON.parse(event.data as string);
		} catch {
			data = event.data;
		}
		const resolve = waiting.shift();
		if (resolve) resolve(data);
		else messages.push(data);
	});
	socket.accept();
	return {
		socket,
		next<T = Record<string, unknown>>(): Promise<T> {
			if (messages.length) return Promise.resolve(messages.shift() as T);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('WebSocket message timed out')), 3000);
				waiting.push((value) => {
					clearTimeout(timer);
					resolve(value as T);
				});
			});
		},
	};
}

afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close(1000, 'Test finished');
});

describe('optional WebSocket subscriptions', () => {
	it('recovers pointer state and subscriptions after the object hibernates', async () => {
		const name = channel();
		const item = await createItem('survives hibernation');
		await (await write(name, item.id, 0)).text();
		const connection = await subscribe(name, 1);
		expect(await connection.next()).toMatchObject({ type: 'sync.ready', revision: 1 });
		await evictDurableObject(env.CLIPBOARD.getByName('personal'));
		await (await write(name, null, 1)).text();
		expect(await connection.next()).toMatchObject({ type: 'clipboard.changed', revision: 2, itemId: null });
	});
	it('sends only pointer metadata, resumes from the last cursor, and supports hibernation ping/pong', async () => {
		const name = channel();
		const item = await createItem('private clipboard contents are fetched by immutable ID');
		await write(name, item.id, 0);
		const connection = await subscribe(name, 0);
		const event = await connection.next();
		expect(event).toMatchObject({ type: 'clipboard.changed', itemId: item.id, revision: 1 });
		expect(JSON.stringify(event)).not.toContain('private clipboard contents');
		expect(await connection.next()).toMatchObject({ type: 'sync.ready', revision: 1 });
		connection.socket.send('ping');
		expect(await connection.next()).toBe('pong');
		await write(name, null, 1);
		expect(await connection.next()).toMatchObject({ type: 'clipboard.changed', itemId: null, revision: 2 });
	});
	it('starts without a cursor by directing the client to fetch a current snapshot', async () => {
		const name = channel();
		const connection = await subscribe(name);
		expect(await connection.next()).toMatchObject({ type: 'sync.reset', state: { revision: 0, itemId: null } });
		expect(await connection.next()).toMatchObject({ type: 'sync.ready', revision: 0 });
	});
	it('closes an existing connection when its device token is revoked', async () => {
		const response = await request('/api/v1/devices', {
			method: 'POST',
			json: { name: 'desktop', platform: 'wayland', capabilities: ['sync.websocket'] },
		});
		const { device, token } = await response.json<{ device: { id: string }; token: string }>();
		const connection = await subscribe(channel(), 0, token);
		await connection.next();
		const closed = new Promise<CloseEvent>((resolve) => connection.socket.addEventListener('close', resolve, { once: true }));
		expect((await request(`/api/v1/devices/${device.id}`, { method: 'DELETE' })).status).toBe(204);
		expect((await closed).code).toBe(4003);
	});
	it('rejects unupgraded requests and cursors ahead of the server', async () => {
		const name = channel();
		expect((await request(`/api/v1/clipboards/${name}/events`)).status).toBe(426);
		expect((await request(`/api/v1/clipboards/${name}/events?after=1`, { headers: { Upgrade: 'websocket' } })).status).toBe(409);
	});
});
