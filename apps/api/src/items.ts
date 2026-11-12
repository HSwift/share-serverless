import { Hono } from 'hono';
import type { AppContext, AppEnv, Content, FileRow, ItemRow } from './types';
import type { FileDescriptor, ItemSummary } from '../../../shared/contracts';
import { AppError, readJson } from './http';
import { contentFileIds, contentFiles, parseContent } from './content';
import { sha256 } from './crypto';
import { downloadFile, findFile } from './files';
import { pageQuery, pageResult } from './pagination';

export function itemId(value: unknown): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
		throw new AppError(400, 'INVALID_ITEM_ID', 'Expected a SHA-256 content ID');
	return value;
}

export async function findItem(db: D1Database, id: string): Promise<ItemRow> {
	const row = await db.prepare('SELECT * FROM items WHERE id = ?').bind(itemId(id)).first<ItemRow>();
	if (!row) throw new AppError(404, 'ITEM_NOT_FOUND', 'Item not found');
	return row;
}

export function publicItem(row: ItemRow) {
	return { id: row.id, content: JSON.parse(row.content_json) as Content, createdAt: row.created_at };
}

export async function describeFiles(db: D1Database, contents: Content[]): Promise<Map<string, FileDescriptor>> {
	const ids = [...new Set(contents.flatMap(contentFileIds))];
	const files = new Map<string, FileDescriptor>(
		ids.map((id) => [id, { id, name: 'Unavailable file', mimeType: 'application/octet-stream', size: null, available: false }]),
	);
	for (let offset = 0; offset < ids.length; offset += 80) {
		const chunk = ids.slice(offset, offset + 80);
		const result = await db
			.prepare(`SELECT * FROM files WHERE id IN (${chunk.map(() => '?').join(',')})`)
			.bind(...chunk)
			.all<FileRow>();
		for (const file of result.results)
			files.set(file.id, {
				id: file.id,
				name: file.name,
				mimeType: file.content_type,
				size: file.size,
				available: file.status === 'ready',
			});
	}
	return files;
}

