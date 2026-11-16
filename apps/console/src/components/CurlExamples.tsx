import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { CliConfig } from '../../../../shared/contracts';
import { api } from '../lib/api';
import { clipboardCommands } from '../lib/curl';

export function CurlExamples() {
	const [config, setConfig] = useState<CliConfig | null>(null);
	const [error, setError] = useState('');
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const abort = new AbortController();
		setError('');
		api.cliConfig(abort.signal)
			.then((result) => {
				if (!abort.signal.aborted) setConfig(result);
			})
			.catch((error) => {
				if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load curl commands.');
			});
		return () => abort.abort();
	}, [attempt]);
	const commands = config ? clipboardCommands(config) : null;
	return (
		<div className="composer-curl-body">
			<p className="curl-intro">Send text or a file directly to your clipboard.</p>
			{error && (
				<div className="curl-error" role="alert">
					<p>{error}</p>
					{!config && (
						<button type="button" className="text-action" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
					)}
				</div>
			)}
			{!commands && !error && (
				<p className="curl-loading" role="status"><LoaderCircle size={15} className="spin" />Loading commands…</p>
			)}
			{commands &&
				(['text', 'file'] as const).map((kind) => (
					<section className="curl-example" key={kind} aria-label={`${kind === 'text' ? 'Text' : 'File'} curl example`}>
						<h3 className="curl-example-heading">{kind === 'text' ? 'Send text' : 'Send a file'}</h3>
						<pre><code>{commands[kind]}</code></pre>
						<p className="curl-caption">
							{kind === 'text' ? 'Replace Hello from curl with your text.' : 'Replace example.txt with the file name and ./example.txt with its path.'}
						</p>
					</section>
				))}
		</div>
	);
}
