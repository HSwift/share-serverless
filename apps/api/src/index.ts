import { Hono } from 'hono';
import type { AppContext, AppEnv } from './types';
import { requireApiTokenOrAccess, requireAuth } from './auth';
import { AppError, channelName, errorResponse, integer, readJson, readText, string } from './http';
import { files, cleanupFiles, uploadFile } from './files';
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
app.get('/api/v1/config/cli', requireApiTokenOrAccess, (c) => {
	c.header('Cache-Control', 'no-store');
	return c.json({ apiBaseUrl: new URL(c.env.PUBLIC_BASE_URL).origin, apiToken: c.env.API_BEARER_TOKEN });
});
app.route('/api/v1/files', files);
app.route('/api/v1/items', items);
app.route('/api/v1/devices', devices);
app.route('/api/v1/shares', shares);
app.route('/s', publicShares);

const clipboard = new Hono<AppEnv>();
async function setCurrentItem(c: AppContext, channel: string, itemId: string, mutationId: string, baseRevision?: number) {
	return c.env.CLIPBOARD.getByName('personal').fetch(
		new Request(`https://clipboard.internal/channels/${channel}`, {
			method: 'PUT',
			headers: { 'x-internal-principal': JSON.stringify(c.get('principal')) },
			body: JSON.stringify({ itemId, mutationId, baseRevision }),
		}),
	);
}
clipboard.post('/:channel/content', async (c) => {
	const channel = channelName(c.req.param('channel'));
	let content;
	if (c.req.query('name') !== undefined) {
		const file = await uploadFile(c);
		content = parseContent({ files: [file.id] });
	} else {
		if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/plain')
			throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send text/plain content or provide a file name with ?name=...');
		content = parseContent({ text: await readText(c.req.raw, 65536) });
	}
	const item = await createItem(c.env.DB, content, c.get('principal').id);
	return setCurrentItem(c, channel, item.id, crypto.randomUUID());
});
clipboard.post('/:channel', async (c) => {
	const channel = channelName(c.req.param('channel'));
	const input = await readJson(c.req.raw);
	const mutationId = string(input.mutationId, 'mutationId', 128);
	const baseRevision = input.baseRevision === undefined ? undefined : integer(input.baseRevision, 'baseRevision', 0);
	const item = await createItem(c.env.DB, parseContent(input.content), c.get('principal').id);
	return setCurrentItem(c, channel, item.id, mutationId, baseRevision);
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
