import { lazy, Suspense, type ComponentType } from 'react';
import type { Language } from '../lib/content';

type Props = { text: string; language?: Language; wrap?: boolean; compact?: boolean };
let loaded: ComponentType<Props> | undefined;
let pending: Promise<{ default: ComponentType<Props> }> | undefined;
export function preloadCodePreview() {
	return (pending ??= import('./CodeEditor').then((module) => {
		loaded = module.default;
		return module;
	}));
}
const LazyCodeEditor = lazy(preloadCodePreview);
export function CodePreview(props: Props) {
	const CodeEditor = loaded ?? LazyCodeEditor;
	return (
		<Suspense fallback={<pre className="plain-preview mono">{props.text}</pre>}>
			<CodeEditor {...props} />
		</Suspense>
	);
}
