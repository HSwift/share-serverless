export class AppError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public details?: unknown,
	) {
		super(message);
	}
}

export function errorResponse(error: unknown, requestId?: string): Response {
	if (error instanceof AppError) {
		return Response.json(
			{ error: { code: error.code, message: error.message, details: error.details }, requestId },
			{ status: error.status },
		);
	}
	console.error(JSON.stringify({ event: 'request_failed', requestId, message: error instanceof Error ? error.message : 'Unknown error' }));
	return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }, requestId }, { status: 500 });
}

export async function readText(request: Request, limit = 98304): Promise<string> {
	if (!request.body) return '';
	const reader = request.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	let size = 0;
	let text = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new AppError(413, 'BODY_TOO_LARGE', `Request body exceeds ${limit} bytes`);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError(400, 'INVALID_BODY', 'Request body must contain valid UTF-8');
	} finally {
		reader.releaseLock();
	}
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	const text = await readText(request);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new AppError(400, 'INVALID_JSON', 'Expected a JSON object');
	}
	return object(value);
}

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_INPUT', 'Expected an object');
	return value as Record<string, unknown>;
}

export function string(value: unknown, name: string, max = 128): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
		throw new AppError(400, 'INVALID_INPUT', `${name} must be a nonempty string of at most ${max} characters without control characters`);
	}
	return value;
}

export function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new AppError(400, 'INVALID_INPUT', `${name} must be an integer between ${min} and ${max}`);
	}
	return value as number;
}

export function queryInteger(value: string | null, name: string, fallback: number, min: number, max: number): number {
	if (value === null) return fallback;
	if (!/^\d+$/.test(value)) throw new AppError(400, 'INVALID_INPUT', `${name} must be an integer`);
	return integer(Number(value), name, min, max);
}

export function uuid(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new AppError(400, 'INVALID_INPUT', 'Expected a UUID v4');
	}
	return value.toLowerCase();
}

export function channelName(value: string): string {
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new AppError(400, 'INVALID_CHANNEL', 'Channel must match [a-z0-9][a-z0-9_-]{0,63}');
	return value;
}
