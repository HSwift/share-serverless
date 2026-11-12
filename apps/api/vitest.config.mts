import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Test fixtures also override inherited secrets before Wrangler reads its config.
const secrets = { API_BEARER_TOKEN: 'test-admin-token', SHARE_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
Object.assign(process.env, secrets);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					...secrets,
					TEST_MIGRATIONS: await readD1Migrations('./migrations'),
				},
			},
		}),
	],
	test: { setupFiles: ['./test/setup.ts'] },
});
