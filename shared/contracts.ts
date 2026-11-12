export type Representation = { mimeType: string; text: string; fileId?: never } | { mimeType: string; fileId: string; text?: never };
export interface Content {
	representations: Representation[];
	files: string[];
}
export interface ClipboardState {
	channel: string;
	revision: number;
	itemId: string | null;
	sourceDeviceId: string | null;
	updatedAt: string | null;
	mutationId: string | null;
}
export interface FileDescriptor {
	id: string;
	name: string;
	mimeType: string;
	size: number | null;
	available: boolean;
}
export interface Item {
	id: string;
	content: Content;
	createdAt: string;
}
export type ItemKind = 'text' | 'image' | 'files';
export interface ItemSummary {
	id: string;
	createdAt: string;
	mimeTypes: string[];
	files: string[];
	fileDetails: FileDescriptor[];
	title: string;
	preview: string;
	kind: ItemKind;
	size: number;
}
export interface LibraryPage {
	items: ItemSummary[];
	nextCursor: string | null;
	total: number;
}
export interface ItemResult {
	item: Item;
	files: FileDescriptor[];
}
export interface Limits {
	maxUploadBytes: number;
	maxInlineBytes: number;
	maxFiles: number;
}
export interface Share {
	id: string;
	itemId: string;
	url: string;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
}
