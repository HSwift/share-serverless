import { useEffect, useState } from 'react';
import { Download, File, FileText, ImageOff, LoaderCircle } from 'lucide-react';
import type { FileDescriptor, ItemResult } from '../../../../shared/contracts';
import { fileUrl, textFile } from '../lib/api';
import { formatBytes, inferLanguage, isTextFile, primaryText, rasterTypes, type Language } from '../lib/content';
import { sanitizedHtmlDocument } from '../lib/security';
import { CodePreview, preloadCodePreview } from './CodePreview';
import { MarkdownPreview, preloadMarkdownPreview } from './MarkdownPreview';

async function prepareTextPreview(text: string, mime: string, name = '') {
	const language = inferLanguage(mime, name, text);
	if (language === 'markdown') {
		await Promise.all([preloadMarkdownPreview(), ...(/^(?:[ \t]*(?:`{3}|~{3})| {4}|\t)/m.test(text) ? [preloadCodePreview()] : [])]);
	} else if (language !== 'text' && !(mime === 'text/html' && language === 'html')) {
		await preloadCodePreview();
	}
}

export async function prepareItemPreview(result: ItemResult) {
	const text = primaryText(result.item.content);
	if (text?.text !== undefined) await prepareTextPreview(text.text, text.mimeType);
	else await Promise.all(result.files.filter(isTextFile).map((file) => prepareTextPreview('', file.mimeType, file.name)));
}

export function TextPreview({
	text,
	mime = 'text/plain',
	name = '',
	source = false,
	language = 'auto',
	wrap = true,
}: {
	text: string;
	mime?: string;
	name?: string;
	source?: boolean;
	language?: Language;
	wrap?: boolean;
}) {
	const inferred = language === 'auto' ? inferLanguage(mime, name, text) : language;
	if (!source && inferred === 'markdown') return <MarkdownPreview text={text} />;
	if (!source && mime === 'text/html' && inferred === 'html')
		return (
			<iframe
				className="html-preview"
				title="Sanitized HTML preview"
				sandbox=""
				referrerPolicy="no-referrer"
				srcDoc={sanitizedHtmlDocument(text)}
			/>
		);
	if (!source && inferred === 'text')
		return (
			<div className="plain-preview" style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>
				{text || <span className="muted">This item contains an empty string.</span>}
			</div>
		);
	return <CodePreview text={text} language={inferred} wrap={wrap} />;
}

function ImagePreview({ file }: { file: FileDescriptor }) {
	const [url, setUrl] = useState('');
	const [error, setError] = useState('');
	useEffect(() => {
		const abort = new AbortController();
		let objectUrl = '';
		setUrl('');
		setError('');
		if (!file.available || (file.size ?? 0) > 20 * 1024 * 1024) {
			setError(file.available ? 'Download this image to view it at its original size.' : 'This image is no longer available.');
			return;
		}
		fetch(fileUrl(file.id), { signal: abort.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error('This image is no longer available.');
				const blob = await response.blob();
				if (abort.signal.aborted) return;
				objectUrl = URL.createObjectURL(new Blob([blob], { type: file.mimeType }));
				setUrl(objectUrl);
			})
			.catch((error) => {
				if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load this image.');
			});
		return () => {
			abort.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [file.id, file.available, file.mimeType, file.size]);
	if (error)
		return (
			<div className="preview-empty">
				<ImageOff size={30} />
				<h3>Image unavailable</h3>
				<p>{error}</p>
			</div>
		);
	return (
		<div className="image-preview">
			{url ? (
				<img src={url} alt={file.name} onError={() => setError('This file could not be decoded as an image.')} />
			) : (
				<LoaderCircle className="spin" size={22} />
			)}
		</div>
	);
}

export function FilePreview({
	file,
	source,
	language,
	wrap,
}: {
	file: FileDescriptor;
	source: boolean;
	language: Language;
	wrap: boolean;
}) {
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState('');
	const textual = isTextFile(file);
	useEffect(() => {
		setText(null);
		setError('');
		if (!textual || !file.available) return;
		const abort = new AbortController();
		if (file.size === 0) {
			setText('');
			return;
		}
		textFile(file, abort.signal)
			.then(async (value) => {
				await prepareTextPreview(value, file.mimeType, file.name);
				if (!abort.signal.aborted) setText(value);
			})
			.catch((error) => {
				if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'Could not preview this file.');
			});
		return () => abort.abort();
	}, [file.id, file.available, file.size, textual]);
	if (!file.available)
		return (
			<div className="preview-empty">
				<File size={30} />
				<h3>File no longer available</h3>
				<p>The original file has been deleted.</p>
			</div>
		);
	if (textual)
		return (
			<>
				{file.size !== null && file.size > 262144 && (
					<div className="preview-notice">Showing the first 256 KB. Download the file to read all of it.</div>
				)}
				{error ? (
					<div className="preview-empty">
						<FileText size={28} />
						<p>{error}</p>
					</div>
				) : text === null ? (
					<div className="preview-empty">
						<LoaderCircle className="spin" size={22} />
						<p>Loading preview…</p>
					</div>
				) : (
					<TextPreview text={text} mime={file.mimeType} name={file.name} source={source} language={language} wrap={wrap} />
				)}
			</>
		);
	if (!source && rasterTypes.has(file.mimeType)) return <ImagePreview file={file} />;
	if (!source && ['video/mp4', 'video/webm'].includes(file.mimeType))
		return (
			<div className="media-preview">
				<video controls preload="metadata" src={fileUrl(file.id)}>
					Your browser cannot play this video.
				</video>
			</div>
		);
	if (!source && ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm'].includes(file.mimeType))
		return (
			<div className="media-preview">
				<audio controls preload="metadata" src={fileUrl(file.id)}>
					Your browser cannot play this audio.
				</audio>
			</div>
		);
	return (
		<div className="preview-empty">
			<div className="empty-file-icon">
				<File size={32} />
			</div>
			<h3>{file.name}</h3>
			<p>
				{file.mimeType} <span className="metadata-separator">·</span> {formatBytes(file.size)}
			</p>
			<p>{source ? 'Binary files do not have a text source.' : 'Download this file to open it in your preferred app.'}</p>
			<a className="button secondary" href={fileUrl(file.id)} download={file.name}>
				<Download size={15} />
				Download file
			</a>
		</div>
	);
}
