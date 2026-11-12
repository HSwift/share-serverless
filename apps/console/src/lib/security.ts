import DOMPurify from 'dompurify';

export function safeLink(value: string): string {
	if (value.startsWith('#')) return value;
	try {
		const url = new URL(value);
		return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
	} catch {
		return '';
	}
}
export function safeImageUrl(value: string): string {
	const link = safeLink(value);
	return /^https?:\/\//i.test(link) ? link : '';
}

export function sanitizedHtmlDocument(value: string): string {
	const clean = DOMPurify.sanitize(value, {
		USE_PROFILES: { html: true },
		ALLOW_DATA_ATTR: false,
		FORBID_TAGS: [
			'script',
			'style',
			'iframe',
			'object',
			'embed',
			'form',
			'input',
			'textarea',
			'button',
			'select',
			'link',
			'meta',
			'base',
			'svg',
			'math',
			'video',
			'audio',
			'source',
		],
		FORBID_ATTR: ['style', 'src', 'srcset', 'href', 'xlink:href', 'poster', 'action', 'formaction', 'id', 'name', 'target', 'autofocus'],
	});
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'"><style>body{margin:0;padding:32px;color:#262626;background:#fff;font:15px/1.75 system-ui,sans-serif;overflow-wrap:anywhere}h1,h2,h3{line-height:1.35;font-weight:600}h1{font-size:26px}h2{font-size:21px}a{color:inherit}pre,code{font-family:ui-monospace,monospace}pre{background:#f9f9f9;border:1px solid #e5e7eb;padding:16px;overflow:auto}blockquote{margin-left:0;border-left:3px solid #e5e7eb;padding-left:16px;color:#727272}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e7eb;padding:8px;text-align:left}img{display:none}</style></head><body>${clean}</body></html>`;
}
