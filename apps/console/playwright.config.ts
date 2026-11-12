import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: 'http://127.0.0.1:15173',
		viewport: { width: 1440, height: 1000 },
		permissions: ['clipboard-read', 'clipboard-write'],
		trace: 'retain-on-failure',
	},
	webServer: [
		{
			command:
				'pnpm --filter @share/api exec wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e && pnpm --filter @share/api exec wrangler dev --name share-serverless-api-e2e --ip 127.0.0.1 --port 18787 --persist-to .wrangler/e2e --var PUBLIC_BASE_URL:http://127.0.0.1:18787',
			url: 'http://127.0.0.1:18787/api/health',
			reuseExistingServer: false,
			timeout: 60000,
		},
		{
			command: 'pnpm exec vite --host 127.0.0.1 --port 15173 --strictPort',
			url: 'http://127.0.0.1:15173',
			env: { LOCAL_API_URL: 'http://127.0.0.1:18787' },
			reuseExistingServer: false,
		},
		{
			command: 'pnpm exec wrangler dev --env e2e --ip 127.0.0.1 --port 18788',
			url: 'http://127.0.0.1:18788/api/health',
			reuseExistingServer: false,
			timeout: 60000,
		},
	],
});
