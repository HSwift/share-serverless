import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { shellQuote } from '../src/lib/curl';

test('curl tab renders the runtime address and sends text and files to the real API', async ({ page, request }, testInfo) => {
	const directory = mkdtempSync(join(tmpdir(), 'clipboard-curl-'));
	try {
		await page.goto('/');
		await page.getByRole('banner').getByRole('button', { name: 'New item', exact: true }).click();
		await page.getByRole('tab', { name: 'curl', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'New clipboard item' });
		const textExample = dialog.getByRole('region', { name: 'Text curl example' }).locator('code');
		const fileExample = dialog.getByRole('region', { name: 'File curl example' }).locator('code');
		await expect(textExample).toBeVisible();
		await expect(fileExample).toBeVisible();
		await expect(dialog.getByRole('button', { name: /Copy/ })).toHaveCount(0);
		await expect(dialog.getByRole('button', { name: 'Save item', exact: true })).toHaveCount(0);
		const config = await (await request.get('/api/v1/config/cli')).json();
		const textCommand = (await textExample.textContent())!;
		const fileCommand = (await fileExample.textContent())!;
		expect(textCommand.includes('\n') || fileCommand.includes('\n')).toBe(false);
		// Boolean assertions keep the local development credential out of failure output.
		expect(textCommand.includes(`Authorization: Bearer ${config.apiToken}`)).toBe(true);
		expect(textCommand.includes(`${config.apiBaseUrl}/api/v1/clipboards/default`)).toBe(true);
		const text = `From curl: 中文, "quotes", a newline\nand $shell characters ${crypto.randomUUID()}`;
		const sendText = spawnSync('/bin/sh', ['-c', textCommand.replace("'Hello from curl'", shellQuote(text))], { encoding: 'utf8' });
		expect(sendText.status, 'The displayed text command succeeds').toBe(0);
		expect(await (await request.get('/api/v1/clipboards/default/text')).text()).toBe(text);

		const path = join(directory, `测试 ' $(printf literal).bin`);
		const bytes = Buffer.from([0, 255, 128, 10, 34, 39, 0, 1]);
		writeFileSync(path, bytes);
		const fileUrl = new URL(`${config.apiBaseUrl}/api/v1/clipboards/default/content`);
		fileUrl.searchParams.set('name', basename(path));
		const uploadCommand = fileCommand
			.replace(shellQuote(`${config.apiBaseUrl}/api/v1/clipboards/default/content?name=example.txt`), shellQuote(fileUrl.href))
			.replace("'@./example.txt'", shellQuote(`@${path}`));
		const sendFile = spawnSync('/bin/sh', ['-c', uploadCommand], {
			encoding: 'utf8',
		});
		expect(sendFile.status, 'The displayed file command succeeds').toBe(0);
		const { state } = JSON.parse(sendFile.stdout);
		const { item, files } = await (await request.get(`/api/v1/items/${state.itemId}`)).json();
		expect(files[0].name).toBe(basename(path));
		expect(await (await request.get(`/api/v1/files/${item.content.files[0]}/content`)).body()).toEqual(bytes);
		const failed = spawnSync('/bin/sh', ['-c', fileCommand.replace("'@./example.txt'", shellQuote(`@${join(directory, 'missing.bin')}`))]);
		expect(failed.status).not.toBe(0);
		expect((await (await request.get('/api/v1/clipboards/default')).json()).state.revision).toBe(state.revision);

		// Screenshots use an example credential, never the real local or production token.
		await page.route('**/api/v1/config/cli', (route) => route.fulfill({
			json: { apiBaseUrl: 'https://api.example.com', apiToken: 'example-api-token' },
		}));
		await dialog.getByRole('tab', { name: 'Text & code', exact: true }).click();
		await dialog.getByRole('tab', { name: 'curl', exact: true }).click();
		await expect(textExample).toContainText('example-api-token');
		await page.screenshot({ path: testInfo.outputPath('curl-desktop.png') });
		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: 844 });
			await expect(dialog.getByRole('tab', { name: 'curl', exact: true })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			await page.screenshot({ path: testInfo.outputPath(`curl-mobile-${width}.png`) });
		}
		await dialog.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(dialog).toHaveCount(0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
