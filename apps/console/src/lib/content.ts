import type { Content, FileDescriptor, ItemSummary } from '../../../../shared/contracts';

export const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon']);
export type Language =
	| 'auto'
	| 'text'
	| 'javascript'
	| 'typescript'
	| 'json'
	| 'python'
	| 'markdown'
	| 'html'
	| 'css'
	| 'yaml'
	| 'shell'
	| 'sql';
export const languages: { value: Language; label: string; mime: string }[] = [
	{ value: 'text', label: 'Plain text', mime: 'text/plain' },
	{ value: 'typescript', label: 'TypeScript', mime: 'text/typescript' },
	{ value: 'javascript', label: 'JavaScript', mime: 'text/javascript' },
	{ value: 'json', label: 'JSON', mime: 'application/json' },
	{ value: 'python', label: 'Python', mime: 'text/x-python' },
	{ value: 'markdown', label: 'Markdown', mime: 'text/markdown' },
	{ value: 'html', label: 'HTML', mime: 'text/html' },
	{ value: 'css', label: 'CSS', mime: 'text/css' },
	{ value: 'yaml', label: 'YAML', mime: 'application/yaml' },
	{ value: 'shell', label: 'Shell', mime: 'text/x-shellscript' },
	{ value: 'sql', label: 'SQL', mime: 'text/x-sql' },
];

export function inferLanguage(mime = '', name = '', text = ''): Language {
	const normalized = mime.toLowerCase();
	const extension = name.toLowerCase().split('.').pop();
	if (/markdown/.test(normalized) || ['md', 'mdx', 'markdown'].includes(extension ?? '')) return 'markdown';
	if (/typescript/.test(normalized) || ['ts', 'tsx'].includes(extension ?? '')) return 'typescript';
	if (/javascript/.test(normalized) || ['js', 'jsx', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript';
	if (/json/.test(normalized) || extension === 'json') return 'json';
	if (/python/.test(normalized) || extension === 'py') return 'python';
	if (/html/.test(normalized) || ['html', 'htm', 'svg'].includes(extension ?? '')) return 'html';
	if (/css/.test(normalized) || extension === 'css') return 'css';
	if (/yaml/.test(normalized) || ['yml', 'yaml'].includes(extension ?? '')) return 'yaml';
	if (/shell|bash/.test(normalized) || ['sh', 'bash', 'zsh'].includes(extension ?? '')) return 'shell';
	if (/sql/.test(normalized) || extension === 'sql') return 'sql';
	if (/^\s*(?:\{|\[)/.test(text)) {
		try {
			const value = JSON.parse(text);
			if (value && typeof value === 'object') return 'json';
		} catch {
			/* Text may just start with a bracket. */
		}
	}
	if (/^(?:#{1,6} .+|\s*```\w*\s*$)/m.test(text) || (/\n[-*] /m.test(text) && /\*\*.+\*\*/.test(text))) return 'markdown';
	if (/^(?:import .+ from |export (?:async |const |function |type |interface )|(?:async )?function \w+\()/m.test(text)) return 'typescript';
	if (/^(?:def \w+\(|from \w+ import )/m.test(text)) return 'python';
	if (/^#!.*(?:bash|\/sh)/.test(text)) return 'shell';
	return 'text';
}

export function primaryText(content: Content) {
	return (
		content.representations.find((rep) => rep.text !== undefined && rep.mimeType !== 'text/plain') ??
		content.representations.find((rep) => rep.text !== undefined)
	);
}
export function formatBytes(size: number | null | undefined): string {
	if (size === null || size === undefined) return 'Unavailable';
	if (size < 1024) return `${size} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = size / 1024;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index++;
	}
	return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)} ${units[index]}`;
}
export function itemLabel(item: ItemSummary): string {
	if (item.kind === 'image') return 'Image';
	if (item.kind === 'files')
		return item.fileDetails.length > 1
			? `${item.fileDetails.length} files`
			: (item.fileDetails[0]?.name.split('.').pop()?.toUpperCase() ?? 'File');
	const mime = item.mimeTypes.find((value) => value !== 'text/plain') ?? 'text/plain';
	return languages.find((language) => language.value === inferLanguage(mime, '', item.preview))?.label ?? 'Text';
}
export function relativeTime(value: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
	if (seconds < 60) return 'Just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
	return new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
export function dateGroup(value: string): string {
	const date = new Date(value);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	if (date >= today) return 'Today';
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	return date >= yesterday ? 'Yesterday' : 'Earlier';
}
export function isTextFile(file: FileDescriptor): boolean {
	return (
		file.mimeType.startsWith('text/') ||
		/json|yaml|xml|svg/.test(file.mimeType) ||
		/\.(txt|md|tsx?|jsx?|mjs|json|py|rs|go|c|h|cpp|css|html?|svg|ya?ml|toml|ini|conf|sh|sql|csv|log|xml)$/i.test(file.name)
	);
}
export function textContent(text: string, language: Language): Content | { text: string } {
	if (language === 'text' || language === 'auto') return { text };
	const mime = languages.find((value) => value.value === language)!.mime;
	return {
		representations: [
			{ mimeType: 'text/plain', text },
			{ mimeType: mime, text },
		],
		files: [],
	};
}
