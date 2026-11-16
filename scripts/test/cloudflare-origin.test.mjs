import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverPublicOrigin, resolvePublicOrigin } from '../cloudflare-origin.mjs';

const deployment = { account_id: 'test-account', name: 'share-serverless-api', vars: {} };
function metadata({ domains = [], saved, subdomain = 'example-account' } = {}) {
	return async (path) => {
		if (path.endsWith('/domains')) return domains;
		if (path.endsWith('/settings')) return saved ? { bindings: [{ type: 'plain_text', name: 'PUBLIC_BASE_URL', text: saved }] } : null;
		if (path.endsWith('/subdomain')) return { subdomain };
		throw new Error('Unexpected Cloudflare request');
	};
}
const domain = (hostname, extra = {}) => ({ hostname, service: deployment.name, environment: 'production', enabled: true, ...extra });

test('an explicit origin needs no Cloudflare credential or metadata access', async () => {
	const configured = { ...deployment, vars: { PUBLIC_BASE_URL: 'https://api.example.com/' } };
	assert.equal(await resolvePublicOrigin(configured, () => assert.fail('must not invoke Wrangler')), 'https://api.example.com');
});

test('discovers the API custom domain and replaces an old workers.dev origin', async () => {
	const request = metadata({
		domains: [domain('console.example.com', { service: 'share-serverless-console' }), domain('api.example.com'), domain('disabled.example.com', { enabled: false }), domain('preview.example.com', { environment: 'staging' })],
		saved: 'https://share-serverless-api.example-account.workers.dev',
	});
	assert.equal(await discoverPublicOrigin(deployment, request), 'https://api.example.com');
});

test('uses a custom domain declared for the upcoming deployment without duplicating a bound hostname', async () => {
	assert.equal(await discoverPublicOrigin({ ...deployment, routes: [{ custom_domain: true, pattern: 'api.example.com' }] }, metadata()), 'https://api.example.com');
	assert.equal(await discoverPublicOrigin({ ...deployment, route: { custom_domain: true, pattern: 'api.example.com' } }, metadata({ domains: [domain('api.example.com')] })), 'https://api.example.com');
});

test('falls back to workers.dev on the first deployment', async () => {
	assert.equal(await discoverPublicOrigin(deployment, metadata()), 'https://share-serverless-api.example-account.workers.dev');
});

test('preserves a saved origin for an API reached through Worker routes', async () => {
	assert.equal(await discoverPublicOrigin(deployment, metadata({ saved: 'https://api.example.com' })), 'https://api.example.com');
});

test('requires an explicit canonical origin when several domains are bound', async () => {
	const domains = [domain('api-a.example.com'), domain('api-b.example.com')];
	await assert.rejects(discoverPublicOrigin(deployment, metadata({ domains })), /Multiple API custom domains/);
	await assert.rejects(discoverPublicOrigin(deployment, metadata({ domains, saved: 'https://old.example.com' })), /Multiple API custom domains/);
	assert.equal(await discoverPublicOrigin(deployment, metadata({ domains, saved: 'https://api-b.example.com' })), 'https://api-b.example.com');
});

test('rejects missing or malformed public domain metadata', async () => {
	await assert.rejects(discoverPublicOrigin(deployment, metadata({ subdomain: '' })), /No API custom domain/);
	await assert.rejects(discoverPublicOrigin(deployment, metadata({ domains: [domain('api.example.com/unexpected')] })), /HTTPS origin/);
	await assert.rejects(discoverPublicOrigin(deployment, async () => ({})), /invalid domain list/);
});
