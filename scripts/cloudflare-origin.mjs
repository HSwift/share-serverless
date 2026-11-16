function origin(value) {
	if (!value || value === 'https://api.invalid') return undefined;
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
		throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
	return url.origin;
}

// The Service Binding retains the Console request URL, so the API needs its
// own public origin. Discover it at deploy time, without runtime API credentials.
export async function discoverPublicOrigin(deployment, request) {
	const declared = origin(deployment.vars?.PUBLIC_BASE_URL);
	if (declared) return declared;
	const path = `/accounts/${encodeURIComponent(deployment.account_id)}/workers`;
	const domains = await request(`${path}/domains`);
	if (!Array.isArray(domains)) throw new Error('Cloudflare returned an invalid domain list');
	const hostnames = new Set(
		domains
			.filter((domain) => domain.service === deployment.name && domain.enabled !== false && (!domain.environment || domain.environment === 'production'))
			.map((domain) => domain.hostname),
	);
	for (const route of [deployment.route, ...(deployment.routes ?? [])]) {
		if (route?.custom_domain && route.pattern) hostnames.add(route.pattern);
	}
	const candidates = [...hostnames].map((hostname) => origin(`https://${hostname}`));
	if (candidates.length === 1) return candidates[0];
	const settings = await request(`${path}/scripts/${encodeURIComponent(deployment.name)}/settings`, true);
	const saved = origin(settings?.bindings?.find((binding) => binding.type === 'plain_text' && binding.name === 'PUBLIC_BASE_URL')?.text);
	if (saved && (!candidates.length || candidates.includes(saved))) return saved;
	if (candidates.length > 1)
		throw new Error('Multiple API custom domains are bound; set runtime PUBLIC_BASE_URL to select the canonical share origin');
	const subdomain = await request(`${path}/subdomain`);
	if (!subdomain?.subdomain) throw new Error('No API custom domain or workers.dev subdomain is available');
	return origin(`https://${deployment.name}.${subdomain.subdomain}.workers.dev`);
}

export async function resolvePublicOrigin(deployment, run) {
	const declared = origin(deployment.vars?.PUBLIC_BASE_URL);
	if (declared) return declared;
	let auth;
	try {
		auth = JSON.parse(await run(['auth', 'token', '--json'], true));
	} catch {
		throw new Error('Unable to retrieve Wrangler credentials for public domain discovery');
	}
	const headers = auth.token
		? { Authorization: `Bearer ${auth.token}` }
		: auth.type === 'api_key' && auth.key && auth.email
			? { 'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email }
			: undefined;
	if (!headers) throw new Error('Unsupported Wrangler credentials for public domain discovery');
	const accountId = deployment.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!accountId) {
		let accounts;
		try {
			accounts = JSON.parse(await run(['whoami', '--json'], true)).accounts;
		} catch {
			throw new Error('Unable to determine the Cloudflare deployment account');
		}
		if (accounts?.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to select a deployment account');
		deployment.account_id = accounts[0].id;
	} else deployment.account_id = accountId;
	return discoverPublicOrigin(deployment, async (path, optional = false) => {
		const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers, signal: AbortSignal.timeout(30000) });
		const data = await response.json();
		if (optional && response.status === 404) return null;
		if (!response.ok || !data.success) {
			const messages = data.errors?.map((error) => `${error.code}: ${error.message}`).join('; ');
			throw new Error(`Cloudflare domain discovery failed (HTTP ${response.status}): ${messages || 'unknown error'}`);
		}
		return data.result;
	});
}
