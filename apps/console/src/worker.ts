type Forwarder = { fetch(request: Request): Promise<Response> };
export interface ConsoleEnv {
	API: Forwarder;
	ASSETS: Forwarder;
}

export async function routeConsoleRequest(request: Request, env: ConsoleEnv): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return env.API.fetch(request);
	const response = await env.ASSETS.fetch(request);
	const headers = new Headers(response.headers);
	headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self' 'unsafe-inline'",
			"font-src 'self'",
			"img-src 'self' blob: https: http:",
			"media-src 'self' blob:",
			`connect-src 'self' ${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`,
			"frame-src 'self'",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join('; '),
	);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'no-referrer');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default { fetch: routeConsoleRequest };