function summarize(row: ItemRow, files: Map<string, FileDescriptor>): ItemSummary {
	const item = publicItem(row);
	const reps = item.content.representations;
	const text = (reps.find((rep) => rep.mimeType === 'text/plain' && rep.text !== undefined) ?? reps.find((rep) => rep.text !== undefined))
		?.text;
	const details = contentFileIds(item.content).map((id) => files.get(id)!);
	const firstLine = text
		?.trim()
		.split(/\r?\n/)
		.find((line) => line.trim())
		?.replace(/^(?:#{1,6}|\/\/|--|\*)\s+/, '')
		.trim();
	const title =
		firstLine ||
		(text !== undefined
			? 'Empty text'
			: details.length > 1
				? `${details[0].name} + ${details.length - 1}`
				: (details[0]?.name ?? 'Clipboard item'));
	return {
		id: item.id,
		createdAt: item.createdAt,
		files: item.content.files,
		fileDetails: details,
		mimeTypes: reps.map((rep) => rep.mimeType),
		title: title.slice(0, 140),
		preview: text !== undefined ? text.replace(/\s+/g, ' ').slice(0, 240) : details.map((file) => file.name).join(', '),
		kind:
			text !== undefined
				? 'text'
				: reps.some((rep) => rep.mimeType.startsWith('image/')) ||
					  (details.length > 0 && details.every((file) => file.mimeType.startsWith('image/')))
					? 'image'
					: 'files',
		size: text !== undefined ? new TextEncoder().encode(text).byteLength : details.reduce((size, file) => size + (file.size ?? 0), 0),
	};
}

export async function createItem(db: D1Database, content: Content, actorId: string): Promise<ItemRow> {
	await contentFiles(db, content);
	const json = JSON.stringify(content);
	const id = await sha256(json);
	// Content-addressed, immutable records. Retrying the same upload returns the same ID.
	await db
		.prepare('INSERT OR IGNORE INTO items (id, content_json, created_by, created_at) VALUES (?, ?, ?, ?)')
		.bind(id, json, actorId, new Date().toISOString())
		.run();
	return findItem(db, id);
}

export async function itemContent(c: AppContext, row: ItemRow, mime = 'text/plain'): Promise<Response> {
	const content = JSON.parse(row.content_json) as Content;
	const representation = content.representations.find((rep) => rep.mimeType === mime);
	if (!representation) throw new AppError(406, 'FORMAT_UNAVAILABLE', 'The item has no representation for this MIME type');
	if (representation.fileId) {
		const response = await downloadFile(c, await findFile(c.env.DB, representation.fileId));
		response.headers.set('X-Clipboard-Item-Id', row.id);
		return response;
	}
	const headers = new Headers({
		'Content-Type': `${representation.mimeType}; charset=utf-8`,
		'X-Clipboard-Item-Id': row.id,
		'Cache-Control': 'private, no-store',
		'Content-Security-Policy': "default-src 'none'; sandbox",
	});
	if (mime !== 'text/plain') headers.set('Content-Disposition', 'attachment; filename="clipboard-content"');
	return new Response(representation.text, { headers });
}

export const items = new Hono<AppEnv>();
items.post('/', async (c) => {
	const input = await readJson(c.req.raw);
	const item = await createItem(c.env.DB, parseContent(input.content), c.get('principal').id);
	return c.json({ item: publicItem(item) }, 201);
});
items.get('/', async (c) => {
	const url = new URL(c.req.url);
	const type = url.searchParams.get('type') ?? 'all';
	const sort = url.searchParams.get('sort') ?? 'newest';
	if (!['all', 'text', 'image', 'files'].includes(type) || !['newest', 'oldest'].includes(sort))
		throw new AppError(400, 'INVALID_FILTER', 'Unknown type or sort order');
	const order = sort === 'oldest' ? 'asc' : 'desc';
	const page = pageQuery(url, order);
	const clauses: string[] = [];
	const params: string[] = [];
	const refs = `(SELECT value FROM json_each(items.content_json, '$.files') UNION SELECT json_extract(value, '$.fileId') FROM json_each(items.content_json, '$.representations') WHERE json_type(value, '$.fileId') = 'text')`;
	const query = (url.searchParams.get('q') ?? '').trim();
	if (query.length > 200) throw new AppError(400, 'INVALID_FILTER', 'Search is limited to 200 characters');
	if (query) {
		clauses.push(
			`(EXISTS (SELECT 1 FROM json_each(items.content_json, '$.representations') WHERE instr(lower(json_extract(value, '$.text')), lower(?)) > 0) OR EXISTS (SELECT 1 FROM files WHERE files.id IN ${refs} AND instr(lower(files.name), lower(?)) > 0))`,
		);
		params.push(query, query);
	}
	if (type === 'text')
		clauses.push(`EXISTS (SELECT 1 FROM json_each(items.content_json, '$.representations') WHERE json_type(value, '$.text') = 'text')`);
	if (type === 'image')
		clauses.push(
			`(EXISTS (SELECT 1 FROM json_each(items.content_json, '$.representations') WHERE json_extract(value, '$.mimeType') LIKE 'image/%') OR EXISTS (SELECT 1 FROM files WHERE files.id IN ${refs} AND files.content_type LIKE 'image/%'))`,
		);
	if (type === 'files')
		clauses.push(
			`(json_array_length(content_json, '$.files') > 0 OR EXISTS (SELECT 1 FROM json_each(items.content_json, '$.representations') WHERE json_type(value, '$.fileId') = 'text'))`,
		);
	const since = url.searchParams.get('since');
	if (since) {
		const timestamp = Date.parse(since);
		if (!Number.isFinite(timestamp)) throw new AppError(400, 'INVALID_FILTER', 'since must be an ISO date');
		clauses.push('created_at >= ?');
		params.push(new Date(timestamp).toISOString());
	}
	const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
	const [result, count] = await Promise.all([
		c.env.DB.prepare(`SELECT * FROM items WHERE 1 = 1 ${where} ${page.where} ORDER BY created_at ${order}, id ${order} LIMIT ?`)
			.bind(...params, ...page.bind, page.limit + 1)
			.all<ItemRow>(),
		c.env.DB.prepare(`SELECT COUNT(*) AS count FROM items WHERE 1 = 1 ${where}`)
			.bind(...params)
			.first<{ count: number }>(),
	]);
	const files = await describeFiles(
		c.env.DB,
		result.results.map((row) => publicItem(row).content),
	);
	return c.json({ ...pageResult('items', result.results, page.limit, (row) => summarize(row, files)), total: count?.count ?? 0 });
});
items.get('/:id', async (c) => {
	const item = publicItem(await findItem(c.env.DB, c.req.param('id')));
	return c.json({ item, files: [...(await describeFiles(c.env.DB, [item.content])).values()] });
});
items.get('/:id/content', async (c) => itemContent(c, await findItem(c.env.DB, c.req.param('id')), c.req.query('mimeType')));
