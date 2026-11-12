import type { Content, FileRow, Representation } from './types';
import { AppError, object, string, uuid } from './http';

export function mimeType(value: unknown): string {
	const mime = string(value, 'mimeType', 128).toLowerCase();
	if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime))
		throw new AppError(400, 'INVALID_INPUT', 'Expected a MIME type without parameters');
	return mime;
}

export function parseContent(value: unknown): Content {
	const input = object(value);
	const representations: Representation[] = [];
	if (input.text !== undefined) {
		if (typeof input.text !== 'string') throw new AppError(400, 'INVALID_CONTENT', 'text must be a string');
		representations.push({ mimeType: 'text/plain', text: input.text });
	}
	if (input.representations !== undefined) {
		if (!Array.isArray(input.representations) || input.representations.length > 16)
			throw new AppError(400, 'INVALID_CONTENT', 'At most 16 representations are allowed');
		for (const raw of input.representations) {
			const rep = object(raw);
			const mime = mimeType(rep.mimeType);
			if (typeof rep.text === 'string' && rep.fileId === undefined) representations.push({ mimeType: mime, text: rep.text });
			else if (rep.text === undefined && typeof rep.fileId === 'string') representations.push({ mimeType: mime, fileId: uuid(rep.fileId) });
			else throw new AppError(400, 'INVALID_CONTENT', 'Each representation must contain exactly one of text or fileId');
		}
	}
	if (representations.length > 16 || new Set(representations.map((r) => r.mimeType)).size !== representations.length) {
		throw new AppError(400, 'INVALID_CONTENT', 'Representations must have unique MIME types, at most 16');
	}
	if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 20)) {
		throw new AppError(400, 'INVALID_CONTENT', 'files must be an array of at most 20 file IDs');
	}
	const files = [...new Set(((input.files ?? []) as unknown[]).map(uuid))];
	if (representations.length === 0 && files.length === 0)
		throw new AppError(400, 'INVALID_CONTENT', 'Content must contain a representation or a file');
	// Sort MIME alternatives so clients using different orderings get the same hash.
	representations.sort((a, b) => (a.mimeType < b.mimeType ? -1 : a.mimeType > b.mimeType ? 1 : 0));
	const content = { representations, files };
	if (new TextEncoder().encode(JSON.stringify(content)).byteLength > 65536)
		throw new AppError(413, 'CONTENT_TOO_LARGE', 'Inline clipboard content is limited to 64 KiB; upload larger content as a file');
	return content;
}

export function contentFileIds(content: Content): string[] {
	return [...new Set([...content.files, ...content.representations.flatMap((r) => (r.fileId ? [r.fileId] : []))])];
}

export async function contentFiles(db: D1Database, content: Content): Promise<FileRow[]> {
	const ids = contentFileIds(content);
	if (ids.length === 0) return [];
	const result = await db
		.prepare(`SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'ready'`)
		.bind(...ids)
		.all<FileRow>();
	if (result.results.length !== ids.length) throw new AppError(410, 'FILE_UNAVAILABLE', 'One or more referenced files are unavailable');
	return ids.map((id) => result.results.find((file) => file.id === id)!);
}
