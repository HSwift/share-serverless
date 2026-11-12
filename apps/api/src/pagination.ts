import { AppError, queryInteger } from './http';

export function pageQuery(url: URL, order: 'desc' | 'asc' = 'desc') {
	const limit = queryInteger(url.searchParams.get('limit'), 'limit', 50, 1, 100);
	const cursor = url.searchParams.get('cursor');
	if (!cursor) return { limit, where: '', bind: [] as string[] };
	try {
		const value = JSON.parse(atob(cursor)) as unknown;
		if (!Array.isArray(value) || value.length !== 2 || !value.every((x) => typeof x === 'string') || !Number.isFinite(Date.parse(value[0])))
			throw new Error();
		const comparison = order === 'asc' ? '>' : '<';
		return {
			limit,
			where: `AND (created_at ${comparison} ? OR (created_at = ? AND id ${comparison} ?))`,
			bind: [value[0], value[0], value[1]] as string[],
		};
	} catch {
		throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
	}
}

export function pageResult<T extends { created_at: string; id: string }>(name: string, rows: T[], limit: number, map: (row: T) => unknown) {
	const selected = rows.slice(0, limit);
	const last = selected.at(-1);
	return { [name]: selected.map(map), nextCursor: rows.length > limit && last ? btoa(JSON.stringify([last.created_at, last.id])) : null };
}
