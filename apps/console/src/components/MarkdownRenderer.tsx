import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Image } from 'lucide-react';
import { CodePreview } from './CodePreview';
import { languages, type Language } from '../lib/content';
import { safeImageUrl, safeLink } from '../lib/security';

export function MarkdownPreview({ text }: { text: string }) {
	const [allowedImages, setAllowedImages] = useState<Set<string>>(new Set());
	return (
		<div className="markdown-preview">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				urlTransform={(url, key) => (key === 'src' ? safeImageUrl(url) : safeLink(url))}
				components={{
					a: ({ href, children }) =>
						href ? (
							<a href={safeLink(href)} target="_blank" rel="noopener noreferrer">
								{children}
							</a>
						) : (
							<span>{children}</span>
						),
					img: ({ src, alt }) => {
						const url = typeof src === 'string' ? safeImageUrl(src) : '';
						if (url && allowedImages.has(url))
							return <img src={url} alt={alt ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
						return (
							<span className="external-image">
								<Image size={18} />
								<span>{alt || 'External image'}</span>
								{url && (
									<button type="button" onClick={() => setAllowedImages((previous) => new Set([...previous, url]))}>
										Load image
									</button>
								)}
							</span>
						);
					},
					pre: ({ children }) => <div className="markdown-code">{children}</div>,
					code: ({ children, className }) => {
						const value = String(children);
						const hint = className?.replace(/^language-/, '') ?? '';
						const aliases: Record<string, Language> = {
							js: 'javascript',
							ts: 'typescript',
							tsx: 'typescript',
							jsx: 'javascript',
							py: 'python',
							bash: 'shell',
							sh: 'shell',
							yml: 'yaml',
							md: 'markdown',
						};
						const language = aliases[hint] ?? (languages.some((language) => language.value === hint) ? (hint as Language) : 'auto');
						return className || value.endsWith('\n') ? (
							<CodePreview text={value.replace(/\n$/, '')} language={language} compact />
						) : (
							<code>{children}</code>
						);
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
