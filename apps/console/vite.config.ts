import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
	const local = loadEnv(mode, '.', 'LOCAL_');
	const token = local.LOCAL_API_BEARER_TOKEN;
	return {
		plugins: [react(), tailwindcss()],
		server: {
			port: 5173,
			proxy: {
				'/api': {
					target: local.LOCAL_API_URL || 'http://127.0.0.1:8787',
					ws: true,
					headers: token ? { Authorization: `Bearer ${token}` } : undefined,
				},
			},
		},
	};
});
