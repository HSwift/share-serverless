import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const databaseId = '01234567-89ab-cdef-0123-456789abcdef';
const runtimeVars = {
	PUBLIC_BASE_URL: 'https://share-api.example.com/',
	MAX_UPLOAD_BYTES: '2048',
	ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
	ACCESS_AUD: 'test-console-audience',
};
const bootstrap = {
	RUNTIME_API_BEARER_TOKEN: 'test-only-administrator-token',
	RUNTIME_SHARE_SIGNING_KEY: Buffer.alloc(32, 7).toString('base64'),
};

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'share-deploy-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const api = join(root, 'apps/api');
	mkdirSync(api, { recursive: true });
	mkdirSync(join(root, 'scripts'));
	for (const name of ['render-cloudflare-config.mjs', 'deploy-cloudflare.mjs'])
		copyFileSync(new URL(`../${name}`, import.meta.url), join(root, 'scripts', name));
	const template = join(api, 'wrangler.jsonc');
	const source = JSON.parse(readFileSync(new URL('../../apps/api/wrangler.jsonc', import.meta.url), 'utf8'));
	source.vars = { ...runtimeVars };
	writeFileSync(template, JSON.stringify(source));
	const config = join(api, 'wrangler.generated.jsonc');
	const secrets = join(api, '.deploy-secrets.generated.json');
	const calls = join(root, 'calls.jsonl');
	mkdirSync(join(root, 'bin'));
	// The fake executable never invokes Wrangler or contacts Cloudflare.
	writeFileSync(
		join(root, 'bin/pnpm'),
		`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync('wrangler.generated.jsonc', 'utf8'));
const db = config.d1_databases.find(binding => binding.binding === 'DB');
appendFileSync(process.env.TEST_CALLS, JSON.stringify({
  args, cwd: process.cwd(), databaseId: db.database_id,
  secretsExist: existsSync('.deploy-secrets.generated.json'),
}) + '\\n');
if (args.includes(process.env.TEST_FAIL_COMMAND)) process.exit(9);
if (args[2] === 'd1' && args[3] === 'list') {
  process.stdout.write(process.env.TEST_DATABASES ?? JSON.stringify([{name: db.database_name, uuid: '${databaseId}'}]));
}
if (args[2] === 'd1' && args[3] === 'create') {
  db.database_id = '${databaseId}';
  writeFileSync('wrangler.generated.jsonc', JSON.stringify(config));
}
`,
		{ mode: 0o700 },
	);
	// Never inherit developer credentials or real bootstrap secrets.
	const env = { PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, TEST_CALLS: calls };
	return {
		api,
		config,
		secrets,
		configure(update) {
			const config = JSON.parse(readFileSync(template, 'utf8'));
			update(config);
			writeFileSync(template, JSON.stringify(config));
		},
		run(script, extra = {}) {
			const file = script === 'render' ? 'render-cloudflare-config.mjs' : 'deploy-cloudflare.mjs';
			return spawnSync(process.execPath, [join(root, 'scripts', file)], { env: { ...env, ...extra }, encoding: 'utf8' });
		},
		calls() {
			return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
		},
	};
}

function cleaned(f) {
	assert.equal(existsSync(f.config), false);
	assert.equal(existsSync(f.secrets), false);
}

test('runtime configuration comes from Wrangler, not similarly named build environment variables', (t) => {
	const f = fixture(t);
	const result = f.run('render', {
		...bootstrap,
		PUBLIC_BASE_URL: 'https://unexpected.example.com',
		ACCESS_TEAM_DOMAIN: 'https://unexpected.cloudflareaccess.com',
		ACCESS_AUD: 'unexpected-audience',
		MAX_UPLOAD_BYTES: '1',
		D1_DATABASE_ID: databaseId,
		R2_BUCKET_NAME: 'unexpected-files',
	});
	assert.equal(result.status, 0, result.stderr);
	const configText = readFileSync(f.config, 'utf8');
	const config = JSON.parse(configText);
	assert.deepEqual(config.vars, { ...runtimeVars, PUBLIC_BASE_URL: 'https://share-api.example.com' });
	assert.equal(config.d1_databases[0].database_id, undefined);
	assert.equal(config.d1_databases[0].preview_database_id, undefined);
	assert.equal(config.r2_buckets[0].bucket_name, 'share-serverless-files');
	assert.deepEqual(JSON.parse(readFileSync(f.secrets, 'utf8')), {
		API_BEARER_TOKEN: bootstrap.RUNTIME_API_BEARER_TOKEN,
		SHARE_SIGNING_KEY: bootstrap.RUNTIME_SHARE_SIGNING_KEY,
	});
	for (const value of Object.values(bootstrap)) {
		assert.equal(configText.includes(value), false);
		assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
	}
	assert.equal(statSync(f.config).mode & 0o777, 0o600);
	assert.equal(statSync(f.secrets).mode & 0o777, 0o600);
});

test('ordinary render discards stale bootstrap payloads so later deploys cannot reset secrets', (t) => {
	const f = fixture(t);
	assert.equal(f.run('render', bootstrap).status, 0);
	assert.equal(f.run('render').status, 0);
	assert.equal(existsSync(f.secrets), false);
	assert.equal(existsSync(f.config), true);
});

