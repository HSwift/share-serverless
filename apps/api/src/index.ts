import { Hono } from 'hono';
import type { AppEnv } from './types';
import { requireAuth } from './auth';
import { channelName, errorResponse, integer, readJson, string } from './http';
import { files, cleanupFiles } from './files';
import { devices } from './devices';
import { items, createItem, findItem, itemContent } from './items';
import { parseContent } from './content';
import { shares, publicShares } from './shares';
export { ClipboardHub } from './clipboard';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
	c.set('requestId', crypto.randomUUID());
	await next();
	if (c.res.status !== 101) {
		c.header('X-Request-Id', c.get('requestId'));
		c.header('X-Content-Type-Options', 'nosniff');
		c.header('Referrer-Policy', 'no-referrer');
		if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'private, no-store');
	}
});
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'share-serverless-api' }));
app.use('/api/v1/*', requireAuth);
app.get('/api/v1/me', (c) => c.json({ principal: c.get('principal') }));
app.get('/api/v1/config', (c) => c.json({ maxUploadBytes: Number(c.env.MAX_UPLOAD_BYTES), maxInlineBytes: 65536, maxFiles: 20 }));
app.route('/api/v1/files', files);
app.route('/api/v1/items', items);
app.route('/api/v1/devices', devices);
app.route('/api/v1/shares', shares);
app.route('/s', publicShares);

const clipboard = new Hono<AppEnv>();
clipboard.post('/:channel', async (c) => {
	const channel = channelName(c.req.param('channel'));
	const input = await readJson(c.req.raw);
	string(input.mutationId, 'mutationId', 128);
	if (input.baseRevision !== undefined) integer(input.baseRevision, 'baseRevision', 0);
	const item = await createItem(c.env.DB, parseContent(input.content), c.get('principal').id);
	return c.env.CLIPBOARD.getByName('personal').fetch(
		new Request(`https://clipboard.internal/channels/${channel}`, {
			method: 'PUT',
			headers: { 'x-internal-principal': JSON.stringify(c.get('principal')) },
			body: JSON.stringify({ itemId: item.id, mutationId: input.mutationId, baseRevision: input.baseRevision }),
		}),
	);
});
clipboard.get('/:channel/text', async (c) => {
	const channel = channelName(c.req.param('channel'));
	const state = (await c.env.CLIPBOARD.getByName('personal').getSnapshot(channel))!;
	const headers = new Headers({
		ETag: `"${state.revision}"`,
		'X-Clipboard-Revision': String(state.revision),
		'Cache-Control': 'private, no-cache',
	});
	if (c.req.header('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
	if (!state.itemId) return new Response(null, { status: 204, headers });
	const response = await itemContent(c, await findItem(c.env.DB, state.itemId));
	for (const [key, value] of headers) response.headers.set(key, value);
	return response;
});
clipboard.all('/:channel/:action?', async (c) => {
	const channel = channelName(c.req.param('channel'));
	const url = new URL(c.req.url);
	url.pathname = `/channels/${channel}${c.req.param('action') ? `/${c.req.param('action')}` : ''}`;
	const headers = new Headers(c.req.raw.headers);
	headers.set('x-internal-principal', JSON.stringify(c.get('principal')));
	return c.env.CLIPBOARD.getByName('personal').fetch(
		new Request(url, { method: c.req.method, headers, body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body }),
	);
});
app.route('/api/v1/clipboards', clipboard);
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
app.onError((error, c) => errorResponse(error, c.get('requestId')));

export default {
	fetch: app.fetch,
	async scheduled(_controller, env) {
		await cleanupFiles(env);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
