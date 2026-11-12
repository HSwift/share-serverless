import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

async function filterType(page: Page, type: string) {
	await page.getByLabel('Filters', { exact: true }).click();
	await page.getByLabel('Filter by type').selectOption(type);
	await page.keyboard.press('Escape');
}
async function view(page: Page, label: string) {
	await page.getByLabel('Item options', { exact: true }).click();
	await page.getByRole('button', { name: label, exact: true }).click();
}

test('mobile opens an item without flashing a loading page or the previous content', async ({ page, request }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const suffix = `mobile-${crypto.randomUUID()}`;
	const title = `Mobile Markdown ${suffix}`;
	const previousTitle = `Previous item ${suffix}`;
	const response = await request.post('/api/v1/items', {
		data: { content: { representations: [{ mimeType: 'text/markdown', text: `# ${title}\n\n**Ready to read.**` }] } },
	});
	const { item } = await response.json();
	await request.post('/api/v1/items', { data: { content: { text: previousTitle } } });
	let release!: () => void;
	let requested!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		requested = resolve;
	});
	await page.route(`**/api/v1/items/${item.id}`, async (route) => {
		requested();
		await gate;
		await route.continue();
	});
	await page.goto('/');
	await page.getByLabel('Search clipboard').fill(suffix);
	await expect(page.locator('.item-row')).toHaveCount(2);
	await page.evaluate(() => {
		const state = { active: true, frames: [] as { title: string; mode: string }[] };
		Object.assign(window, { previewPaints: state });
		const record = () => {
			if (!state.active) return;
			if (document.querySelector('.clipboard-workspace.show-detail')) {
				const panel = document.querySelector('.detail-panel')!;
				state.frames.push({
					title: panel.querySelector('.detail-title h2')?.textContent ?? '',
					mode: panel.querySelector('.markdown-preview') ? 'markdown' : panel.querySelector('.plain-preview') ? 'plain' : 'loading',
				});
			}
			requestAnimationFrame(record);
		};
		requestAnimationFrame(record);
	});
	await page.locator('.item-row').filter({ hasText: title }).click();
	await started;
	try {
		expect(await page.getByLabel('Search clipboard').isVisible()).toBe(true);
		await expect(page.locator('.item-row[aria-busy="true"]')).toHaveCount(1);
	} finally {
		release();
	}
	await expect(page.locator('.markdown-preview strong')).toHaveText('Ready to read.');
	await expect(page.locator('.detail-title h2')).toHaveText(title);
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
	const frames = await page.evaluate(() => {
		const state = (window as unknown as { previewPaints: { active: boolean; frames: { title: string; mode: string }[] } }).previewPaints;
		state.active = false;
		return state.frames;
	});
	expect(frames.length).toBeGreaterThan(0);
	expect(frames.every((frame) => frame.title === title && frame.mode === 'markdown')).toBe(true);
	await page.getByRole('button', { name: 'All items', exact: true }).click();
	await page.locator('.item-row').filter({ hasText: previousTitle }).click();
	await expect(page.locator('.plain-preview')).toHaveText(previousTitle);
	await page.getByRole('button', { name: 'All items', exact: true }).click();
	await page.unroute(`**/api/v1/items/${item.id}`);
	const calls: string[] = [];
	await page.route(`**/api/v1/items/${item.id}`, (route) => {
		calls.push(route.request().url());
		return route.continue();
	});
	await page.locator('.item-row').filter({ hasText: title }).click();
	await expect(page.locator('.markdown-preview strong')).toHaveText('Ready to read.');
	expect(calls).toEqual([]);
});

