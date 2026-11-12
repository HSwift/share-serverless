import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ItemResult, LibraryPage } from '../../../shared/contracts';
import { createItem, request, upload } from './helpers';

async function list(query: Record<string, string>) {
	const response = await request(`/api/v1/items?${new URLSearchParams(query)}`);
	expect(response.status, await response.clone().text()).toBe(200);
	return response.json<LibraryPage>();
}
describe('Console library queries', () => {
	it('accepts the full 200-character search limit with ASCII case-insensitive matching', async () => {
		const query = `${crypto.randomUUID()}${'x'.repeat(164)}`;
		const item = await createItem(`Before ${query} after`);
		const result = await list({ q: query.toUpperCase() });
		expect(result.items.map((entry) => entry.id)).toEqual([item.id]);
		expect(result.total).toBe(1);
	});
	it('searches actual text literally, including SQL wildcards and backslashes', async () => {
		const prefix = crypto.randomUUID();
		const exact = await createItem(`${prefix} 100% a_b \\folder`);
		await createItem(`${prefix} 1000 aXb /folder`);
		for (const q of [`${prefix} 100%`, 'a_b \\folder']) {
			const result = await list({ q });
			expect(result.items.map((item) => item.id)).toContain(exact.id);
			expect(result.total).toBe(1);
		}
		expect((await list({ q: 'text/plain' })).items).toHaveLength(0);
	});
	it('searches attachment filenames and returns safe display metadata', async () => {
		const file = await upload(`diagram-${crypto.randomUUID()}.png`, 'bytes', 'image/png');
		const create = await request('/api/v1/items', {
			method: 'POST',
			json: { content: { representations: [{ mimeType: 'image/png', fileId: file.id }] } },
		});
		const { item } = await create.json<ItemResult>();
		const result = await list({ q: file.name, type: 'image' });
		expect(result.total).toBe(1);
		expect(result.items[0]).toMatchObject({
			id: item.id,
			kind: 'image',
			title: file.name,
			fileDetails: [{ id: file.id, name: file.name, available: true }],
		});
		expect(JSON.stringify(result)).not.toContain('r2_key');
		const detail = await (await request(`/api/v1/items/${item.id}`)).json<ItemResult>();
		expect(detail.files[0]).toMatchObject({ id: file.id, mimeType: 'image/png', available: true });
		expect((await list({ q: file.name, type: 'text' })).total).toBe(0);
		expect((await list({ q: file.name, type: 'files' })).total).toBe(1);
		await request(`/api/v1/files/${file.id}`, { method: 'DELETE' });
		expect((await (await request(`/api/v1/items/${item.id}`)).json<ItemResult>()).files[0].available).toBe(false);
	});
	it('paginates both sort orders consistently and counts the whole filtered result', async () => {
		const prefix = crypto.randomUUID();
		const ids: string[] = [];
		for (let index = 0; index < 3; index++) {
			const item = await createItem(`${prefix} entry ${index}`);
			ids.push(item.id);
			await env.DB.prepare('UPDATE items SET created_at = ? WHERE id = ?')
				.bind(`2026-01-0${index + 1}T00:00:00.000Z`, item.id)
				.run();
		}
		for (const sort of ['oldest', 'newest']) {
			const first = await list({ q: prefix, limit: '2', sort });
			const second = await list({ q: prefix, limit: '2', sort, cursor: first.nextCursor! });
			expect(first.total).toBe(3);
			expect(second.total).toBe(3);
			expect([...first.items, ...second.items].map((item) => item.id)).toEqual(sort === 'oldest' ? ids : [...ids].reverse());
			expect(second.nextCursor).toBeNull();
		}
		expect((await list({ q: prefix, since: '2026-01-02T00:00:00Z' })).total).toBe(2);
	});
	it('validates filter inputs and exposes authenticated upload limits', async () => {
		const queries: Record<string, string>[] = [{ type: 'unknown' }, { sort: 'unknown' }, { since: 'bad' }, { q: 'x'.repeat(201) }];
		for (const query of queries) expect((await request(`/api/v1/items?${new URLSearchParams(query)}`)).status).toBe(400);
		expect((await request('/api/v1/config', { token: null })).status).toBe(401);
		expect(await (await request('/api/v1/config')).json()).toMatchObject({
			maxUploadBytes: 104857600,
			maxFiles: 20,
			maxInlineBytes: 65536,
		});
	});
});
