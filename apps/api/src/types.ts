import type { Context } from 'hono';

export type Bindings = Cloudflare.Env;
export interface Principal {
	id: string;
	method: 'bearer' | 'access' | 'device';
	deviceId: string | null;
	expiresAt: number;
}
export type AppEnv = { Bindings: Bindings; Variables: { principal: Principal; requestId: string } };
export type AppContext = Context<AppEnv>;

export type { Representation, Content, ClipboardState } from '../../../shared/contracts';
export interface ItemRow {
	id: string;
	content_json: string;
	created_by: string;
	created_at: string;
}
export interface FileRow {
	id: string;
	name: string;
	content_type: string;
	size: number;
	r2_key: string;
	etag: string | null;
	status: 'pending' | 'ready' | 'deleted';
	created_by: string;
	created_at: string;
	deleted_at: string | null;
}
export interface DeviceRow {
	id: string;
	name: string;
	platform: string;
	capabilities_json: string;
	token_hash: string;
	created_at: string;
	last_seen_at: string | null;
	revoked_at: string | null;
}
export interface ShareRow {
	id: string;
	item_id: string;
	created_by: string;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
}