test('invalid runtime configuration leaves nothing deployable', (t) => {
	const invalid = [
		[(c) => (c.d1_databases[0].database_id = '-'.repeat(36)), /database_id must be a UUID/],
		[(c) => (c.vars.PUBLIC_BASE_URL = 'http://api.example.com'), /PUBLIC_BASE_URL must be an HTTPS origin/],
		[(c) => (c.vars.PUBLIC_BASE_URL = 'https://api.example.com/path'), /PUBLIC_BASE_URL must be an HTTPS origin/],
		[(c) => (c.vars.ACCESS_TEAM_DOMAIN = ''), /must be configured together/],
		[(c) => (c.vars.ACCESS_AUD = ''), /must be configured together/],
		[(c) => (c.vars.MAX_UPLOAD_BYTES = '-1'), /MAX_UPLOAD_BYTES must be a positive integer/],
	];
	for (const [update, message] of invalid) {
		const f = fixture(t);
		assert.equal(f.run('render', bootstrap).status, 0);
		f.configure(update);
		const result = f.run('render');
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, message);
		cleaned(f);
	}
});

test('incomplete or malformed bootstrap secrets remove previous deployment files without logging values', (t) => {
	const invalid = [
		[{ RUNTIME_API_BEARER_TOKEN: bootstrap.RUNTIME_API_BEARER_TOKEN }, /Missing build secret: RUNTIME_SHARE_SIGNING_KEY/],
		[{ RUNTIME_SHARE_SIGNING_KEY: bootstrap.RUNTIME_SHARE_SIGNING_KEY }, /Missing build secret: RUNTIME_API_BEARER_TOKEN/],
		[{ ...bootstrap, RUNTIME_SHARE_SIGNING_KEY: 'bad-key' }, /base64-encoded 32-byte key/],
		[{ ...bootstrap, RUNTIME_SHARE_SIGNING_KEY: `${bootstrap.RUNTIME_SHARE_SIGNING_KEY}!` }, /base64-encoded 32-byte key/],
	];
	const f = fixture(t);
	for (const [vars, message] of invalid) {
		assert.equal(f.run('render', bootstrap).status, 0);
		const result = f.run('render', vars);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, message);
		for (const value of Object.values(bootstrap)) assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
		cleaned(f);
	}
});

for (const firstDeploy of [false, true]) {
	test(`deploy ${firstDeploy ? 'creates' : 'reuses'} the declared database before migrations and code upload`, (t) => {
		const f = fixture(t);
		assert.equal(f.run('render', firstDeploy ? bootstrap : {}).status, 0);
		const result = f.run('deploy', firstDeploy ? { TEST_DATABASES: '[]' } : {});
		assert.equal(result.status, 0, result.stderr);
		const calls = f.calls();
		assert.deepEqual(calls.map((call) => call.args[3] ?? call.args[2]), firstDeploy ? ['list', 'create', 'migrations', '--config'] : ['list', 'migrations', '--config']);
		if (firstDeploy) {
			assert.deepEqual(calls[1].args, [
				'exec', 'wrangler', 'd1', 'create', 'share-serverless', '--binding', 'DB', '--update-config', '--config', 'wrangler.generated.jsonc',
			]);
		}
		const [migration, deployment] = calls.slice(-2);
		assert.deepEqual(migration.args, ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.generated.jsonc']);
		assert.equal(migration.databaseId, databaseId);
		assert.equal(deployment.databaseId, databaseId);
		assert.deepEqual(deployment.args, [
			'exec', 'wrangler', 'deploy', '--config', 'wrangler.generated.jsonc',
			...(firstDeploy ? ['--secrets-file', '.deploy-secrets.generated.json'] : []),
		]);
		for (const call of calls) {
			assert.equal(call.cwd, f.api);
			assert.equal(call.secretsExist, firstDeploy);
		}
		cleaned(f);
	});
}

test('an explicit database ID skips lookup and creation', (t) => {
	const f = fixture(t);
	f.configure((c) => (c.d1_databases[0].database_id = databaseId));
	assert.equal(f.run('render').status, 0);
	assert.equal(f.run('deploy').status, 0);
	assert.equal(f.calls().length, 2);
	assert.equal(f.calls()[0].args[3], 'migrations');
	cleaned(f);
});

for (const [command, count] of [['list', 1], ['create', 2], ['migrations', 2], ['deploy', 3]]) {
	test(`failed ${command} stops the pipeline and cleans configuration and secrets`, (t) => {
		const f = fixture(t);
		assert.equal(f.run('render', bootstrap).status, 0);
		const result = f.run('deploy', { TEST_FAIL_COMMAND: command, ...(command === 'create' ? { TEST_DATABASES: '[]' } : {}) });
		assert.notEqual(result.status, 0);
		assert.equal(f.calls().length, count);
		cleaned(f);
	});
}

test('deploy without rendered configuration runs no commands and removes orphaned secrets', (t) => {
	const f = fixture(t);
	writeFileSync(f.secrets, '{}', { mode: 0o600 });
	const result = f.run('deploy');
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Run pnpm cf:render/);
	assert.deepEqual(f.calls(), []);
	cleaned(f);
});
