import { Hono } from 'hono';
import type { AppContext, AppEnv, FileRow } from './types';
import { AppError, integer, string, uuid } from './http';
import { mimeType } from './content';
import { pageQuery, pageResult } from './pagination';

export function publicFile(row: FileRow) {
	return { id: row.id, name: row.name, mimeType: row.content_type, size: row.size, etag: row.etag, createdAt: row.created_at };
}

export async function findFile(db: D1Database, id: string): Promise<FileRow> {
	const row = await db.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").bind(uuid(id)).first<FileRow>();
	if (!row) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found');
	return row;
}

function disposition(name: string): string {
	const ascii = name.replace(/[^a-zA-Z0-9._ -]/g, '_');
	const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function byteRange(header: string | null, size: number): { offset: number; length: number } | undefined {
	if (!header) return;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	const fail = () => {
		throw new AppError(416, 'INVALID_RANGE', 'Requested byte range is not satisfiable', { size });
	};
	if (!match || (!match[1] && !match[2]) || size === 0) return fail();
	let start: number;
	let end: number;
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix < 1) return fail();
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] ? Number(match[2]) : size - 1;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return fail();
		end = Math.min(end, size - 1);
	}
	return { offset: start, length: end - start + 1 };
}

export async function downloadFile(c: AppContext, file: FileRow): Promise<Response> {
	let range: ReturnType<typeof byteRange>;
	try {
		range = byteRange(c.req.header('Range') ?? null, file.size);
	} catch (error) {
		if (error instanceof AppError && error.status === 416) {
			return Response.json(
				{ error: { code: error.code, message: error.message } },
				{ status: 416, headers: { 'Content-Range': `bytes */${file.size}` } },
			);
		}
		throw error;
	}
	const object = await c.env.FILES.get(file.r2_key, range ? { range } : undefined);
	if (!object) throw new AppError(410, 'FILE_UNAVAILABLE', 'File data is unavailable');
	const headers = new Headers({
		'Content-Type': file.content_type,
		'Content-Disposition': disposition(file.name),
		'Content-Length': String(range?.length ?? file.size),
		'Accept-Ranges': 'bytes',
		ETag: object.httpEtag,
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': "default-src 'none'; sandbox",
	});
	if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
	return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function uploadFile(c: AppContext): Promise<FileRow> {
	const name = string(c.req.query('name'), 'name', 255);
	if (/[\\/]/.test(name) || name === '.' || name === '..')
		throw new AppError(400, 'INVALID_NAME', 'File name must not contain path separators');
	const contentType = mimeType((c.req.header('Content-Type') ?? 'application/octet-stream').split(';')[0].trim());
	const sizeValue = c.req.query('size') ?? c.req.header('Content-Length');
	if (sizeValue === undefined) throw new AppError(411, 'SIZE_REQUIRED', 'Provide Content-Length or the size query parameter');
	if (!/^\d+$/.test(sizeValue)) throw new AppError(400, 'INVALID_SIZE', 'size must be a nonnegative integer');
	const configuredLimit = Number(c.env.MAX_UPLOAD_BYTES);
	if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) throw new Error('Invalid MAX_UPLOAD_BYTES');
	const size = integer(Number(sizeValue), 'size', 0);
	if (size > configuredLimit) throw new AppError(413, 'FILE_TOO_LARGE', `Upload limit is ${configuredLimit} bytes`);
	const contentLength = c.req.header('Content-Length');
	if (contentLength !== undefined && Number(contentLength) !== size)
		throw new AppError(400, 'SIZE_MISMATCH', 'Content-Length and size must match');
	if (!c.req.raw.body && size > 0) throw new AppError(400, 'SIZE_MISMATCH', 'Upload body is missing');
	const id = crypto.randomUUID();
	const key = `files/${id}`;
	const createdAt = new Date().toISOString();
	await c.env.DB.prepare(
		"INSERT INTO files (id, name, content_type, size, r2_key, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
	)
		.bind(id, name, contentType, size, key, c.get('principal').id, createdAt)
		.run();
	let bodyError: AppError | undefined;
	try {
		const options: R2PutOptions = { httpMetadata: { contentType }, customMetadata: { fileId: id } };
		let stored: R2Object;
		if (c.req.raw.body) {
			// FixedLengthStream enforces the declared size without buffering the file in Worker memory.
			const fixed = new FixedLengthStream(size);
			const abort = new AbortController();
			let received = 0;
			const sizeError = () => {
				bodyError = new AppError(400, 'UPLOAD_INCOMPLETE', 'Upload body length does not match the declared size');
				return bodyError;
			};
			const counted = c.req.raw.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						received += chunk.byteLength;
						if (received > size) throw sizeError();
						controller.enqueue(chunk);
					},
					flush() {
						if (received !== size) throw sizeError();
					},
				}),
			);
			const pipe = counted.pipeTo(fixed.writable, { signal: abort.signal });
			const upload = c.env.FILES.put(key, fixed.readable, options).catch((error) => {
				abort.abort(error);
				throw error;
			});
			// Drain both promises before cleanup; an early R2 rejection must not race the body-size check.
			const [uploaded, piped] = await Promise.allSettled([upload, pipe]);
			if (bodyError) throw bodyError;
			if (uploaded.status === 'rejected') throw uploaded.reason;
			if (piped.status === 'rejected') throw new AppError(400, 'UPLOAD_INCOMPLETE', 'Upload body was interrupted');
			stored = uploaded.value;
		} else stored = await c.env.FILES.put(key, new Uint8Array(), options);
		await c.env.DB.prepare("UPDATE files SET status = 'ready', etag = ? WHERE id = ? AND status = 'pending'").bind(stored.etag, id).run();
		return await findFile(c.env.DB, id);
	} catch (error) {
		// Keep the row until scheduled cleanup, so a process crash never creates an untracked object.
		await c.env.DB.prepare("UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), id)
			.run()
			.catch(() => {});
		await c.env.FILES.delete(key).catch(() => {});
		throw bodyError ?? error;
	}
}

export const files = new Hono<AppEnv>();

files.post('/', async (c) => c.json({ file: publicFile(await uploadFile(c)) }, 201));

files.get('/', async (c) => {
	const page = pageQuery(new URL(c.req.url));
	const result = await c.env.DB.prepare(
		`SELECT * FROM files WHERE status = 'ready' ${page.where} ORDER BY created_at DESC, id DESC LIMIT ?`,
	)
		.bind(...page.bind, page.limit + 1)
		.all<FileRow>();
	return c.json(pageResult('files', result.results, page.limit, publicFile));
});
files.get('/:id', async (c) => c.json({ file: publicFile(await findFile(c.env.DB, c.req.param('id'))) }));
files.get('/:id/content', async (c) => downloadFile(c, await findFile(c.env.DB, c.req.param('id'))));
files.delete('/:id', async (c) => {
	const file = await findFile(c.env.DB, c.req.param('id'));
	await c.env.DB.prepare("UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), file.id).run();
	// Mark inaccessible first; scheduled cleanup retries R2 deletion if this request is interrupted.
	await c.env.FILES.delete(file.r2_key);
	return c.body(null, 204);
});

export async function cleanupFiles(env: Cloudflare.Env): Promise<void> {
	const stale = new Date(Date.now() - 86400000).toISOString();
	const rows = await env.DB.prepare(
		"SELECT * FROM files WHERE status = 'deleted' OR (status = 'pending' AND created_at < ?) ORDER BY created_at LIMIT 100",
	)
		.bind(stale)
		.all<FileRow>();
	for (const file of rows.results) {
		await env.FILES.delete(file.r2_key);
		await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(file.id).run();
	}
}
