const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
export async function sha256(value: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function secureEqual(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
	let difference = 0;
	for (let i = 0; i < ha.length; i++) difference |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
	return difference === 0;
}
export async function shareToken(id: string, secret: string): Promise<string> {
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
	} catch {
		throw new Error('SHARE_SIGNING_KEY must be a base64-encoded 32-byte key');
	}
	if (bytes.byteLength !== 32) throw new Error('SHARE_SIGNING_KEY must be a base64-encoded 32-byte key');
	const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return `${id}.${base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`share:v1:${id}`))))}`;
}
