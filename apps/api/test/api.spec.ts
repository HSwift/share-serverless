import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createShare, request, upload, write, type StateResult, type UploadedFile } from './helpers';
import type { ClipboardState } from '../src/types';
import { cleanupFiles } from '../src/files';

const channel = () => `test-${crypto.randomUUID()}`;

describe('authentication and device identity', () => {
	it('exposes health but requires credentials for private API and WebSocket endpoints', async () => {
		expect((await request('/api/health', { token: null })).status).toBe(200);
		for (const path of [
			'/api/v1/items',
			'/api/v1/files',
			'/api/v1/devices',
			'/api/v1/shares',
			'/api/v1/clipboards/default',
			'/api/v1/clipboards/default/events',
		]) {
			expect((await request(path, { token: null })).status).toBe(401);
			expect((await request(path, { token: 'wrong-token' })).status).toBe(401);
		}
	});
	it('never trusts an unsigned Access assertion or a caller-supplied internal identity', async () => {
		expect(
			(
				await request('/api/v1/me', {
					token: null,
					headers: { 'cf-access-jwt-assertion': 'fake', 'x-internal-principal': '{"id":"admin"}' },
				})
			).status,
		).toBe(401);
	});
	it('registers individual device tokens, records provenance, and revokes them', async () => {
		const response = await request('/api/v1/devices', {
			method: 'POST',
			json: { name: 'iPhone', platform: 'ios', capabilities: ['clipboard.read', 'clipboard.write'] },
		});
		expect(response.status).toBe(201);
		const { device, token } = await response.json<{ device: { id: string }; token: string }>();
		expect(token).toMatch(/^dev_/);
		expect((await request('/api/v1/devices', { token })).status).toBe(403);
		expect((await request('/api/v1/devices', { token, method: 'POST', json: { name: 'unauthorized', platform: 'linux' } })).status).toBe(
			403,
		);
		const item = await createItem('from iOS', token);
		const result = await (await write(channel(), item.id, 0, crypto.randomUUID(), token)).json<StateResult>();
		expect(result.state.sourceDeviceId).toBe(device.id);
		const stored = await env.DB.prepare('SELECT token_hash FROM devices WHERE id = ?').bind(device.id).first<{ token_hash: string }>();
		expect(stored!.token_hash).not.toBe(token);
		const listed = await request('/api/v1/devices');
		expect(await listed.text()).not.toContain(token);
		expect((await request(`/api/v1/devices/${device.id}`, { method: 'DELETE' })).status).toBe(204);
		expect((await request('/api/v1/me', { token })).status).toBe(401);
	});
});

