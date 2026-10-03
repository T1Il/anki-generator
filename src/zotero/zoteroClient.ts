import { requestUrl } from 'obsidian';

/**
 * Lesezugriff auf die laufende Zotero-Desktop-App ueber deren lokale API
 * (Zotero 7: Einstellungen → Erweitert → „Anderen Anwendungen auf diesem
 * Computer erlauben, mit Zotero zu kommunizieren").
 *
 * Bewusst nicht ueber zotero.sqlite: die Datei ist gesperrt, solange Zotero
 * laeuft, und ihr Schema ist kein oeffentlicher Vertrag.
 */

export interface ZoteroCollection {
	key: string;
	name: string;
	parentKey: string | null;
	numItems: number;
	numCollections: number;
}

export interface ZoteroAttachment {
	key: string;
	title: string;
	contentType: string;
	/** Absoluter Pfad zur Datei (PDF, HTML …), sofern lokal vorhanden. */
	filePath: string | null;
	/** Zoteros Volltext-Cache – reiner Text, ideal zum Durchsuchen. */
	fullTextPath: string | null;
}

export interface ZoteroSource {
	key: string;
	itemType: string;
	title: string;
	creators: string;
	date: string;
	url: string;
	collectionName: string;
	attachments: ZoteroAttachment[];
	/** Text der Kind-Notizen (Zusammenfassungen, Markierungen), HTML entfernt. */
	notes: string[];
}

export class ZoteroUnreachableError extends Error {
	constructor(cause: string) {
		super(
			'Zotero ist nicht erreichbar. Läuft Zotero, und ist die lokale API an? ' +
			'(Zotero → Einstellungen → Erweitert → „Anderen Anwendungen auf diesem Computer ' +
			'erlauben, mit Zotero zu kommunizieren") – ' + cause
		);
		this.name = 'ZoteroUnreachableError';
	}
}

const SEITE = 100;

export class ZoteroClient {
	constructor(private baseUrl: string, private dataDir: string) {}

	private async get(path: string): Promise<any[]> {
		const all: any[] = [];
		for (let start = 0; ; start += SEITE) {
			const sep = path.includes('?') ? '&' : '?';
			const url = `${this.baseUrl.replace(/\/$/, '')}/users/0/${path}${sep}limit=${SEITE}&start=${start}`;
			let res;
			try {
				res = await requestUrl({ url, method: 'GET', throw: false });
			} catch (e: any) {
				throw new ZoteroUnreachableError(e?.message || String(e));
			}
			if (res.status === 404) return all;
			if (res.status >= 400) throw new ZoteroUnreachableError(`HTTP ${res.status} bei ${path}`);
			const page = res.json;
			if (!Array.isArray(page)) return all;
			all.push(...page);
			if (page.length < SEITE) return all;
		}
	}

	async collections(): Promise<ZoteroCollection[]> {
		const raw = await this.get('collections');
		return raw.map((c) => ({
			key: c.key,
			name: c.data?.name ?? '(ohne Namen)',
			parentKey: c.data?.parentCollection || null,
			numItems: c.meta?.numItems ?? 0,
			numCollections: c.meta?.numCollections ?? 0
		}));
	}

	/**
	 * Alle Quellen der gewaehlten Sammlungen, optional samt Unterordnern.
	 * Eine Quelle, die in mehreren Sammlungen liegt, kommt nur einmal vor.
	 */
	async sources(
		collectionKeys: string[],
		all: ZoteroCollection[],
		includeSubcollections: boolean
	): Promise<ZoteroSource[]> {
		const keys = includeSubcollections ? withDescendants(collectionKeys, all) : collectionKeys;
		const names = new Map(all.map((c) => [c.key, c.name]));
		const seen = new Set<string>();
		const out: ZoteroSource[] = [];

		for (const ck of keys) {
			const items = await this.get(`collections/${ck}/items/top`);
			for (const it of items) {
				if (seen.has(it.key)) continue;
				seen.add(it.key);
				out.push(await this.toSource(it, names.get(ck) ?? ck));
			}
		}
		return out;
	}

	private async toSource(it: any, collectionName: string): Promise<ZoteroSource> {
		const d = it.data ?? {};
		const src: ZoteroSource = {
			key: it.key,
			itemType: d.itemType ?? '',
			title: d.title || d.caseName || d.subject || '(ohne Titel)',
			creators: formatCreators(d.creators),
			date: d.date ?? '',
			url: d.url ?? '',
			collectionName,
			attachments: [],
			notes: []
		};

		// Eigenstaendige Anhaenge (PDF direkt in der Sammlung) sind selbst Top-Items.
		if (d.itemType === 'attachment') {
			src.attachments.push(this.toAttachment(it));
			return src;
		}
		if (d.itemType === 'note') {
			src.notes.push(stripHtml(d.note ?? ''));
			return src;
		}

		const children = await this.get(`items/${it.key}/children`);
		for (const ch of children) {
			const cd = ch.data ?? {};
			if (cd.itemType === 'attachment') src.attachments.push(this.toAttachment(ch));
			else if (cd.itemType === 'note' && cd.note) src.notes.push(stripHtml(cd.note));
		}
		return src;
	}

	private toAttachment(ch: any): ZoteroAttachment {
		const cd = ch.data ?? {};
		const storage = joinPath(this.dataDir, 'storage', ch.key);
		let filePath: string | null = null;
		if (cd.linkMode === 'linked_file' && cd.path) filePath = cd.path;
		else if (cd.filename) filePath = joinPath(storage, cd.filename);

		return {
			key: ch.key,
			title: cd.title || cd.filename || ch.key,
			contentType: cd.contentType ?? '',
			filePath: filePath && exists(filePath) ? filePath : null,
			fullTextPath: exists(joinPath(storage, '.zotero-ft-cache')) ? joinPath(storage, '.zotero-ft-cache') : null
		};
	}
}

export function withDescendants(keys: string[], all: ZoteroCollection[]): string[] {
	const out = new Set(keys);
	let grew = true;
	while (grew) {
		grew = false;
		for (const c of all) {
			if (c.parentKey && out.has(c.parentKey) && !out.has(c.key)) {
				out.add(c.key);
				grew = true;
			}
		}
	}
	return [...out];
}

/** Sammlungspfad fuer die Anzeige, z. B. „Medikamente › Ondansetron". */
export function collectionPath(key: string, all: ZoteroCollection[]): string {
	const byKey = new Map(all.map((c) => [c.key, c]));
	const parts: string[] = [];
	let cur = byKey.get(key);
	let guard = 0;
	while (cur && guard++ < 20) {
		parts.unshift(cur.name);
		cur = cur.parentKey ? byKey.get(cur.parentKey) : undefined;
	}
	return parts.join(' › ');
}

function formatCreators(creators: any[] | undefined): string {
	if (!Array.isArray(creators) || creators.length === 0) return '';
	const names = creators.map((c) => c.lastName || c.name || '').filter(Boolean);
	return names.length > 3 ? `${names.slice(0, 3).join(', ')} u. a.` : names.join(', ');
}

export function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|h\d)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function joinPath(...parts: string[]): string {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const path = require('path');
	return path.join(...parts);
}

function exists(p: string): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('fs').existsSync(p);
	} catch {
		return false;
	}
}
