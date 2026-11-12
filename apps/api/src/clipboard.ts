import { DurableObject } from 'cloudflare:workers';
import { sha256 } from './crypto';
import { AppError, channelName, errorResponse, integer, queryInteger, readJson, string } from './http';
import { findItem, itemId } from './items';
import type { Bindings, ClipboardState, Principal } from './types';

const HISTORY_LIMIT = 200;
const MUTATION_TTL = 7 * 86400000;
type StateRow = { revision: number; state_json: string };
type MutationRow = { request_hash: string; revision: number; changed: number };
type Attachment = { channel: string; principal: Principal };

/** A strongly consistent register of immutable item IDs. No long-lived connection is required. */
export class ClipboardHub extends DurableObject<Bindings> {
	constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY, revision INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS history (channel TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY (channel, revision));
			CREATE TABLE IF NOT EXISTS mutations (
				channel TEXT NOT NULL, actor_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
				request_hash TEXT NOT NULL, revision INTEGER NOT NULL, changed INTEGER NOT NULL, created_at INTEGER NOT NULL,
				PRIMARY KEY (channel, actor_id, mutation_id)
			);
			CREATE INDEX IF NOT EXISTS mutations_expiry ON mutations(created_at);
		`);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	getSnapshot(channel: string, revision?: number): ClipboardState | null {
		channelName(channel);
		if (revision === 0) return this.empty(channel);
		const row =
			revision === undefined
				? this.ctx.storage.sql
						.exec<StateRow>('SELECT revision, state_json FROM history WHERE channel = ? ORDER BY revision DESC LIMIT 1', channel)
						.toArray()[0]
				: this.ctx.storage.sql
						.exec<StateRow>('SELECT revision, state_json FROM history WHERE channel = ? AND revision = ?', channel, revision)
						.toArray()[0];
		return row ? (JSON.parse(row.state_json) as ClipboardState) : revision === undefined ? this.empty(channel) : null;
	}

	private empty(channel: string): ClipboardState {
		return { channel, revision: 0, itemId: null, sourceDeviceId: null, updatedAt: null, mutationId: null };
	}

	private async checkPrincipal(principal: Principal): Promise<void> {
		if (!principal || !principal.id || principal.expiresAt <= Date.now()) throw new AppError(401, 'UNAUTHORIZED', 'Session expired');
		if (principal.deviceId) {
			const active = await this.env.DB.prepare('SELECT id FROM devices WHERE id = ? AND revoked_at IS NULL')
				.bind(principal.deviceId)
				.first();
			if (!active) throw new AppError(401, 'DEVICE_REVOKED', 'Device credential was revoked');
		}
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const match = /^\/channels\/([^/]+)(?:\/(history|changes|events))?$/.exec(url.pathname);
			if (!match) throw new AppError(404, 'NOT_FOUND', 'Route not found');
			const channel = channelName(match[1]);
			const action = match[2];
			const principal = JSON.parse(request.headers.get('x-internal-principal') ?? 'null') as Principal;
			if (request.method === 'PUT' && !action) return await this.write(request, channel, principal);
			if (request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
			if (action === 'events') return await this.subscribe(request, channel, principal);
			await this.checkPrincipal(principal);
			const current = this.getSnapshot(channel)!;
			if (action === 'changes') {
				const after = queryInteger(url.searchParams.get('after'), 'after', 0, 0, Number.MAX_SAFE_INTEGER);
				const limit = queryInteger(url.searchParams.get('limit'), 'limit', 100, 1, 200);
				if (after > current.revision) throw new AppError(409, 'CURSOR_AHEAD', 'Cursor is ahead of the server', { current });
				const first = this.ctx.storage.sql
					.exec<{ revision: number }>('SELECT revision FROM history WHERE channel = ? ORDER BY revision LIMIT 1', channel)
					.toArray()[0];
				if (first && after < first.revision - 1)
					throw new AppError(409, 'CURSOR_EXPIRED', 'Cursor has left the history window; fetch current state', {
						current,
						retainedFromRevision: first.revision,
					});
				const rows = this.ctx.storage.sql
					.exec<StateRow>(
						'SELECT revision, state_json FROM history WHERE channel = ? AND revision > ? ORDER BY revision LIMIT ?',
						channel,
						after,
						limit + 1,
					)
					.toArray();
				return Response.json({
					channel,
					revision: current.revision,
					changes: rows.slice(0, limit).map((row) => JSON.parse(row.state_json)),
					hasMore: rows.length > limit,
				});
			}
			if (action === 'history') {
				const limit = queryInteger(url.searchParams.get('limit'), 'limit', 50, 1, 100);
				const before = queryInteger(url.searchParams.get('before'), 'before', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
				const rows = this.ctx.storage.sql
					.exec<StateRow>(
						'SELECT revision, state_json FROM history WHERE channel = ? AND revision < ? ORDER BY revision DESC LIMIT ?',
						channel,
						before,
						limit + 1,
					)
					.toArray();
				return Response.json({
					history: rows.slice(0, limit).map((row) => JSON.parse(row.state_json)),
					nextBefore: rows.length > limit ? rows[limit - 1].revision : null,
				});
			}
			const headers = new Headers({
				ETag: `"${current.revision}"`,
				'X-Clipboard-Revision': String(current.revision),
				'Cache-Control': 'private, no-cache',
			});
			if (request.headers.get('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
			return Response.json({ state: current }, { headers });
		} catch (error) {
			return errorResponse(error);
		}
	}

	private async write(request: Request, channel: string, principal: Principal): Promise<Response> {
		const input = await readJson(request);
		const mutationId = string(input.mutationId, 'mutationId', 128);
		const baseRevision = input.baseRevision === undefined ? undefined : integer(input.baseRevision, 'baseRevision', 0);
		const nextId = input.itemId === null ? null : itemId(input.itemId);
		const requestHash = await sha256(JSON.stringify({ itemId: nextId, baseRevision: baseRevision ?? null }));
		// Keep D1 validation plus read/compare/write serialized even across awaited external work.
		return this.ctx.blockConcurrencyWhile(async () => {
			try {
				await this.checkPrincipal(principal);
				const previous = this.ctx.storage.sql
					.exec<MutationRow>(
						'SELECT request_hash, revision, changed FROM mutations WHERE channel = ? AND actor_id = ? AND mutation_id = ?',
						channel,
						principal.id,
						mutationId,
					)
					.toArray()[0];
				if (previous) {
					if (previous.request_hash !== requestHash)
						throw new AppError(409, 'MUTATION_REUSED', 'mutationId was already used for a different request');
					const state = this.getSnapshot(channel, previous.revision);
					if (!state)
						throw new AppError(410, 'MUTATION_EXPIRED', 'Original result has left the history window; fetch current state', {
							revision: previous.revision,
						});
					return Response.json({ state, changed: previous.changed === 1, replayed: true });
				}
				const current = this.getSnapshot(channel)!;
				if (baseRevision !== undefined && baseRevision !== current.revision)
					throw new AppError(409, 'REVISION_CONFLICT', 'The clipboard changed since baseRevision', { current });
				if (nextId !== null) await findItem(this.env.DB, nextId);
				const changed = current.itemId !== nextId;
				const state: ClipboardState = changed
					? {
							channel,
							revision: current.revision + 1,
							itemId: nextId,
							sourceDeviceId: principal.deviceId,
							updatedAt: new Date().toISOString(),
							mutationId,
						}
					: current;
				this.ctx.storage.transactionSync(() => {
					if (changed) {
						if (
							current.revision === 0 &&
							this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM channels').toArray()[0].count >= 100
						)
							throw new AppError(409, 'CHANNEL_LIMIT', 'At most 100 clipboard channels are supported');
						this.ctx.storage.sql.exec(
							'INSERT INTO channels (name, revision) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET revision = excluded.revision',
							channel,
							state.revision,
						);
						this.ctx.storage.sql.exec(
							'INSERT INTO history (channel, revision, state_json) VALUES (?, ?, ?)',
							channel,
							state.revision,
							JSON.stringify(state),
						);
						this.ctx.storage.sql.exec('DELETE FROM history WHERE channel = ? AND revision <= ?', channel, state.revision - HISTORY_LIMIT);
					}
					this.ctx.storage.sql.exec(
						'INSERT INTO mutations (channel, actor_id, mutation_id, request_hash, revision, changed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
						channel,
						principal.id,
						mutationId,
						requestHash,
						state.revision,
						Number(changed),
						Date.now(),
					);
					this.ctx.storage.sql.exec('DELETE FROM mutations WHERE created_at < ?', Date.now() - MUTATION_TTL);
				});
				if (changed) this.broadcast(channel, { type: 'clipboard.changed', ...state });
				return Response.json({ state, changed, replayed: false });
			} catch (error) {
				return errorResponse(error);
			}
		});
	}

	private async subscribe(request: Request, channel: string, principal: Principal): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
			throw new AppError(426, 'WEBSOCKET_REQUIRED', 'Use a WebSocket upgrade');
		return this.ctx.blockConcurrencyWhile(async () => {
			try {
				await this.checkPrincipal(principal);
				if (this.ctx.getWebSockets().filter((socket) => socket.readyState === 1).length >= 64)
					throw new AppError(429, 'CONNECTION_LIMIT', 'At most 64 active subscriptions are supported');
				const url = new URL(request.url);
				const afterValue = url.searchParams.get('after');
				const after = queryInteger(afterValue, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
				const current = this.getSnapshot(channel)!;
				if (after > current.revision) throw new AppError(409, 'CURSOR_AHEAD', 'Cursor is ahead of the server', { current });
				const first = this.ctx.storage.sql
					.exec<{ revision: number }>('SELECT revision FROM history WHERE channel = ? ORDER BY revision LIMIT 1', channel)
					.toArray()[0];
				const reset = afterValue === null || (first !== undefined && after < first.revision - 1);
				const pair = new WebSocketPair();
				const server = pair[1];
				server.serializeAttachment({ channel, principal } satisfies Attachment);
				this.ctx.acceptWebSocket(server, [`channel:${channel}`, `device:${principal.deviceId ?? 'admin'}`]);
				if (reset) server.send(JSON.stringify({ type: 'sync.reset', state: current }));
				else {
					const rows = this.ctx.storage.sql
						.exec<StateRow>('SELECT revision, state_json FROM history WHERE channel = ? AND revision > ? ORDER BY revision', channel, after)
						.toArray();
					for (const row of rows) server.send(JSON.stringify({ type: 'clipboard.changed', ...JSON.parse(row.state_json) }));
				}
				server.send(JSON.stringify({ type: 'sync.ready', channel, revision: current.revision }));
				const alarm = await this.ctx.storage.getAlarm();
				if (alarm === null || alarm > principal.expiresAt) await this.ctx.storage.setAlarm(principal.expiresAt);
				return new Response(null, { status: 101, webSocket: pair[0] });
			} catch (error) {
				return errorResponse(error);
			}
		});
	}

	private broadcast(channel: string, event: unknown): void {
		for (const socket of this.ctx.getWebSockets(`channel:${channel}`)) {
			const { principal } = socket.deserializeAttachment() as Attachment;
			if (principal.expiresAt <= Date.now()) {
				socket.close(4001, 'Session expired; reconnect');
				continue;
			}
			try {
				if (socket.readyState === 1) socket.send(JSON.stringify(event));
			} catch {
				socket.close(1011, 'Delivery failed; reconnect');
			}
		}
	}

	disconnectDevice(deviceId: string): void {
		for (const socket of this.ctx.getWebSockets(`device:${deviceId}`)) socket.close(4003, 'Device revoked');
	}
	webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
		socket.close(1008, 'Use HTTP for clipboard writes');
	}
	webSocketClose(socket: WebSocket, code: number, reason: string): void {
		socket.close(code, reason);
	}
	webSocketError(socket: WebSocket): void {
		socket.close(1011, 'Reconnect');
	}
	async alarm(): Promise<void> {
		let next = Infinity;
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState !== 1) continue;
			const { principal } = socket.deserializeAttachment() as Attachment;
			if (principal.expiresAt <= Date.now()) socket.close(4001, 'Session expired; reconnect');
			else next = Math.min(next, principal.expiresAt);
		}
		if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
	}
}