test('real API: create, search, preview, copy, share, upload and mobile navigation', async ({ page, request }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const suffix = Date.now().toString(36);
	const title = `Workspace notes ${suffix}`;
	const markdown = `# ${title}\n\nA shared place for the things worth keeping.\n\n## A quieter workflow\n\n- Copy once and pick up where you left off.\n- Keep **text, code, and files** together.\n- Share a saved item with a single link.\n\n## Built for your everyday\n\nYour clipboard stays close, whatever device you’re using.\n\n> Small things, effortlessly connected.\n\n---\n\nLast updated today. Ready when you are.`;
	const fixtures = [
		{ text: 'A thought for later\nMake the everyday a little easier. Keep the useful things close.' },
		{ representations: [{ mimeType: 'application/json', text: '{\n  "theme": "light",\n  "accent": "#f6821f",\n  "sync": true\n}' }] },
		{ text: 'Weekend reading list\nhttps://developer.mozilla.org\nhttps://web.dev' },
		{
			representations: [
				{
					mimeType: 'text/typescript',
					text: '// A small clipboard client\nexport async function getClipboard() {\n  const response = await fetch("/api/v1/clipboards/default");\n  return response.json();\n}',
				},
			],
		},
	];
	for (const content of fixtures) expect((await request.post('/api/v1/items', { data: { content } })).ok()).toBe(true);
	await page.goto('/');
	await expect(page.getByRole('banner').getByRole('button', { name: 'New item', exact: true })).toBeVisible();

	await expect(page.getByRole('button', { name: 'Refresh clipboard' })).toBeVisible();
	await expect(page.locator('details[open]')).toHaveCount(0);
	await page.getByRole('banner').getByRole('button', { name: 'New item', exact: true }).click();
	const composer = page.getByRole('dialog', { name: 'New clipboard item' });
	await expect(composer).toBeVisible();
	await expect(composer.getByRole('form', { name: 'New clipboard item' })).toBeVisible();
	const desktopBox = await composer.boundingBox();
	expect(desktopBox!.width).toBeGreaterThanOrEqual(900);
	expect(desktopBox!.height).toBeGreaterThanOrEqual(700);
	expect((await page.getByLabel('CONTENT', { exact: true }).boundingBox())!.height).toBeGreaterThan(400);
	await expect(page.getByLabel('CONTENT', { exact: true })).toBeFocused();
	await page.getByLabel('CONTENT', { exact: true }).fill('A draft to cancel');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.getByRole('banner').getByRole('button', { name: 'New item', exact: true }).click();
	await page.getByLabel('Content format').selectOption('markdown');
	await page.getByLabel('CONTENT', { exact: true }).fill(markdown);
	await page.screenshot({ path: testInfo.outputPath('composer-desktop.png'), fullPage: true });
	await page.getByRole('button', { name: 'Save item', exact: true }).click();
	await expect(page.getByRole('heading', { name: title, exact: true }).last()).toBeVisible();
	await expect(page.locator('.markdown-preview h2').first()).toHaveText('A quieter workflow');
	await expect(page.locator('.connection')).toHaveText('Live sync');
	await page.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect(page.getByRole('status')).toContainText('Copied to clipboard');
	await page.getByRole('button', { name: 'Share', exact: true }).click();
	await page.getByRole('button', { name: 'Create link', exact: true }).click();
	const url = await page.getByLabel('SHARE LINK', { exact: true }).inputValue();
	const testUrl = new URL(url);
	testUrl.hostname = '127.0.0.1';
	testUrl.port = '18787';
	const share = await (await request.get(testUrl.href)).json();
	expect(share.share.item.content.representations.some((rep: { text?: string }) => rep.text === markdown)).toBe(true);
	await page.getByRole('button', { name: 'Revoke link', exact: true }).click();
	expect((await request.get(testUrl.href)).status()).toBe(410);
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await view(page, 'View source');
	await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
	await expect(page.locator('.cm-content')).toContainText(title);
	await view(page, 'Show preview');
	await view(page, 'Item details');
	await expect(page.getByRole('heading', { name: 'About this item' })).toBeVisible();
	await view(page, 'Show preview');
	await page.getByLabel('Search clipboard').fill(suffix);
	await expect(page.locator('.item-row')).toHaveCount(1);
	await filterType(page, 'image');
	await expect(page.getByRole('heading', { name: 'No matching items' })).toBeVisible();
	await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
	await expect(page.locator('.item-row').first()).toBeVisible();
	await page.getByRole('banner').getByRole('button', { name: 'New item', exact: true }).click();
	await page.getByRole('tab', { name: 'Files', exact: true }).click();
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
	await page.locator('input[type="file"]').setInputFiles({ name: `image-${suffix}.png`, mimeType: 'image/png', buffer: png });
	await page.getByRole('button', { name: 'Save item', exact: true }).click();
	await expect(page.locator('.image-preview img')).toBeVisible();
	const download = page.waitForEvent('download');
	await page.getByRole('link', { name: `Download image-${suffix}.png` }).click();
	expect((await download).suggestedFilename()).toBe(`image-${suffix}.png`);
	// Re-saving immutable content must select that older item after clearing a filter.
	await filterType(page, 'image');
	await page.getByRole('banner').getByRole('button', { name: 'New item', exact: true }).click();
	await page.getByLabel('Content format').selectOption('markdown');
	await page.getByLabel('CONTENT', { exact: true }).fill(markdown);
	await page.getByRole('button', { name: 'Save item', exact: true }).click();
	await expect(page.locator('.detail-title h2')).toHaveText(title);
	await filterType(page, 'text');
	await expect(page.locator('.item-row').first()).toBeVisible();
	await page.locator('.item-row').filter({ hasText: title }).click();
	await page
		.getByRole('button', { name: 'Dismiss notification' })
		.click()
		.catch(() => {});
	await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await expect(page.getByRole('button', { name: 'All items', exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.getByRole('button', { name: 'All items', exact: true }).click();
		await expect(page.getByLabel('Search clipboard')).toBeVisible();
		await page.getByLabel('Filters', { exact: true }).click();
		const menu = await page.locator('details[open] .popover-content').boundingBox();
		expect(menu).not.toBeNull();
		expect(menu!.x).toBeGreaterThanOrEqual(0);
		expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
		await page.keyboard.press('Escape');
		await expect(page.locator('details[open]')).toHaveCount(0);
		await page.getByRole('banner').getByRole('button', { name: 'New item', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'New clipboard item' })).toBeVisible();
		await expect(page.getByRole('form', { name: 'New clipboard item' })).toBeVisible();
		const mobileBox = await page.getByRole('dialog').boundingBox();
		expect(mobileBox!.x).toBeGreaterThanOrEqual(0);
		expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(width);
		expect(mobileBox!.y + mobileBox!.height).toBeLessThanOrEqual(844);
		await page.getByLabel('CONTENT', { exact: true }).fill(`Mobile draft ${width}`);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await expect(page.getByRole('button', { name: 'Save item', exact: true })).toBeVisible();
		if (width === 320) await page.screenshot({ path: testInfo.outputPath('composer-mobile.png'), fullPage: true });
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.locator('.item-row').filter({ hasText: title }).click();
		await expect(page.locator('.markdown-preview')).toBeVisible();
	}
	await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
	expect(errors).toEqual([]);
});

test('HTML and Markdown XSS fixtures stay inert in a real browser', async ({ page, request }) => {
	const html =
		'<h1>Untrusted HTML fixture</h1><script>parent.__clipboardXss=1</script><img src=x onerror="parent.__clipboardXss=2"><svg onload="parent.__clipboardXss=3"></svg><iframe srcdoc="<script>parent.__clipboardXss=4</script>"></iframe><a href="javascript:parent.__clipboardXss=5">Danger</a>';
	const result = await request.post('/api/v1/clipboards/default', {
		data: { content: { representations: [{ mimeType: 'text/html', text: html }] }, mutationId: crypto.randomUUID() },
	});
	expect(result.ok()).toBe(true);
	await page.goto('/');
	await page.getByLabel('Search clipboard').fill('Untrusted HTML fixture');
	await page.locator('.item-row').filter({ hasText: '<h1>Untrusted HTML fixture</h1>' }).click();
	const frame = page.frameLocator('iframe[title="Sanitized HTML preview"]');
	await expect(frame.getByRole('heading', { name: 'Untrusted HTML fixture' })).toBeVisible();
	await expect(frame.locator('script,svg,iframe')).toHaveCount(0);
	await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
	await expect(frame.locator('a')).not.toHaveAttribute('href');
	expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__clipboardXss)).toBeUndefined();
	const trackerRequests: string[] = [];
	page.on('request', (req) => {
		if (req.url().includes('tracker.invalid')) trackerRequests.push(req.url());
	});
	const md =
		'# Markdown safety fixture\n\n<script>window.__clipboardXss=6</script>\n\n[click](javascript:alert(1))\n\n![tracking](https://tracker.invalid/image.svg)';
	await request.post('/api/v1/clipboards/default', {
		data: { content: { representations: [{ mimeType: 'text/markdown', text: md }] }, mutationId: crypto.randomUUID() },
	});
	await page.getByLabel('Search clipboard').fill('Markdown safety fixture');
	await page.getByRole('button', { name: 'Refresh clipboard' }).click();
	await page.locator('.item-row').filter({ hasText: 'Markdown safety fixture' }).click();
	await expect(page.locator('.markdown-preview').getByRole('heading', { name: 'Markdown safety fixture' })).toBeVisible();
	await expect(page.locator('.markdown-preview script, .markdown-preview img')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Load image' })).toBeVisible();
	expect(trackerRequests).toEqual([]);
	expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__clipboardXss)).toBeUndefined();
	await page.route('https://tracker.invalid/image.svg', (route) =>
		route.fulfill({
			contentType: 'image/png',
			body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
		}),
	);
	await page.getByRole('button', { name: 'Load image' }).click();
	await expect(page.locator('.markdown-preview img')).toHaveCount(1);
	await expect.poll(() => trackerRequests.length).toBe(1);
	const nextTitle = `Another Markdown image ${crypto.randomUUID()}`;
	await request.post('/api/v1/items', {
		data: {
			content: {
				representations: [{ mimeType: 'text/markdown', text: `# ${nextTitle}\n\n![tracking](https://tracker.invalid/image.svg)` }],
			},
		},
	});
	await page.getByLabel('Search clipboard').fill(nextTitle);
	await page.locator('.item-row').filter({ hasText: nextTitle }).click();
	await expect(page.getByRole('button', { name: 'Load image' })).toBeVisible();
	await expect(page.locator('.markdown-preview img')).toHaveCount(0);
	expect(trackerRequests).toHaveLength(1);
});

