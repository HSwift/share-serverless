import type { CliConfig } from '../../../../shared/contracts';

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function clipboardCommands({ apiBaseUrl, apiToken }: CliConfig) {
	const base = new URL(apiBaseUrl).origin;
	const authorization = shellQuote(`Authorization: Bearer ${apiToken}`);
	const clipboard = `${base}/api/v1/clipboards/default/content`;
	return {
		text: `curl --fail-with-body ${shellQuote(clipboard)} -H ${authorization} -H 'Content-Type: text/plain' --data-raw 'Hello from curl'`,
		file: `curl --fail-with-body ${shellQuote(`${clipboard}?name=example.txt`)} -H ${authorization} -H 'Content-Type: application/octet-stream' --data-binary '@./example.txt'`,
	};
}
