import { useEffect, useRef, type ReactNode } from 'react';

export function closePopover(element: HTMLElement) {
	const details = element.closest('details');
	if (details) details.open = false;
}

export function Popover({
	label,
	icon,
	children,
	active = false,
}: {
	label: string;
	icon: ReactNode;
	children: ReactNode;
	active?: boolean;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const closeOutside = (event: Event) => {
			if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || !ref.current?.open) return;
			ref.current.open = false;
			ref.current.querySelector('summary')?.focus();
		};
		document.addEventListener('pointerdown', closeOutside);
		document.addEventListener('focusin', closeOutside);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', closeOutside);
			document.removeEventListener('focusin', closeOutside);
			document.removeEventListener('keydown', escape);
		};
	}, []);
	return (
		<details ref={ref} className={`popover ${active ? 'has-filters' : ''}`}>
			<summary className="icon-button" aria-label={label} title={label}>
				{icon}
			</summary>
			<div className="popover-content">{children}</div>
		</details>
	);
}
