import { useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { inferLanguage, languages, type Language } from '../lib/content';

const highlight = HighlightStyle.define([
	{ tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier], color: '#b8570c' },
	{ tag: [tags.string, tags.regexp], color: '#616161' },
	{ tag: [tags.number, tags.bool, tags.null], color: '#616161' },
	{ tag: [tags.comment, tags.meta], color: '#949494', fontStyle: 'italic' },
	{ tag: [tags.typeName, tags.className, tags.function(tags.variableName)], color: '#262626', fontWeight: '500' },
]);
const theme = EditorView.theme({
	'&': { backgroundColor: 'transparent', color: '#262626', height: '100%' },
	'.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '1.9' },
	'.cm-content': { padding: '24px 0', caretColor: 'transparent' },
	'.cm-line': { padding: '0 24px 0 16px' },
	'.cm-gutters': { backgroundColor: 'transparent', color: '#b5b5b5', border: 'none', padding: '0 0 0 12px', fontSize: '12px' },
	'.cm-gutterElement': { padding: '0 8px 0 6px' },
	'&.cm-focused': { outline: 'none' },
	'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#fde2c8' },
});

async function extension(language: Language): Promise<Extension> {
	switch (language) {
		case 'typescript':
			return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
		case 'javascript':
			return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
		case 'json':
			return (await import('@codemirror/lang-json')).json();
		case 'markdown':
			return (await import('@codemirror/lang-markdown')).markdown();
		case 'python':
			return (await import('@codemirror/lang-python')).python();
		case 'html':
			return (await import('@codemirror/lang-html')).html();
		case 'css':
			return (await import('@codemirror/lang-css')).css();
		case 'yaml':
			return (await import('@codemirror/lang-yaml')).yaml();
		case 'shell':
			return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
		case 'sql':
			return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/sql')).standardSQL);
		default:
			return [];
	}
}

export default function CodeEditor({
	text,
	language = 'text',
	wrap = true,
	compact = false,
}: {
	text: string;
	language?: Language;
	wrap?: boolean;
	compact?: boolean;
}) {
	const container = useRef<HTMLDivElement>(null);
	const resolved = language === 'auto' ? inferLanguage('', '', text) : language;
	useLayoutEffect(() => {
		if (!container.current) return;
		const languageExtension = new Compartment();
		let disposed = false;
		const view = new EditorView({
			parent: container.current,
			state: EditorState.create({
				doc: text,
				extensions: [
					lineNumbers(),
					highlightSpecialChars(),
					drawSelection(),
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ 'aria-label': 'Read-only code preview', tabindex: '0' }),
					theme,
					syntaxHighlighting(highlight),
					languageExtension.of([]),
					...(wrap ? [EditorView.lineWrapping] : []),
				],
			}),
		});
		void extension(resolved)
			.then((support) => {
				if (!disposed) view.dispatch({ effects: languageExtension.reconfigure(support) });
			})
			.catch(() => {
				/* Keep the literal, read-only source usable if a language chunk fails to load. */
			});
		return () => {
			disposed = true;
			view.destroy();
		};
	}, [text, resolved, wrap]);
	return (
		<div className={compact ? 'code-preview code-preview-compact' : 'code-preview'}>
			{compact && <div className="code-label">{languages.find((value) => value.value === resolved)?.label ?? 'Code'}</div>}
			<div ref={container} className="code-mount" />
		</div>
	);
}
