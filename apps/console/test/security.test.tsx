import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MarkdownPreview } from '../src/components/MarkdownRenderer';
import { TextPreview } from '../src/components/Previews';
import CodeEditor from '../src/components/CodeEditor';
import { safeImageUrl, safeLink, sanitizedHtmlDocument } from '../src/lib/security';

afterEach(cleanup);
describe('untrusted clipboard previews', () => {
	it('allows explicit web/mail links and rejects executable and ambiguous URLs', () => {
		for (const url of [
			'javascript:alert(1)',
			'JaVaScRiPt:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox(1)',
			'//example.com/image.png',
			'/api/v1/files/private/content',
			'https://user:password@example.com/',
		])
			expect(safeLink(url)).toBe('');
		expect(safeLink('https://example.com/docs')).toBe('https://example.com/docs');
		expect(safeLink('mailto:a@example.com')).toBe('mailto:a@example.com');
		expect(safeLink('#section')).toBe('#section');
		for (const url of ['data:image/svg+xml,<svg onload=alert(1)>', 'blob:https://example.com/a', 'mailto:a@example.com', '#id'])
			expect(safeImageUrl(url)).toBe('');
	});
	it('removes active HTML, SVG, event handlers, URLs, and DOM-clobbering names', () => {
		const attacks = `<h1>Readable title</h1><script>parent.pwned=1</script><img src="https://tracker.example/pixel" onerror="parent.pwned=2"><svg onload="parent.pwned=3"><a xlink:href="javascript:alert(1)">SVG</a></svg><iframe srcdoc="<script>alert(1)</script>"></iframe><form action="https://evil.example"><input name="location"></form><a id="location" name="location" href="javascript:alert(1)" style="background:url(https://tracker.example)">Click</a><math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">`;
		const doc = new DOMParser().parseFromString(sanitizedHtmlDocument(attacks), 'text/html');
		expect(doc.body.textContent).toContain('Readable title');
		expect(doc.body.querySelector('script,style,svg,math,iframe,form,input,object,embed')).toBeNull();
		for (const element of doc.body.querySelectorAll('*'))
			for (const attribute of element.attributes) expect(attribute.name).not.toMatch(/^(on|src|href|style|id$|name$|xlink|action)/i);
		expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'none'");
	});
	it('isolates sanitized HTML in an iframe without sandbox permissions', () => {
		const { container } = render(<TextPreview text="<p>Hello</p><script>alert(1)</script>" mime="text/html" />);
		const frame = container.querySelector('iframe')!;
		expect(frame.getAttribute('sandbox')).toBe('');
		expect(frame.srcdoc).toContain('<p>Hello</p>');
		expect(frame.srcdoc).not.toContain('<script>');
		expect(container.querySelector('p')).toBeNull();
	});
	it('renders Markdown without raw HTML or executable links', () => {
		const { container } = render(
			<MarkdownPreview
				text={
					'# A safe heading\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [good](https://example.com)\n\n![bad](data:image/svg+xml;base64,PHN2Zz4=)'
				}
			/>,
		);
		expect(screen.getByRole('heading', { name: 'A safe heading' })).toBeTruthy();
		expect(container.querySelector('script,img,iframe,svg[onload]')).toBeNull();
		expect(screen.getByRole('link', { name: 'good' }).getAttribute('rel')).toBe('noopener noreferrer');
		expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
	});
	it('defers remote Markdown images until the user chooses to load one', () => {
		const { container } = render(<MarkdownPreview text="![A diagram](https://example.com/image.png)" />);
		expect(container.querySelector('img')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Load image' }));
		expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/image.png');
		expect(container.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
	});
	it('keeps code as literal text and disables editor writes', () => {
		const source = '<img src=x onerror=alert(1)>';
		const { container } = render(<CodeEditor text={source} language="html" />);
		const editor = container.querySelector('.cm-editor') as HTMLElement;
		const view = EditorView.findFromDOM(editor)!;
		expect(view.state.doc.toString()).toBe(source);
		expect(view.state.facet(EditorState.readOnly)).toBe(true);
		expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
		expect(container.querySelector('img')).toBeNull();
	});
});