test('production assets, Service Binding, WebSocket and sandbox work with real CSP', async ({ page, request }) => {
	const token = parseEnv(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')).LOCAL_API_BEARER_TOKEN;
	// This local browser fixture supplies the dev credential; the shipped client contains no token.
	await page.context().setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
	const suffix = Date.now().toString(36);
	const label = `Production HTML ${suffix}`;
	const result = await request.post('/api/v1/clipboards/default', {
		data: {
			content: {
				representations: [
					{ mimeType: 'text/plain', text: label },
					{ mimeType: 'text/html', text: `<h1>${label}</h1><script>parent.__clipboardXss=1</script>` },
				],
			},
			mutationId: crypto.randomUUID(),
		},
	});
	expect(result.ok()).toBe(true);
	const response = await page.goto('http://127.0.0.1:18788/');
	expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
	await page.locator('.item-row').filter({ hasText: label }).click();
	await expect(page.frameLocator('iframe[title="Sanitized HTML preview"]').getByRole('heading', { name: label })).toBeVisible();
	await expect(page.locator('.connection')).toHaveText('Live sync');
	await page.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect(page.getByRole('status')).toContainText('Copied to clipboard');
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(label);
	expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__clipboardXss)).toBeUndefined();
	await view(page, 'View source');
	await expect(page.locator('.cm-content')).toContainText(label);
	await view(page, 'Show preview');
	await page.getByRole('banner').getByRole('button', { name: 'New item', exact: true }).click();
	await page.getByLabel('Content format').selectOption('markdown');
	await page.getByLabel('CONTENT', { exact: true }).fill(`# Markdown in production ${suffix}\n\n**Rendered safely.**`);
	await page.getByRole('button', { name: 'Save item', exact: true }).click();
	await expect(page.locator('.markdown-preview strong')).toHaveText('Rendered safely.');
});
