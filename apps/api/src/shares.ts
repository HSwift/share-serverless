import { Hono } from 'hono';
import type { AppEnv, ShareRow } from './types';
import { contentFileIds, contentFiles, parseContent } from './content';
import { AppError, channelName, integer, object, readJson, uuid } from './http';
import { secureEqual, shareToken } from './crypto';
import { downloadFile, findFile, publicFile } from './files';
import { createItem, findItem, publicItem } from './items';
import { pageQuery, pageResult } from './pagination';

async function publicShare(row: ShareRow, env: Cloudflare.Env) {
	return {
		id: row.id,
		itemId: row.item_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
		url: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/s/${await shareToken(row.id, env.SHARE_SIGNING_KEY)}`,
	};
}

export const shares = new Hono<AppEnv>();
shares.post('/', async (c) => {
	const input = await readJson(c.req.raw);
	if ([input.itemId, input.clipboard, input.content].filter((value) => value !== undefined).length !== 1)
		throw new AppError(400, 'INVALID_SHARE', 'Provide exactly one of itemId, content or clipboard');
	let id: string;
	if (input.clipboard !== undefined) {
		const source = object(input.clipboard);
		const channel = channelName(typeof source.channel === 'string' ? source.channel : 'default');
		const revision = source.revision === undefined ? undefined : integer(source.revision, 'revision', 0);
		const state = await c.env.CLIPBOARD.getByName('personal').getSnapshot(channel, revision);
		if (!state?.itemId) throw new AppError(410, 'CLIPBOARD_UNAVAILABLE', 'Requested clipboard version is empty or no longer retained');
		id = state.itemId;
	} else if (input.content !== undefined) id = (await createItem(c.env.DB, parseContent(input.content), c.get('principal').id)).id;
	else id = (await findItem(c.env.DB, input.itemId as string)).id;
	const item = publicItem(await findItem(c.env.DB, id));
	await contentFiles(c.env.DB, item.content);
	const ttl = input.expiresIn === null ? null : integer(input.expiresIn ?? 604800, 'expiresIn', 60, 30 * 86400);
	const createdAt = new Date().toISOString();
	const row: ShareRow = {
		id: crypto.randomUUID(),
		item_id: id,
		created_by: c.get('principal').id,
		created_at: createdAt,
		expires_at: ttl === null ? null : new Date(Date.now() + ttl * 1000).toISOString(),
		revoked_at: null,
	};
	await c.env.DB.prepare('INSERT INTO shares (id, item_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
		.bind(row.id, row.item_id, row.created_by, row.created_at, row.expires_at)
		.run();
	return c.json({ share: await publicShare(row, c.env) }, 201);
});
shares.get('/', async (c) => {
	const page = pageQuery(new URL(c.req.url));
	const result = await c.env.DB.prepare(`SELECT * FROM shares WHERE 1 = 1 ${page.where} ORDER BY created_at DESC, id DESC LIMIT ?`)
		.bind(...page.bind, page.limit + 1)
		.all<ShareRow>();
	const paged = pageResult('shares', result.results, page.limit, (row) => row);
	return c.json({
		shares: await Promise.all((paged.shares as ShareRow[]).map((row) => publicShare(row, c.env))),
		nextCursor: paged.nextCursor,
	});
});
shares.delete('/:id', async (c) => {
	const result = await c.env.DB.prepare('UPDATE shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
		.bind(new Date().toISOString(), uuid(c.req.param('id')))
		.run();
	if (result.meta.changes === 0) throw new AppError(404, 'SHARE_NOT_FOUND', 'Share not found');
	return c.body(null, 204);
});

async function resolveShare(env: Cloudflare.Env, token: string) {
	if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(404, 'SHARE_NOT_FOUND', 'Share not found');
	const id = token.slice(0, 36);
	if (!(await secureEqual(token, await shareToken(id, env.SHARE_SIGNING_KEY))))
		throw new AppError(404, 'SHARE_NOT_FOUND', 'Share not found');
	const row = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>();
	if (!row) throw new AppError(404, 'SHARE_NOT_FOUND', 'Share not found');
	if (row.revoked_at || (row.expires_at && row.expires_at <= new Date().toISOString()))
		throw new AppError(410, 'SHARE_EXPIRED', 'Share has expired or was revoked');
	return { row, item: publicItem(await findItem(env.DB, row.item_id)) };
}

export const publicShares = new Hono<AppEnv>();
publicShares.get('/:token', async (c) => {
	const token = c.req.param('token');
	const { row, item } = await resolveShare(c.env, token);
	const files = await contentFiles(c.env.DB, item.content);
	return c.json({
		share: {
			id: row.id,
			item,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			files: files.map((file) => ({
				...publicFile(file),
				downloadUrl: `${c.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/s/${token}/files/${file.id}`,
			})),
		},
	});
});
publicShares.get('/:token/text', async (c) => {
	const { item } = await resolveShare(c.env, c.req.param('token'));
	const rep = item.content.representations.find((rep) => rep.mimeType === 'text/plain' && rep.text !== undefined);
	if (!rep || rep.text === undefined) throw new AppError(406, 'TEXT_UNAVAILABLE', 'Share has no inline text/plain representation');
	return c.text(rep.text);
});
publicShares.get('/:token/files/:id', async (c) => {
	const { item } = await resolveShare(c.env, c.req.param('token'));
	const id = uuid(c.req.param('id'));
	if (!contentFileIds(item.content).includes(id)) throw new AppError(404, 'FILE_NOT_FOUND', 'File is not included in this share');
	return downloadFile(c, await findFile(c.env.DB, id));
});
