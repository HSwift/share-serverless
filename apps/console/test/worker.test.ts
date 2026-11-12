import { describe, expect, it, vi } from 'vitest';
import { routeConsoleRequest } from '../src/worker';

describe('Console Worker boundary', () => {
	it('forwards the original authenticated API request through the binding', async () => {
		const request = new Request('https://console.example/api/v1/items', {
			method: 'POST',
			headers: { 'Cf-Access-Jwt-Assertion': 'signed-access-token', 'Content-Type': 'application/json' },
			body: '{"content":{"text":"hello"}}',
		});
		const response = new Response('{"ok":true}', { status: 201 });
		const fetch = vi.fn(async (forwarded: Request) => {
			expect(forwarded).toBe(request);
			expect(forwarded.headers.get('Cf-Access-Jwt-Assertion')).toBe('signed-access-token');
			expect(forwarded.headers.has('Authorization')).toBe(false);
			expect(await forwarded.text()).toContain('hello');
			return response;
		});
		const assets = vi.fn();
		expect(await routeConsoleRequest(request, { API: { fetch }, ASSETS: { fetch: assets } })).toBe(response);
		expect(assets).not.toHaveBeenCalled();
	});
	it('keeps upgrade requests on the API path and adds CSP only to assets', async () => {
		const apiFetch = vi.fn(async () => new Response('api'));
		const assetsFetch = vi.fn(async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
		const env = { API: { fetch: apiFetch }, ASSETS: { fetch: assetsFetch } };
		const upgrade = new Request('https://console.example/api/v1/clipboards/default/events', { headers: { Upgrade: 'websocket' } });
		await routeConsoleRequest(upgrade, env);
		expect(apiFetch).toHaveBeenCalledWith(upgrade);
		const page = await routeConsoleRequest(new Request('https://console.example/apix'), env);
		expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
		expect(page.headers.get('Content-Security-Policy')).toContain("object-src 'none'");
		expect(page.headers.get('Content-Security-Policy')).toContain('wss://console.example');
		expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(assetsFetch).toHaveBeenCalledOnce();
	});
});
