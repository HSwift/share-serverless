import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { clipboardCommands, shellQuote } from '../src/lib/curl';

describe('terminal commands', () => {
	it('keeps shell metacharacters literal in tokens', () => {
		const apiToken = `test-'"-$HOME-$(printf injected)-\`printf injected\`-<img src=x>`;
		const command = clipboardCommands({ apiBaseUrl: 'https://api.example.com', apiToken }).text;
		const result = spawnSync('/bin/sh', ['-c', `curl() { printf '%s\\0' "$@"; };\n${command}`], { encoding: 'utf8' });
		expect(result.status).toBe(0);
		const args = result.stdout.split('\0');
		expect(args).toContain('https://api.example.com/api/v1/clipboards/default/content');
		expect(args).toContain(`Authorization: Bearer ${apiToken}`);
		expect(args[args.indexOf('--data-raw') + 1]).toBe('Hello from curl');
	});
	it('quotes file paths containing spaces, quotes, Unicode and command substitutions', () => {
		const path = `./测试 ' $HOME $(printf injected).txt`;
		const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(path)}`], { encoding: 'utf8' });
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(path);
	});
	it('uses one curl call per command without a shell pipeline or JSON processor', () => {
		const commands = clipboardCommands({ apiBaseUrl: 'https://another-api.example.com/', apiToken: 'test-token' });
		for (const command of Object.values(commands)) {
			expect(command).not.toMatch(/[\n|]|\$\(|\bjq\b/);
			const result = spawnSync('/bin/sh', ['-c', `curl() { printf '%s\\0' "$@"; };\n${command}`], { encoding: 'utf8' });
			expect(result.status).toBe(0);
			expect(result.stdout.split('\0')[1]).toMatch(/^https:\/\/another-api\.example\.com\/api\/v1\/clipboards\/default\/content/);
		}
	});
});
