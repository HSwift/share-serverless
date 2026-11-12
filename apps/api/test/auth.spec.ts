import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticate } from '../src/auth';

describe('Cloudflare Access verification', () => {
	it('verifies a signed assertion and rejects the wrong audience, issuer and expired tokens', async () => {
		const { privateKey, publicKey } = await generateKeyPair('RS256');
		const issuer = `https://${crypto.randomUUID()}.cloudflareaccess.com`;
		const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
			return Response.json({ keys: [jwk] });
		});
		const bindings = { ...env, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'test-console' };
		const sign = (audience: string, iss: string, expiration: number) =>
			new SignJWT({ sub: 'personal-owner' })
				.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
				.setIssuer(iss)
				.setAudience(audience)
				.setExpirationTime(expiration)
				.sign(privateKey);
		const verify = (token: string) =>
			authenticate(new Request('https://api.example/api/v1/me', { headers: { 'cf-access-jwt-assertion': token } }), bindings);
		try {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			expect(await verify(await sign('test-console', issuer, expiry))).toMatchObject({ id: 'admin', method: 'access' });
			await expect(verify(await sign('other-console', issuer, expiry))).rejects.toMatchObject({ status: 401 });
			await expect(verify(await sign('test-console', 'https://wrong-issuer.example', expiry))).rejects.toMatchObject({ status: 401 });
			await expect(verify(await sign('test-console', issuer, 1))).rejects.toMatchObject({ status: 401 });
		} finally {
			fetch.mockRestore();
		}
	});
});
