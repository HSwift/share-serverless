import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../apps/api/', import.meta.url));
const config = new URL('../apps/api/wrangler.generated.jsonc', import.meta.url);
const secrets = new URL('../apps/api/.deploy-secrets.generated.json', import.meta.url);
function run(args, capture = false) {
	return new Promise((resolve, reject) => {
		const child = spawn('pnpm', ['exec', 'wrangler', ...args], {
			cwd,
			stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
			env: process.env,
		});
		let output = '';
		if (capture) child.stdout.on('data', (chunk) => (output += chunk));
		child.once('error', reject);
		child.once('close', (code, signal) =>
			code === 0 ? resolve(output) : reject(new Error(`Wrangler failed (${signal ?? `exit ${code}`})`)),
		);
	});
}
try {
	if (!existsSync(config)) throw new Error('Run pnpm cf:render before deploying');
	const deployment = JSON.parse(readFileSync(config, 'utf8'));
	const database = deployment.d1_databases.find((binding) => binding.binding === 'DB');
	if (!database.database_id) {
		const databases = JSON.parse(await run(['d1', 'list', '--json', '--config', 'wrangler.generated.jsonc'], true));
		if (!Array.isArray(databases)) throw new Error('Expected a JSON array from wrangler d1 list');
		const existing = databases.find((candidate) => candidate.name === database.database_name);
		if (existing) {
			if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(existing.uuid))
				throw new Error('Invalid database ID returned by wrangler d1 list');
			database.database_id = existing.uuid;
			writeFileSync(config, `${JSON.stringify(deployment, null, '\t')}\n`, { mode: 0o600 });
		} else {
			// D1 must exist before migrations; resource names still come entirely from Wrangler config.
			await run([
				'd1', 'create', database.database_name, '--binding', 'DB', '--update-config', '--config', 'wrangler.generated.jsonc',
				...(database.jurisdiction ? ['--jurisdiction', database.jurisdiction] : []),
			]);
		}
	}
	await run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.generated.jsonc']);
	const deployArgs = ['deploy', '--config', 'wrangler.generated.jsonc'];
	if (existsSync(secrets)) deployArgs.push('--secrets-file', '.deploy-secrets.generated.json');
	await run(deployArgs);
} finally {
	rmSync(config, { force: true });
	rmSync(secrets, { force: true });
}
