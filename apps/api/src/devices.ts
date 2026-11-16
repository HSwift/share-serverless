import { Hono } from 'hono';
import type { AppEnv, DeviceRow } from './types';
import { requireApiTokenOrAccess } from './auth';
import { AppError, readJson, string, uuid } from './http';
import { randomToken, sha256 } from './crypto';

const capabilities = [
	'clipboard.read',
	'clipboard.write',
	'clipboard.watch',
	'clipboard.lazy',
	'sync.websocket',
	'files.read',
	'files.write',
] as const;

export function publicDevice(row: DeviceRow) {
	return {
		id: row.id,
		name: row.name,
		platform: row.platform,
		capabilities: JSON.parse(row.capabilities_json) as string[],
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
		revokedAt: row.revoked_at,
	};
}

export const devices = new Hono<AppEnv>();
devices.use('*', requireApiTokenOrAccess);
devices.get('/', async (c) => {
	const result = await c.env.DB.prepare('SELECT * FROM devices ORDER BY created_at DESC LIMIT 200').all<DeviceRow>();
	return c.json({ devices: result.results.map(publicDevice) });
});
devices.post('/', async (c) => {
	const input = await readJson(c.req.raw);
	const name = string(input.name, 'name');
	const platform = string(input.platform, 'platform', 32);
	const declared = input.capabilities ?? [];
	if (
		!Array.isArray(declared) ||
		declared.some((value) => typeof value !== 'string' || !(capabilities as readonly string[]).includes(value))
	) {
		throw new AppError(400, 'INVALID_CAPABILITIES', 'Unknown device capability', { allowed: capabilities });
	}
	const id = crypto.randomUUID();
	const token = `dev_${randomToken()}`;
	const createdAt = new Date().toISOString();
	await c.env.DB.prepare('INSERT INTO devices (id, name, platform, capabilities_json, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(id, name, platform, JSON.stringify([...new Set(declared)]), await sha256(token), createdAt)
		.run();
	const device = await c.env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first<DeviceRow>();
	return c.json({ device: publicDevice(device!), token }, 201);
});
devices.delete('/:id', async (c) => {
	const id = uuid(c.req.param('id'));
	const result = await c.env.DB.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
		.bind(new Date().toISOString(), id)
		.run();
	if (result.meta.changes === 0) throw new AppError(404, 'DEVICE_NOT_FOUND', 'Device not found');
	await c.env.CLIPBOARD.getByName('personal').disconnectDevice(id);
	return c.body(null, 204);
});
