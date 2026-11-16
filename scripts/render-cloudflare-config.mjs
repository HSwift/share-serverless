import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const configPath = new URL('../apps/api/wrangler.generated.jsonc', import.meta.url);
const secretsPath = new URL('../apps/api/.deploy-secrets.generated.json', import.meta.url);
const runtimeSecretNames = {
	RUNTIME_API_BEARER_TOKEN: 'API_BEARER_TOKEN',
	RUNTIME_SHARE_SIGNING_KEY: 'SHARE_SIGNING_KEY',
};

function required(name, kind = 'variable') {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing build ${kind}: ${name}`);
	return value;
}
function https(name, value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an HTTPS origin`);
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
		throw new Error(`${name} must be an HTTPS origin`);
	return url.origin;
}

// A failed render must never leave an earlier deployment or bootstrap payload usable.
rmSync(configPath, { force: true });
rmSync(secretsPath, { force: true });
try {
	const config = JSON.parse(readFileSync(new URL('../apps/api/wrangler.jsonc', import.meta.url), 'utf8'));
	const database = config.d1_databases?.find((binding) => binding.binding === 'DB');
	if (!database?.database_name) throw new Error('The DB binding must declare database_name');
	if (database.database_id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(database.database_id))
		throw new Error('DB database_id must be a UUID when provided');
	delete database.preview_database_id;
	// Account-specific runtime values can stay in the Dashboard. Omit template
	// defaults so keep_vars preserves the installed values on subsequent builds.
	if (!config.vars.PUBLIC_BASE_URL || config.vars.PUBLIC_BASE_URL === 'https://api.invalid')
		delete config.vars.PUBLIC_BASE_URL;
	else config.vars.PUBLIC_BASE_URL = https('PUBLIC_BASE_URL', config.vars.PUBLIC_BASE_URL);
	const teamDomain = config.vars.ACCESS_TEAM_DOMAIN?.trim();
	const audience = config.vars.ACCESS_AUD?.trim();
	if (teamDomain || audience) {
		if (!teamDomain || !audience) throw new Error('ACCESS_TEAM_DOMAIN and ACCESS_AUD must be configured together in wrangler.jsonc vars');
		config.vars.ACCESS_TEAM_DOMAIN = https('ACCESS_TEAM_DOMAIN', teamDomain);
		config.vars.ACCESS_AUD = audience;
	} else {
		delete config.vars.ACCESS_TEAM_DOMAIN;
		delete config.vars.ACCESS_AUD;
	}
	const size = Number(config.vars.MAX_UPLOAD_BYTES);
	if (!Number.isSafeInteger(size) || size < 1) throw new Error('MAX_UPLOAD_BYTES must be a positive integer in wrangler.jsonc vars');
	config.vars.MAX_UPLOAD_BYTES = String(size);

	let secrets;
	if (Object.keys(runtimeSecretNames).some((name) => process.env[name]?.trim())) {
		secrets = Object.fromEntries(
			Object.entries(runtimeSecretNames).map(([buildName, runtimeName]) => [runtimeName, required(buildName, 'secret')]),
		);
		try {
			if (atob(secrets.SHARE_SIGNING_KEY).length !== 32) throw new Error();
		} catch {
			throw new Error('RUNTIME_SHARE_SIGNING_KEY must be a base64-encoded 32-byte key');
		}
	}

	writeFileSync(configPath, `${JSON.stringify(config, null, '\t')}\n`, { mode: 0o600 });
	if (secrets) writeFileSync(secretsPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
	console.log(
		secrets
			? 'Rendered temporary Wrangler config and bootstrap secrets without printing their values.'
			: 'Rendered temporary Wrangler config; existing Worker secrets will be preserved.',
	);
} catch (error) {
	rmSync(configPath, { force: true });
	rmSync(secretsPath, { force: true });
	throw error;
}
