import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCheck, Copy, Link, LoaderCircle, X } from 'lucide-react';
import type { ItemSummary, Share } from '../../../../shared/contracts';
import { api } from '../lib/api';
import { formatBytes } from '../lib/content';
import { copyText } from '../lib/hooks';

export function Modal({
	open,
	onOpenChange,
	title,
	description,
	children,
	className = '',
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay" />
				<Dialog.Content className={`dialog-content ${className}`}>
					<div className="dialog-heading">
						<div>
							<Dialog.Title>{title}</Dialog.Title>
							<Dialog.Description>{description}</Dialog.Description>
						</div>
						<Dialog.Close className="icon-button" aria-label="Close dialog">
							<X size={18} />
						</Dialog.Close>
					</div>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function ShareDialog({
	item,
	onClose,
	notify,
}: {
	item: ItemSummary | null;
	onClose: () => void;
	notify: (text: string, error?: boolean) => void;
}) {
	const [expiry, setExpiry] = useState('604800');
	const [share, setShare] = useState<Share | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		setShare(null);
		setExpiry('604800');
		setError('');
		setCopied(false);
	}, [item?.id]);
	async function create() {
		if (!item) return;
		setBusy(true);
		setError('');
		try {
			setShare((await api.share(item.id, expiry === 'never' ? null : Number(expiry))).share);
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Could not create a share link.');
		} finally {
			setBusy(false);
		}
	}
	return (
		<Modal
			open={item !== null}
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
			title="Share this item"
			description="Create a link to this saved item. Later clipboard changes won’t change what’s shared."
			className="share-dialog"
		>
			<div className="share-item">
				<div className="share-item-icon">
					<Link size={20} />
				</div>
				<div>
					<strong>{item?.title}</strong>
					<span>{item ? formatBytes(item.size) : ''}</span>
				</div>
			</div>
			{!share ? (
				<>
					<label className="field-label" htmlFor="share-expiry">
						LINK EXPIRATION
					</label>
					<select
						id="share-expiry"
						className="select-input"
						value={expiry}
						onChange={(event) => setExpiry(event.target.value)}
						disabled={busy}
					>
						<option value="3600">After 1 hour</option>
						<option value="86400">After 1 day</option>
						<option value="604800">After 7 days</option>
						<option value="2592000">After 30 days</option>
						<option value="never">Never</option>
					</select>
					<p className="field-description">Anyone with the link can read this item and download its files.</p>
				</>
			) : (
				<>
					<label className="field-label" htmlFor="share-url">
						SHARE LINK
					</label>
					<div className="share-url-row">
						<input id="share-url" value={share.url} readOnly onFocus={(event) => event.target.select()} />
						<button
							className="button primary"
							type="button"
							onClick={async () => {
								try {
									await copyText(share.url);
									setCopied(true);
									notify('Share link copied');
								} catch {
									setError('Select and copy the link manually.');
								}
							}}
						>
							{copied ? <CheckCheck size={16} /> : <Copy size={16} />}
							{copied ? 'Copied' : 'Copy'}
						</button>
					</div>
					<p className="field-description">
						{share.expiresAt
							? `Expires ${new Date(share.expiresAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}.`
							: 'This link stays active until you revoke it.'}
					</p>
				</>
			)}
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-footer">
				{share ? (
					<button
						className="button quiet"
						type="button"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await api.revokeShare(share.id);
								setShare(null);
								notify('Share link revoked');
							} catch (error) {
								setError(error instanceof Error ? error.message : 'Could not revoke link.');
							} finally {
								setBusy(false);
							}
						}}
					>
						Revoke link
					</button>
				) : (
					<span />
				)}
				<button className="button secondary" type="button" onClick={onClose} disabled={busy}>
					{share ? 'Done' : 'Cancel'}
				</button>
				{!share && (
					<button className="button primary" type="button" onClick={() => void create()} disabled={busy}>
						{busy ? <LoaderCircle className="spin" size={15} /> : <Link size={15} />}Create link
					</button>
				)}
			</div>
		</Modal>
	);
}
