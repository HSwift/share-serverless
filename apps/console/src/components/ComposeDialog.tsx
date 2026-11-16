import { useEffect, useRef, useState, type FormEvent } from 'react';
import { File as FileIcon, FileUp, LoaderCircle, X } from 'lucide-react';
import type { Content, FileDescriptor, Limits } from '../../../../shared/contracts';
import { api } from '../lib/api';
import { formatBytes, languages, rasterTypes, textContent, type Language } from '../lib/content';
import { Modal } from './Dialogs';
import { CurlExamples } from './CurlExamples';

export interface ComposerDraft {
	text?: string;
	files?: File[];
}
export function ComposeDialog({
	draft,
	onClose,
	onCreated,
	limits,
}: {
	draft: ComposerDraft | null;
	onClose: () => void;
	onCreated: (id: string) => void;
	limits: Limits;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Modal
			open={draft !== null}
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
			title="New clipboard item"
			description="Save text or upload files to your clipboard."
			className="compose-dialog"
		>
			{draft && <ComposerForm draft={draft} busy={busy} setBusy={setBusy} onCancel={onClose} onCreated={onCreated} limits={limits} />}
		</Modal>
	);
}

function ComposerForm({
	draft,
	busy,
	setBusy,
	onCancel,
	onCreated,
	limits,
}: {
	draft: ComposerDraft;
	busy: boolean;
	setBusy: (busy: boolean) => void;
	onCancel: () => void;
	onCreated: (id: string) => void;
	limits: Limits;
}) {
	const [text, setText] = useState(draft.text ?? '');
	const [files, setFiles] = useState<File[]>(draft.files ?? []);
	const [tab, setTab] = useState<'text' | 'files' | 'curl'>(draft.files?.length ? 'files' : 'text');
	const [language, setLanguage] = useState<Language>('text');
	const [progress, setProgress] = useState('');
	const [error, setError] = useState('');
	const uploaded = useRef(new Map<File, FileDescriptor>());
	const mutation = useRef({ payload: '', id: '' });
	const fileInput = useRef<HTMLInputElement>(null);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const uploadZone = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		(tab === 'text' ? textarea.current : uploadZone.current)?.focus();
	}, [tab]);
	function addFiles(incoming: File[]) {
		const combined = [...files, ...incoming];
		if (combined.length > limits.maxFiles) {
			setError(`Choose up to ${limits.maxFiles} files per item.`);
			return;
		}
		const tooLarge = combined.find((file) => file.size > limits.maxUploadBytes);
		if (tooLarge) {
			setError(`${tooLarge.name} exceeds the ${formatBytes(limits.maxUploadBytes)} upload limit.`);
			return;
		}
		setError('');
		setFiles(combined);
	}
	async function save(event: FormEvent) {
		event.preventDefault();
		if (busy || tab === 'curl') return;
		setBusy(true);
		setError('');
		try {
			let content: Content | { text: string };
			if (tab === 'files') {
				if (!files.length) throw new Error('Choose at least one file.');
				if (files.length > limits.maxFiles || files.some((file) => file.size > limits.maxUploadBytes))
					throw new Error('One or more files exceed the upload limits.');
				const completed: FileDescriptor[] = [];
				for (const [index, file] of files.entries()) {
					setProgress(`Uploading ${index + 1} of ${files.length}…`);
					let saved = uploaded.current.get(file);
					if (!saved) {
						saved = await api.upload(file);
						uploaded.current.set(file, saved);
					}
					completed.push(saved);
				}
				content = {
					files: completed.map((file) => file.id),
					representations:
						completed.length === 1 && rasterTypes.has(completed[0].mimeType)
							? [{ mimeType: completed[0].mimeType, fileId: completed[0].id }]
							: [],
				};
			} else {
				if (!text.trim()) throw new Error('Add some text before saving.');
				content = textContent(text, language);
				if (new TextEncoder().encode(JSON.stringify(content)).byteLength > limits.maxInlineBytes - 128)
					throw new Error('This item is too large. Upload it as a file instead.');
			}
			setProgress('Saving item…');
			const payload = JSON.stringify(content);
			if (mutation.current.payload !== payload) mutation.current = { payload, id: crypto.randomUUID() };
			const result = await api.create(content, mutation.current.id);
			if (result.state.itemId) onCreated(result.state.itemId);
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Could not save this item. Please try again.');
		} finally {
			setBusy(false);
			setProgress('');
		}
	}

	return (
		<form
			className="compose-form"
			aria-label="New clipboard item"
			onSubmit={save}
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes('Files')) {
					event.preventDefault();
					event.stopPropagation();
				}
			}}
			onDrop={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!busy && event.dataTransfer.files.length) {
					addFiles(Array.from(event.dataTransfer.files));
					setTab('files');
				}
			}}
			onPaste={(event) => {
				if (!busy && event.clipboardData.files.length) {
					event.preventDefault();
					event.stopPropagation();
					addFiles(Array.from(event.clipboardData.files));
					setTab('files');
				}
			}}
		>
			<div className="composer-controls">
				<div className="composer-tabs" role="tablist" aria-label="Item type">
					<button type="button" role="tab" aria-selected={tab === 'text'} onClick={() => setTab('text')} disabled={busy}>
						Text & code
					</button>
					<button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')} disabled={busy}>
						Files
					</button>
					<button type="button" role="tab" aria-selected={tab === 'curl'} onClick={() => setTab('curl')} disabled={busy}>
						curl
					</button>
				</div>
				{tab === 'text' && (
					<select
						className="composer-format"
						aria-label="Content format"
						value={language}
						onChange={(event) => setLanguage(event.target.value as Language)}
						disabled={busy}
					>
						{languages.map((language) => (
							<option key={language.value} value={language.value}>
								{language.label}
							</option>
						))}
					</select>
				)}
			</div>
			{tab === 'text' ? (
				<div className="composer-text-body">
					<label htmlFor="new-content" className="sr-only">
						CONTENT
					</label>
					<textarea
						ref={textarea}
						id="new-content"
						className="compose-textarea"
						placeholder="Paste text, Markdown, or code here…"
						value={text}
						onChange={(event) => setText(event.target.value)}
						disabled={busy}
						spellCheck={false}
					/>
				</div>
			) : tab === 'curl' ? (
				<CurlExamples />
			) : (
				<div className="composer-files-body">
					<input
						ref={fileInput}
						type="file"
						multiple
						hidden
						disabled={busy}
						onChange={(event) => {
							addFiles(Array.from(event.target.files ?? []));
							event.target.value = '';
						}}
					/>
					<button ref={uploadZone} type="button" className="upload-zone" onClick={() => fileInput.current?.click()} disabled={busy}>
						<FileUp size={25} />
						<strong>Choose files or drop them here</strong>
						<span>Up to {formatBytes(limits.maxUploadBytes)} per file</span>
					</button>
					{files.length > 0 && (
						<div className="upload-list">
							{files.map((file, index) => (
								<div className="upload-row" key={`${file.name}-${index}`}>
									<FileIcon size={17} />
									<span>{file.name}</span>
									<small>{formatBytes(file.size)}</small>
									<button
										type="button"
										className="icon-button"
										aria-label={`Remove ${file.name}`}
										onClick={() => setFiles(files.filter((_, entry) => entry !== index))}
										disabled={busy}
									>
										<X size={15} />
									</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-footer">
				<span className="muted" role={busy ? 'status' : undefined}>
					{busy ? progress || 'Preparing…' : ''}
				</span>
				<button type="button" className="button secondary" onClick={onCancel} disabled={busy}>
					{tab === 'curl' ? 'Done' : 'Cancel'}
				</button>
				{tab !== 'curl' && (
					<button type="submit" className="button primary" disabled={busy}>
						{busy && <LoaderCircle className="spin" size={14} />}
						{busy ? 'Saving…' : 'Save item'}
					</button>
				)}
			</div>
		</form>
	);
}
