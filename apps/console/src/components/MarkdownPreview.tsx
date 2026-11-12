import { lazy, Suspense, type ComponentType } from 'react';

let loaded: ComponentType<{ text: string }> | undefined;
let pending: Promise<{ default: ComponentType<{ text: string }> }> | undefined;
export function preloadMarkdownPreview() {
	return (pending ??= import('./MarkdownRenderer').then((module) => {
		loaded = module.MarkdownPreview;
		return { default: loaded };
	}));
}
const LazyMarkdownRenderer = lazy(preloadMarkdownPreview);
export function MarkdownPreview({ text }: { text: string }) {
	const MarkdownRenderer = loaded ?? LazyMarkdownRenderer;
	return (
		<Suspense fallback={<div className="plain-preview">{text}</div>}>
			<MarkdownRenderer text={text} />
		</Suspense>
	);
}
