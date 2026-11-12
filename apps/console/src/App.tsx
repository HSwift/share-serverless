import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ArrowLeft,
	Check,
	ChevronDown,
	Clipboard,
	Cloud,
	CloudUpload,
	Code2,
	Download,
	File as FileIcon,
	FileText,
	Image,
	LoaderCircle,
	MoreHorizontal,
	Plus,
	RefreshCw,
	Search,
	SlidersHorizontal,
	Text,
	X,
} from 'lucide-react';
import type { ClipboardState, ItemResult, ItemSummary, Limits } from '../../../shared/contracts';
import { api, fileUrl, type Filters } from './lib/api';
import { formatBytes, isTextFile, itemLabel, languages, primaryText, relativeTime, type Language } from './lib/content';
import { copyText, useClipboardEvents, useDebounced } from './lib/hooks';
import { ShareDialog } from './components/Dialogs';
import { ComposeDialog, type ComposerDraft } from './components/ComposeDialog';
import { FilePreview, prepareItemPreview, TextPreview } from './components/Previews';
import { closePopover, Popover } from './components/Popover';

const types = [
	{ value: 'all', label: 'All items' },
	{ value: 'text', label: 'Text' },
	{ value: 'image', label: 'Images' },
	{ value: 'files', label: 'Files' },
] as const;
const defaults: Limits = { maxUploadBytes: 104857600, maxInlineBytes: 65536, maxFiles: 20 };
const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Please try again.');
function ItemIcon({ item, size = 18 }: { item: ItemSummary; size?: number }) {
	return item.kind === 'image' ? (
		<Image size={size} />
	) : item.kind === 'files' ? (
		<FileIcon size={size} />
	) : ['Plain text', 'Markdown'].includes(itemLabel(item)) ? (
		<FileText size={size} />
	) : (
		<Code2 size={size} />
	);
}