describe('immutable items and clipboard registers', () => {
	it('uses a stable content ID and never provides an update operation on an item', async () => {
		const a = await createItem('immutable text');
		const b = await createItem('immutable text');
		expect(a.id).toBe(b.id);
		expect((await request(`/api/v1/items/${a.id}`, { method: 'PATCH', json: { text: 'changed' } })).status).toBe(404);
		expect(await (await request(`/api/v1/items/${a.id}/content`)).text()).toBe('immutable text');
	});
	it('supports multiple fixed MIME representations and preserves an explicitly empty string', async () => {
		const reps = [
			{ mimeType: 'text/html', text: '<b>hello</b>' },
			{ mimeType: 'text/plain', text: '' },
		];
		const create = async (representations: unknown[]) =>
			(await (await request('/api/v1/items', { method: 'POST', json: { content: { representations } } })).json<{ item: { id: string } }>())
				.item;
		const a = await create(reps);
		const b = await create([...reps].reverse());
		expect(a.id).toBe(b.id);
		expect(await (await request(`/api/v1/items/${a.id}/content`)).text()).toBe('');
		const html = await request(`/api/v1/items/${a.id}/content?mimeType=text/html`);
		expect(await html.text()).toBe('<b>hello</b>');
		expect(html.headers.get('Content-Disposition')).toContain('attachment');
		expect((await request(`/api/v1/items/${a.id}/content?mimeType=image/png`)).status).toBe(406);
	});
	it('rejects ambiguous MIME alternatives, missing files and excessive inline data', async () => {
		const payloads = [
			{ text: 'hello', representations: [{ mimeType: 'text/plain', text: 'other' }] },
			{ representations: [{ mimeType: 'text/plain', text: 'hello', fileId: crypto.randomUUID() }] },
			{},
		];
		for (const content of payloads) expect((await request('/api/v1/items', { method: 'POST', json: { content } })).status).toBe(400);
		expect((await request('/api/v1/items', { method: 'POST', json: { content: { files: [crypto.randomUUID()] } } })).status).toBe(410);
		expect((await request('/api/v1/items', { method: 'POST', json: { content: { text: 'x'.repeat(65537) } } })).status).toBe(413);
	});
	it('advances the head without modifying old items and supports on-demand conditional reads', async () => {
		const name = channel();
		const empty = await request(`/api/v1/clipboards/${name}`);
		expect((await empty.json<StateResult>()).state.revision).toBe(0);
		expect((await request(`/api/v1/clipboards/${name}/text`)).status).toBe(204);
		const a = await createItem('old text');
		const b = await createItem('new text');
		expect((await (await write(name, a.id, 0)).json<StateResult>()).state.revision).toBe(1);
		const unchanged = await request(`/api/v1/clipboards/${name}`, { headers: { 'If-None-Match': '"1"' } });
		expect(unchanged.status).toBe(304);
		expect((await write(name, b.id, 1)).status).toBe(200);
		expect(await (await request(`/api/v1/items/${a.id}/content`)).text()).toBe('old text');
		const text = await request(`/api/v1/clipboards/${name}/text`);
		expect(await text.text()).toBe('new text');
		expect(text.headers.get('X-Clipboard-Item-Id')).toBe(b.id);
		expect(text.headers.get('ETag')).toBe('"2"');
	});
	it('serializes concurrent compare-and-set writes and returns the winning revision on conflict', async () => {
		const name = channel();
		const [a, b] = await Promise.all([createItem('concurrent A'), createItem('concurrent B')]);
		const responses = await Promise.all([write(name, a.id, 0), write(name, b.id, 0)]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
		const loser = await responses.find((r) => r.status === 409)!.json<{ error: { code: string; details: { current: ClipboardState } } }>();
		expect(loser.error.code).toBe('REVISION_CONFLICT');
		expect(loser.error.details.current.revision).toBe(1);
	});
	it('makes retries idempotent even after later writes and rejects reusing a mutation ID', async () => {
		const name = channel();
		const a = await createItem('retry A');
		const b = await createItem('retry B');
		const mutationId = crypto.randomUUID();
		expect((await write(name, a.id, 0, mutationId)).status).toBe(200);
		await write(name, b.id, 1);
		const replay = await (await write(name, a.id, 0, mutationId)).json<StateResult>();
		expect(replay.replayed).toBe(true);
		expect(replay.state.revision).toBe(1);
		expect((await write(name, b.id, 0, mutationId)).status).toBe(409);
		expect((await (await request(`/api/v1/clipboards/${name}`)).json<StateResult>()).state.itemId).toBe(b.id);
	});
	it('deduplicates the current item and represents clearing as a monotonic tombstone', async () => {
		const name = channel();
		const item = await createItem('clear me');
		await write(name, item.id, 0);
		const noop = await (await write(name, item.id, 1)).json<StateResult>();
		expect(noop.changed).toBe(false);
		expect(noop.state.revision).toBe(1);
		const clear = await (await write(name, null, 1)).json<StateResult>();
		expect(clear.state).toMatchObject({ itemId: null, revision: 2 });
		expect(await (await request(`/api/v1/items/${item.id}/content`)).text()).toBe('clear me');
	});
	it('lets limited devices upload and set the current item with one HTTP request', async () => {
		const name = channel();
		const json = { content: { text: 'one call from Shortcuts' }, mutationId: crypto.randomUUID() };
		const first = await request(`/api/v1/clipboards/${name}`, { method: 'POST', json });
		expect(first.status).toBe(200);
		const second = await request(`/api/v1/clipboards/${name}`, { method: 'POST', json });
		expect((await second.json<StateResult>()).replayed).toBe(true);
	});
	it('provides ordered changes, bounded history, and an explicit reset when a cursor expires', async () => {
		const name = channel();
		const [a, b] = await Promise.all([createItem('retention A'), createItem('retention B')]);
		const firstMutation = crypto.randomUUID();
		await write(name, a.id, 0, firstMutation);
		for (let i = 1; i <= 201; i++) {
			const result = await write(name, i % 2 ? b.id : a.id, i);
			expect(result.status).toBe(200);
		}
		const expired = await request(`/api/v1/clipboards/${name}/changes?after=0`);
		expect(expired.status).toBe(409);
		expect((await expired.json<{ error: { code: string } }>()).error.code).toBe('CURSOR_EXPIRED');
		const changes = await (await request(`/api/v1/clipboards/${name}/changes?after=200`)).json<{ changes: ClipboardState[] }>();
		expect(changes.changes.map((change) => change.revision)).toEqual([201, 202]);
		const history = await (
			await request(`/api/v1/clipboards/${name}/history?limit=2`)
		).json<{ history: ClipboardState[]; nextBefore: number }>();
		expect(history.history.map((state) => state.revision)).toEqual([202, 201]);
		expect(history.nextBefore).toBe(201);
		expect((await write(name, a.id, 0, firstMutation)).status).toBe(410);
		expect((await request(`/api/v1/clipboards/${name}/changes?after=203`)).status).toBe(409);
	});
});

describe('streaming file storage', () => {
	it('rejects a truncated unknown-length upload without publishing a file', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});
		const response = await request('/api/v1/files?name=truncated.bin&size=9', { method: 'POST', body: stream });
		expect(response.status, await response.clone().text()).toBe(400);
		const pending = await env.DB.prepare("SELECT id FROM files WHERE name = 'truncated.bin' AND status = 'ready'").first();
		expect(pending).toBeNull();
	});
	it('cleans abandoned uploads while keeping recent in-progress uploads', async () => {
		const staleId = crypto.randomUUID();
		const recentId = crypto.randomUUID();
		for (const [id, createdAt] of [
			[staleId, new Date(Date.now() - 2 * 86400000).toISOString()],
			[recentId, new Date().toISOString()],
		]) {
			await env.DB.prepare(
				"INSERT INTO files (id, name, content_type, size, r2_key, status, created_by, created_at) VALUES (?, 'pending.bin', 'application/octet-stream', 3, ?, 'pending', 'admin', ?)",
			)
				.bind(id, `files/${id}`, createdAt)
				.run();
			await env.FILES.put(`files/${id}`, 'abc');
		}
		await cleanupFiles(env);
		expect(await env.FILES.head(`files/${staleId}`)).toBeNull();
		expect(await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(staleId).first()).toBeNull();
		expect(await env.FILES.head(`files/${recentId}`)).not.toBeNull();
	});
	it('round-trips binary bytes and MIME metadata with byte-range downloads', async () => {
		const data = new Uint8Array([0, 255, 1, 2, 0, 128]);
		const response = await request('/api/v1/files?name=%E6%B5%8B%E8%AF%95.bin&size=6', {
			method: 'POST',
			body: data,
			headers: { 'Content-Type': 'application/octet-stream' },
		});
		expect(response.status, await response.clone().text()).toBe(201);
		const { file } = await response.json<{ file: UploadedFile }>();
		const download = await request(`/api/v1/files/${file.id}/content`);
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(data);
		expect(download.headers.get('Content-Disposition')).toContain("filename*=UTF-8''%E6%B5%8B%E8%AF%95.bin");
		const range = await request(`/api/v1/files/${file.id}/content`, { headers: { Range: 'bytes=1-3' } });
		expect(range.status).toBe(206);
		expect(range.headers.get('Content-Range')).toBe('bytes 1-3/6');
		expect(new Uint8Array(await range.arrayBuffer())).toEqual(data.slice(1, 4));
		const invalid = await request(`/api/v1/files/${file.id}/content`, { headers: { Range: 'bytes=7-' } });
		expect(invalid.status).toBe(416);
		expect(invalid.headers.get('Content-Range')).toBe('bytes */6');
	});
	it('supports empty files and enforces configured sizes before publishing the object', async () => {
		const file = await upload('empty.txt', '');
		expect(file.size).toBe(0);
		expect(await (await request(`/api/v1/files/${file.id}/content`)).text()).toBe('');
		expect((await request('/api/v1/files?name=big.bin&size=104857601', { method: 'POST', body: 'x' })).status).toBe(413);
		expect(
			(await request('/api/v1/files?name=bad.bin&size=4', { method: 'POST', body: 'abc', headers: { 'Content-Length': '3' } })).status,
		).toBe(400);
		expect((await request('/api/v1/files?name=../bad.bin&size=1', { method: 'POST', body: 'x' })).status).toBe(400);
	});
	it('keeps uploads immutable and prevents downloads after deletion', async () => {
		const file = await upload('page.html', '<script>test()</script>', 'text/html');
		const download = await request(`/api/v1/files/${file.id}/content`);
		expect(download.headers.get('Content-Disposition')).toContain('attachment');
		expect(download.headers.get('Content-Security-Policy')).toContain('sandbox');
		expect((await request(`/api/v1/files/${file.id}/content`, { method: 'PUT', body: 'overwrite' })).status).toBe(404);
		expect((await request(`/api/v1/files/${file.id}`, { method: 'DELETE' })).status).toBe(204);
		expect((await request(`/api/v1/files/${file.id}/content`)).status).toBe(404);
	});
	it('paginates files without repeating the boundary item', async () => {
		await Promise.all([upload('page-a.txt'), upload('page-b.txt')]);
		const page = await (await request('/api/v1/files?limit=1')).json<{ files: UploadedFile[]; nextCursor: string }>();
		expect(page.files).toHaveLength(1);
		const next = await (
			await request(`/api/v1/files?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)
		).json<{ files: UploadedFile[] }>();
		expect(next.files[0].id).not.toBe(page.files[0].id);
		expect((await request('/api/v1/files?limit=999')).status).toBe(400);
		expect((await request('/api/v1/files?cursor=bad')).status).toBe(400);
	});
});

describe('share capabilities', () => {
	it('shares a fixed item, never the mutable latest pointer', async () => {
		const name = channel();
		const a = await createItem('share snapshot A');
		const b = await createItem('share snapshot B');
		await write(name, a.id, 0);
		const share = await createShare({ clipboard: { channel: name } });
		await write(name, b.id, 1);
		const path = new URL(share.url).pathname;
		expect(await (await request(`${path}/text`, { token: null })).text()).toBe('share snapshot A');
		const shared = await (await request(path, { token: null })).json<{ share: { item: { id: string } } }>();
		expect(shared.share.item.id).toBe(a.id);
		expect((await request(`/api/v1/items/${a.id}`, { token: null })).status).toBe(401);
	});
	it('restricts public file downloads to the exact files in that share', async () => {
		const a = await upload('included.txt', 'included');
		const b = await upload('private.txt', 'private');
		const share = await createShare({ content: { files: [a.id] } });
		const path = new URL(share.url).pathname;
		expect(await (await request(`${path}/files/${a.id}`, { token: null })).text()).toBe('included');
		expect((await request(`${path}/files/${b.id}`, { token: null })).status).toBe(404);
		const token = path.split('/').at(-1)!;
		const altered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
		expect((await request(`/s/${altered}`, { token: null })).status).toBe(404);
	});
	it('rejects expired and revoked shares and can reproduce links for the console', async () => {
		const share = await createShare({ content: { text: 'revocable' }, expiresIn: 60 });
		const path = new URL(share.url).pathname;
		const listed = await (await request('/api/v1/shares')).json<{ shares: { id: string; url: string }[] }>();
		expect(listed.shares.find((row) => row.id === share.id)!.url).toBe(share.url);
		await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE id = ?')
			.bind(new Date(Date.now() - 1000).toISOString(), share.id)
			.run();
		expect((await request(path, { token: null })).status).toBe(410);
		const other = await createShare({ content: { text: 'revoke me' }, expiresIn: null });
		expect((await request(`/api/v1/shares/${other.id}`, { method: 'DELETE' })).status).toBe(204);
		expect((await request(new URL(other.url).pathname, { token: null })).status).toBe(410);
	});
});
