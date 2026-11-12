import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import type { ClipboardState, Content } from '../src/types';

export const ADMIN = 'test-admin-token';
export function request(
	path: string,
	options: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; token?: string | null } = {},
) {
	const headers = new Headers(options.headers);
	if (options.token !== null) headers.set('Authorization', `Bearer ${options.token ?? ADMIN}`);
	if (options.json !== undefined) headers.set('Content-Type', 'application/json');
	return SELF.fetch(`https://api.example${path}`, {
		method: options.method ?? 'GET',
		headers,
		body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
	});
}

export async function createItem(text: string, token = ADMIN) {
	const response = await request('/api/v1/items', { method: 'POST', json: { content: { text } }, token });
	expect(response.status, await response.clone().text()).toBe(201);
	return (await response.json<{ item: { id: string; content: Content } }>()).item;
}
export async function write(
	channel: string,
	itemId: string | null,
	baseRevision?: number,
	mutationId = crypto.randomUUID(),
	token = ADMIN,
) {
	return request(`/api/v1/clipboards/${channel}`, { method: 'PUT', token, json: { itemId, baseRevision, mutationId } });
}
export interface StateResult {
	state: ClipboardState;
	changed: boolean;
	replayed: boolean;
}
export interface UploadedFile {
	id: string;
	name: string;
	mimeType: string;
	size: number;
}
export async function upload(name: string, data = 'hello', mimeType = 'text/plain'): Promise<UploadedFile> {
	const response = await request(`/api/v1/files?name=${encodeURIComponent(name)}&size=${new TextEncoder().encode(data).byteLength}`, {
		method: 'POST',
		body: data,
		headers: { 'Content-Type': mimeType },
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return (await response.json<{ file: UploadedFile }>()).file;
}
export async function createShare(payload: unknown): Promise<{ id: string; itemId: string; url: string }> {
	const response = await request('/api/v1/shares', { method: 'POST', json: payload });
	expect(response.status, await response.clone().text()).toBe(201);
	return (await response.json<{ share: { id: string; itemId: string; url: string } }>()).share;
}
