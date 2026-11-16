import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { secureEqual, sha256 } from './crypto';
import { AppError } from './http';
import type { AppEnv, Bindings, DeviceRow, Principal } from './types';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, env: Bindings): Promise<Principal> {
	const authorization = request.headers.get('authorization');
	if (authorization?.startsWith('Bearer ')) {
		const token = authorization.slice(7);
		if (env.API_BEARER_TOKEN && (await secureEqual(token, env.API_BEARER_TOKEN))) {
			return { id: 'admin', method: 'bearer', deviceId: null, expiresAt: Date.now() + 86400000 };
		}
		if (/^dev_[A-Za-z0-9_-]{43}$/.test(token)) {
			const device = await env.DB.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
				.bind(await sha256(token))
				.first<DeviceRow>();
			if (device) {
				return { id: device.id, method: 'device', deviceId: device.id, expiresAt: Date.now() + 86400000 };
			}
		}
	}
	const assertion = request.headers.get('cf-access-jwt-assertion');
	if (assertion && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
		try {
			const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
			if (!issuer.startsWith('https://')) throw new Error('Invalid Access team domain');
			let jwks = jwksCache.get(issuer);
			if (!jwks) {
				jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
				jwksCache.set(issuer, jwks);
			}
			const { payload } = await jwtVerify(assertion, jwks, { issuer, audience: env.ACCESS_AUD });
			if (typeof payload.exp !== 'number') throw new Error('Missing expiration');
			return { id: 'admin', method: 'access', deviceId: null, expiresAt: Math.min(payload.exp * 1000, Date.now() + 86400000) };
		} catch {
			/* Invalid assertions never grant access. */
		}
	}
	throw new AppError(401, 'UNAUTHORIZED', 'A valid Bearer token or Cloudflare Access assertion is required');
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
	const principal = await authenticate(c.req.raw, c.env);
	c.set('principal', principal);
	if (principal.deviceId) {
		// Throttle bookkeeping; polls must not turn into a database write each time.
		c.executionCtx.waitUntil(
			c.env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
				.bind(new Date().toISOString(), principal.deviceId, new Date(Date.now() - 300000).toISOString())
				.run()
				.catch(() => {}),
		);
	}
	await next();
};

export const requireApiTokenOrAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (c.get('principal').method === 'device')
		throw new AppError(403, 'FORBIDDEN', 'This operation requires the API token or a Cloudflare Access session');
	await next();
};
