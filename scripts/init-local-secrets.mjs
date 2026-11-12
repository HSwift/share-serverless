import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

const path = new URL('../apps/api/.dev.vars', import.meta.url);
if (!existsSync(path))
	writeFileSync(
		path,
		[`API_BEARER_TOKEN=${randomBytes(32).toString('base64url')}`, `SHARE_SIGNING_KEY=${randomBytes(32).toString('base64')}`, ''].join('\n'),
		{ mode: 0o600 },
	);
const consolePath = new URL('../apps/console/.env.local', import.meta.url);
if (!existsSync(consolePath)) {
	const { API_BEARER_TOKEN } = parseEnv(readFileSync(path, 'utf8'));
	if (!API_BEARER_TOKEN) throw new Error('apps/api/.dev.vars must contain API_BEARER_TOKEN');
	writeFileSync(consolePath, `LOCAL_API_BEARER_TOKEN=${JSON.stringify(API_BEARER_TOKEN)}\n`, { mode: 0o600 });
}
console.log('Local API and Console secrets are ready. Existing files were preserved; secret values were not printed.');