export default function App() {
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebounced(query);
	const [type, setType] = useState<Filters['type']>('all');
	const [sort, setSort] = useState<Filters['sort']>('newest');
	const [period, setPeriod] = useState('any');
	const [refresh, setRefresh] = useState(0);
	const [items, setItems] = useState<ItemSummary[]>([]);
	const [total, setTotal] = useState(0);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [listError, setListError] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<ItemResult | null>(null);
	const [detailError, setDetailError] = useState('');
	const [mobileDetail, setMobileDetail] = useState(false);
	const [head, setHead] = useState<ClipboardState | null>(null);
	const [tab, setTab] = useState<'preview' | 'source' | 'details'>('preview');
	const [language, setLanguage] = useState<Language>('auto');
	const [wrap, setWrap] = useState(true);
	const [activeFile, setActiveFile] = useState<string | null>(null);
	const [draft, setDraft] = useState<ComposerDraft | null>(null);
	const [shareItem, setShareItem] = useState<ItemSummary | null>(null);
	const [limits, setLimits] = useState(defaults);
	const [settingCurrent, setSettingCurrent] = useState(false);
	const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
	const [dragging, setDragging] = useState(false);
	const toastTimer = useRef(0);
	const search = useRef<HTMLInputElement>(null);
	const previewCache = useRef(new Map<string, { result: ItemResult; loadedAt: number }>());
	const openAfterLoad = useRef<string | null>(null);
	const openItem = useCallback(
		(id: string) => {
			openAfterLoad.current = id;
			setSelectedId(id);
			if (detail?.item.id === id && !detailError) {
				openAfterLoad.current = null;
				setMobileDetail(true);
			}
		},
		[detail, detailError],
	);
	const beginDraft = useCallback((next: ComposerDraft = {}) => {
		setDraft(next);
	}, []);
	const lastFilters = useRef('');
	const preferredSelection = useRef<string | null>(null);
	const listGeneration = useRef(0);
	const reload = useCallback(() => setRefresh((value) => value + 1), []);
	const notify = useCallback((text: string, error = false) => {
		window.clearTimeout(toastTimer.current);
		setToast({ text, error });
		toastTimer.current = window.setTimeout(() => setToast(null), 4500);
	}, []);
	useEffect(() => () => window.clearTimeout(toastTimer.current), []);
	const updateHead = useCallback((state: ClipboardState) => {
		setHead((current) => (!current || state.revision >= current.revision ? state : current));
	}, []);
	const live = useClipboardEvents(updateHead, reload);
	const filters = useMemo<Filters>(() => {
		const date = new Date();
		if (period === 'today') date.setHours(0, 0, 0, 0);
		else if (period !== 'any') date.setDate(date.getDate() - Number(period));
		return { q: debouncedQuery, type, sort, since: period === 'any' ? '' : date.toISOString() };
	}, [debouncedQuery, type, sort, period]);

	useEffect(() => {
		api
			.config()
			.then(setLimits)
			.catch(() => {
				/* Uploads still use conservative server defaults. */
			});
	}, []);
	useEffect(() => {
		let disposed = false;
		api
			.head()
			.then((result) => {
				if (!disposed) updateHead(result.state);
			})
			.catch(() => {
				/* List errors provide session feedback. */
			});
		return () => {
			disposed = true;
		};
	}, [refresh, updateHead]);
	useEffect(() => {
		const abort = new AbortController();
		const generation = ++listGeneration.current;
		const key = JSON.stringify(filters);
		const changed = key !== lastFilters.current;
		lastFilters.current = key;
		setLoading(true);
		setListError('');
		setLoadingMore(false);
		api
			.items(filters, abort.signal)
			.then((result) => {
				if (generation !== listGeneration.current || abort.signal.aborted) return;
				setItems(result.items);
				setTotal(result.total);
				setCursor(result.nextCursor);
				const preferred = preferredSelection.current;
				preferredSelection.current = null;
				setSelectedId((current) => preferred ?? (changed || !current ? (result.items[0]?.id ?? null) : current));
			})
			.catch((error) => {
				if (!abort.signal.aborted) setListError(message(error));
			})
			.finally(() => {
				if (!abort.signal.aborted) setLoading(false);
			});
		return () => abort.abort();
	}, [filters, refresh]);
	useEffect(() => {
		setDetailError('');
		if (!selectedId) {
			setDetail(null);
			openAfterLoad.current = null;
			return;
		}
		const abort = new AbortController();
		const load = async () => {
			const cached = previewCache.current.get(selectedId);
			const fresh = cached && Date.now() - cached.loadedAt < 60000;
			const result = fresh ? cached.result : await api.item(selectedId, abort.signal);
			const loadedAt = fresh ? cached.loadedAt : Date.now();
			await prepareItemPreview(result);
			if (!abort.signal.aborted) {
				previewCache.current.delete(selectedId);
				previewCache.current.set(selectedId, { result, loadedAt });
				if (previewCache.current.size > 32) previewCache.current.delete(previewCache.current.keys().next().value!);
				setDetail(result);
				setTab('preview');
				setLanguage('auto');
				setActiveFile(primaryText(result.item.content) ? null : (result.files[0]?.id ?? null));
				if (openAfterLoad.current === selectedId) {
					openAfterLoad.current = null;
					setMobileDetail(true);
				}
			}
		};
		void load().catch((error) => {
			if (!abort.signal.aborted) {
				setDetail(null);
				setDetailError(message(error));
				if (openAfterLoad.current === selectedId) {
					openAfterLoad.current = null;
					setMobileDetail(true);
				}
			}
		});
		return () => abort.abort();
	}, [selectedId]);
	useEffect(() => {
		const keydown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
			if (event.key === '/') {
				event.preventDefault();
				search.current?.focus();
			}
		};
		const paste = (event: ClipboardEvent) => {
			const target = event.target as HTMLElement;
			if (draft || shareItem || target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
			const files = Array.from(event.clipboardData?.files ?? []);
			const text = event.clipboardData?.getData('text/plain');
			if (files.length || text) {
				event.preventDefault();
				beginDraft(files.length ? { files } : { text });
			}
		};
		window.addEventListener('keydown', keydown);
		window.addEventListener('paste', paste);
		return () => {
			window.removeEventListener('keydown', keydown);
			window.removeEventListener('paste', paste);
		};
	}, [draft, shareItem, beginDraft]);

	async function loadMore() {
		if (!cursor || loadingMore) return;
		const generation = listGeneration.current;
		setLoadingMore(true);
		try {
			const result = await api.items(filters, undefined, cursor);
			if (generation === listGeneration.current) {
				setItems((current) => [...current, ...result.items.filter((item) => !current.some((entry) => entry.id === item.id))]);
				setCursor(result.nextCursor);
			}
		} catch (error) {
			notify(message(error), true);
		} finally {
			if (generation === listGeneration.current) setLoadingMore(false);
		}
	}
	const text = detail ? primaryText(detail.item.content) : undefined;
	const file = detail?.files.find((file) => file.id === activeFile);
	const visibleItemId = detail?.item.id ?? selectedId;
	const opening = Boolean(selectedId && detail?.item.id !== selectedId && !detailError);
	const selected =
		items.find((item) => item.id === visibleItemId) ??
		(detail
			? ({
					id: detail.item.id,
					title: text?.text?.split('\n')[0] || detail.files[0]?.name || 'Clipboard item',
					preview: '',
					createdAt: detail.item.createdAt,
					kind: text ? 'text' : 'files',
					size: detail.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
					mimeTypes: detail.item.content.representations.map((rep) => rep.mimeType),
					files: detail.item.content.files,
					fileDetails: detail.files,
				} as ItemSummary)
			: undefined);
	const current = visibleItemId !== null && head?.itemId === visibleItemId;
	async function makeCurrent() {
		if (!detail || settingCurrent) return;
		setSettingCurrent(true);
		try {
			const latest = (await api.head()).state;
			const result = await api.setCurrent(detail.item.id, latest.revision);
			updateHead(result.state);
			notify('Current clipboard updated');
		} catch (error) {
			notify(message(error), true);
			reload();
		} finally {
			setSettingCurrent(false);
		}
	}
	async function copy() {
		try {
			if (!activeFile && text?.text !== undefined) {
				const plain = detail?.item.content.representations.find((rep) => rep.mimeType === 'text/plain' && rep.text !== undefined)?.text;
				await copyText(plain ?? text.text);
			} else if (file?.mimeType === 'image/png' && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
				const blob = fetch(fileUrl(file.id)).then(async (response) => {
					if (!response.ok) throw new Error('Could not load image.');
					return new Blob([await response.arrayBuffer()], { type: 'image/png' });
				});
				await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			} else throw new Error('Download this file to use it in another app.');
			notify('Copied to clipboard');
		} catch (error) {
			notify(message(error), true);
		}
	}
	function clearFilters() {
		setQuery('');
		setType('all');
		setPeriod('any');
	}
	const canCopy = (!activeFile && text?.text !== undefined) || (file?.mimeType === 'image/png' && file.available);
	return (
		<div
			className="app-shell"
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes('Files') && !draft && !shareItem) {
					event.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
			}}
			onDrop={(event) => {
				event.preventDefault();
				setDragging(false);
				if (!draft && !shareItem && event.dataTransfer.files.length) beginDraft({ files: Array.from(event.dataTransfer.files) });
			}}
		>
			<header className="app-header">
				<div className="header-inner">
					<a className="brand" href="/" aria-label="Share home">
						<span className="brand-mark">
							<Clipboard size={19} strokeWidth={1.8} />
						</span>
						<span>
							share<span className="brand-dot">.</span>
						</span>
					</a>
					<div className="header-actions">
						<span className={`connection ${live ? 'is-live' : ''}`} title={live ? 'Live sync' : 'Reconnecting'}>
							<span className="status-dot" />
							<span className="sr-only">{live ? 'Live sync' : 'Reconnecting'}</span>
						</span>
						<button className="button primary new-item-button" onClick={() => beginDraft()}>
							<Plus size={16} />
							<span>New item</span>
						</button>
					</div>
				</div>
			</header>
			<main className="main-content">
				<div className={`clipboard-workspace ${mobileDetail ? 'show-detail' : ''}`}>
					<aside className="library-panel" aria-label="Clipboard library">
						<div className="library-tools">
							<div className="search-field">
								<Search size={16} />
								<input
									ref={search}
									aria-label="Search clipboard"
									placeholder="Search…"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									maxLength={200}
								/>
								{query && (
									<button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}>
										<X size={14} />
									</button>
								)}
							</div>
							<button className="icon-button" aria-label="Refresh clipboard" title="Refresh clipboard" onClick={reload}>
								<RefreshCw size={16} className={loading ? 'spin' : ''} />
							</button>
							<Popover
								label="Filters"
								icon={<SlidersHorizontal size={16} />}
								active={type !== 'all' || period !== 'any' || sort !== 'newest'}
							>
								<div className="popover-heading">{total} items</div>
								<label className="popover-field">
									Type
									<select aria-label="Filter by type" value={type} onChange={(event) => setType(event.target.value as Filters['type'])}>
										{types.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</label>
								<label className="popover-field">
									Date
									<select aria-label="Filter by date" value={period} onChange={(event) => setPeriod(event.target.value)}>
										<option value="any">Any time</option>
										<option value="today">Today</option>
										<option value="7">Last 7 days</option>
										<option value="30">Last 30 days</option>
									</select>
								</label>
								<label className="popover-field">
									Sort
									<select aria-label="Sort items" value={sort} onChange={(event) => setSort(event.target.value as Filters['sort'])}>
										<option value="newest">Newest first</option>
										<option value="oldest">Oldest first</option>
									</select>
								</label>
								<div className="popover-divider" />
								{(query || type !== 'all' || period !== 'any' || sort !== 'newest') && (
									<button
										className="popover-action"
										onClick={(event) => {
											clearFilters();
											setSort('newest');
											closePopover(event.currentTarget);
										}}
									>
										Clear filters
									</button>
								)}
							</Popover>
						</div>
						<div className="item-list" aria-busy={loading}>
							{listError ? (
								<div className="list-empty" role="alert">
									<Cloud size={26} />
									<h3>Couldn’t load your clipboard</h3>
									<p>{listError}</p>
									<button className="button secondary" onClick={reload}>
										Try again
									</button>
								</div>
							) : loading && !items.length ? (
								<div className="list-skeleton" aria-label="Loading items">
									{[0, 1, 2, 3, 4].map((index) => (
										<div key={index}>
											<i />
											<span />
											<small />
										</div>
									))}
								</div>
							) : !items.length ? (
								<div className="list-empty">
									<Search size={28} />
									<h3>{query || type !== 'all' || period !== 'any' ? 'No matching items' : 'No items yet'}</h3>
									<p>
										{query || type !== 'all' || period !== 'any'
											? 'Try a different search or adjust your filters.'
											: 'Add text or drop a file here.'}
									</p>
									<button
										className="button secondary"
										onClick={query || type !== 'all' || period !== 'any' ? clearFilters : () => beginDraft()}
									>
										{query || type !== 'all' || period !== 'any' ? 'Clear filters' : 'Add your first item'}
									</button>
								</div>
							) : (
								items.map((item) => (
									<button
										key={item.id}
										className={`item-row ${item.id === selectedId ? 'selected' : ''}`}
										aria-current={item.id === selectedId ? 'true' : undefined}
										aria-busy={opening && item.id === selectedId}
										onClick={() => openItem(item.id)}
									>
										<div className="item-type-icon">
											<ItemIcon item={item} size={16} />
										</div>
										<div className="item-row-content">
											<div className="item-title-row">
												<strong>{item.title}</strong>
												{head?.itemId === item.id && <span className="current-dot" title="Current clipboard" />}
												{opening && item.id === selectedId ? (
													<LoaderCircle size={12} className="spin row-pending" aria-hidden="true" />
												) : (
													<time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
														{relativeTime(item.createdAt)}
													</time>
												)}
											</div>
											<p>{item.preview || item.fileDetails.map((file) => file.name).join(', ') || 'Empty text'}</p>
										</div>
									</button>
								))
							)}
							{cursor && !listError && (
								<button className="load-more" disabled={loadingMore || loading} onClick={() => void loadMore()}>
									{loadingMore ? <LoaderCircle className="spin" size={14} /> : <ChevronDown size={14} />}
									{loadingMore ? 'Loading…' : 'Load more items'}
								</button>
							)}
						</div>
					</aside>
					<section className="detail-panel" aria-label="Item preview">
						<button
							className="mobile-back"
							onClick={() => {
								openAfterLoad.current = null;
								setMobileDetail(false);
							}}
						>
							<ArrowLeft size={15} />
							All items
						</button>

						{!selectedId ? (
							<div className="detail-placeholder">
								<Clipboard size={27} strokeWidth={1.25} />
								<p>Select an item to preview</p>
							</div>
						) : detailError ? (
							<div className="preview-empty" role="alert">
								<h3>Couldn’t open this item</h3>
								<p>{detailError}</p>
								<button
									className="button secondary"
									onClick={() => {
										setSelectedId(null);
										reload();
									}}
								>
									Back to library
								</button>
							</div>
						) : !detail || !selected ? (
							<div className="preview-empty">
								<LoaderCircle className="spin" size={24} />
								<p>Opening item…</p>
							</div>
						) : (
							<>
								<div className="detail-heading">
									<div className="detail-title">
										<h2 title={selected.title}>{selected.title}</h2>
									</div>
									<div className="detail-actions">
										{file?.available && (
											<a
												className="icon-button"
												href={fileUrl(file.id)}
												download={file.name}
												aria-label={`Download ${file.name}`}
												title="Download"
											>
												<Download size={16} />
											</a>
										)}
										{canCopy && (
											<button className="text-action" onClick={() => void copy()}>
												Copy
											</button>
										)}
										<button className="text-action" onClick={() => setShareItem(selected)}>
											Share
										</button>
										<Popover key={visibleItemId} label="Item options" icon={<MoreHorizontal size={18} />}>
											<button
												className="popover-action"
												onClick={(event) => {
													setTab(tab === 'source' ? 'preview' : 'source');
													closePopover(event.currentTarget);
												}}
											>
												{tab === 'source' ? 'Show preview' : 'View source'}
											</button>
											<button
												className="popover-action"
												onClick={(event) => {
													setTab(tab === 'details' ? 'preview' : 'details');
													closePopover(event.currentTarget);
												}}
											>
												{tab === 'details' ? 'Show preview' : 'Item details'}
											</button>
											<button
												className="popover-action"
												disabled={current || settingCurrent}
												onClick={(event) => {
													void makeCurrent();
													closePopover(event.currentTarget);
												}}
											>
												{current ? <Check size={14} /> : <CloudUpload size={14} />}
												{current ? 'Current clipboard' : 'Set as current clipboard'}
											</button>
											{(text || (file && isTextFile(file))) && (
												<>
													<div className="popover-divider" />
													<label className="popover-field">
														Language
														<select
															aria-label="Preview language"
															value={language}
															onChange={(event) => setLanguage(event.target.value as Language)}
														>
															<option value="auto">Auto detect</option>
															{languages.map((language) => (
																<option key={language.value} value={language.value}>
																	{language.label}
																</option>
															))}
														</select>
													</label>
													<label className="popover-checkbox">
														<span>Wrap lines</span>
														<input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
													</label>
												</>
											)}
										</Popover>
									</div>
								</div>
								{tab !== 'details' && (detail.files.length > 1 || (text && detail.files.length > 0)) && (
									<div className="attachment-tabs" aria-label="Item contents">
										{text && (
											<button className={!activeFile ? 'active' : ''} onClick={() => setActiveFile(null)}>
												<Text size={14} />
												Text
											</button>
										)}
										{detail.files.map((file) => (
											<button
												key={file.id}
												className={activeFile === file.id ? 'active' : ''}
												onClick={() => setActiveFile(file.id)}
												title={file.name}
											>
												<FileIcon size={13} />
												<span>{file.name}</span>
											</button>
										))}
									</div>
								)}
								<div key={visibleItemId} className={`preview-body ${tab === 'details' ? 'show-metadata' : ''}`}>
									{tab === 'details' ? (
										<div className="metadata-content">
											<h3>About this item</h3>
											<dl>
												<div>
													<dt>Created</dt>
													<dd>{new Date(detail.item.createdAt).toLocaleString('en', { dateStyle: 'long', timeStyle: 'short' })}</dd>
												</div>
												<div>
													<dt>Content type</dt>
													<dd>{itemLabel(selected)}</dd>
												</div>
												<div>
													<dt>Size</dt>
													<dd>{formatBytes(selected.size)}</dd>
												</div>
												<div>
													<dt>Formats</dt>
													<dd>{selected.mimeTypes.join(', ') || 'Files'}</dd>
												</div>
												<div>
													<dt>Item ID</dt>
													<dd className="mono item-id">{detail.item.id}</dd>
												</div>
											</dl>
											{detail.files.length > 0 && (
												<>
													<h3 className="attachments-heading">
														Attachments <span>{detail.files.length}</span>
													</h3>
													<div className="metadata-files">
														{detail.files.map((file) => (
															<div key={file.id}>
																<FileIcon size={18} />
																<span>
																	<strong>{file.name}</strong>
																	<small>
																		{file.mimeType} · {formatBytes(file.size)}
																	</small>
																</span>
																{file.available && (
																	<a
																		className="icon-button"
																		href={fileUrl(file.id)}
																		download={file.name}
																		aria-label={`Download ${file.name}`}
																	>
																		<Download size={16} />
																	</a>
																)}
															</div>
														))}
													</div>
												</>
											)}
										</div>
									) : file ? (
										<FilePreview key={file.id} file={file} source={tab === 'source'} language={language} wrap={wrap} />
									) : text?.text !== undefined ? (
										<TextPreview text={text.text} mime={text.mimeType} source={tab === 'source'} language={language} wrap={wrap} />
									) : (
										<div className="preview-empty">
											<FileIcon size={30} />
											<p>Select an attachment to preview it.</p>
										</div>
									)}
								</div>
							</>
						)}
					</section>
				</div>
			</main>
			<ComposeDialog
				draft={draft}
				onClose={() => setDraft(null)}
				limits={limits}
				onCreated={(id) => {
					setDraft(null);
					preferredSelection.current = id;
					clearFilters();
					setSort('newest');
					openItem(id);
					reload();
					notify('Item saved to your clipboard');
				}}
			/>
			<ShareDialog item={shareItem} onClose={() => setShareItem(null)} notify={notify} />
			{toast && (
				<div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>
					{toast.error ? <X size={16} /> : <Check size={16} />}
					<span>{toast.text}</span>
					<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}>
						<X size={14} />
					</button>
				</div>
			)}
			{dragging && (
				<div className="drop-overlay">
					<div>
						<CloudUpload size={35} />
						<h2>Drop files to your clipboard</h2>
						<p>They’ll be ready to save as a new item.</p>
					</div>
				</div>
			)}
		</div>
	);
}
