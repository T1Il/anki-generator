import { App, ButtonComponent, Modal, Setting, setIcon } from 'obsidian';
import { ZoteroClient, ZoteroCollection, collectionPath } from '../zotero/zoteroClient';

export interface AbgleichAuswahl {
	collectionKeys: string[];
	collections: ZoteroCollection[];
	includeSubcollections: boolean;
	research: boolean;
	extra: string;
}

/**
 * Auswahl der Zotero-Sammlungen fuer den Abgleich einer Notiz.
 *
 * Vorausgewaehlt ist die Sammlung, die so heisst wie die Notiz – bei
 * „Ondansetron" also der Zotero-Ordner „Ondansetron".
 */
export class ZoteroAbgleichModal extends Modal {
	private all: ZoteroCollection[] = [];
	private selected = new Set<string>();
	private includeSub = true;
	private research = false;
	private extra = '';
	private filter = '';
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private startBtn!: ButtonComponent;

	constructor(
		app: App,
		private client: ZoteroClient,
		private noteTitle: string,
		private onStart: (a: AbgleichAuswahl) => void
	) {
		super(app);
	}

	async onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass('anki-zotero-modal');
		this.titleEl.setText(`Mit Zotero abgleichen: ${this.noteTitle}`);

		contentEl.createEl('p', {
			cls: 'anki-zotero-hint',
			text: 'Ein Claude-Agent liest die Quellen der gewählten Sammlungen, vergleicht sie mit der Notiz und ihren Karten und schlägt Korrekturen im Chat vor. Übernommen wird erst per Klick.'
		});

		const search = contentEl.createEl('input', {
			type: 'search',
			cls: 'anki-zotero-search',
			attr: { placeholder: 'Sammlung suchen…' }
		});
		search.addEventListener('input', () => {
			this.filter = search.value.trim().toLowerCase();
			this.renderList();
		});

		this.listEl = contentEl.createDiv({ cls: 'anki-zotero-list' });
		this.listEl.setText('Lade Sammlungen aus Zotero…');

		new Setting(contentEl)
			.setName('Unterordner einbeziehen')
			.addToggle((t) => t.setValue(this.includeSub).onChange((v) => { this.includeSub = v; this.updateCount(); }));

		new Setting(contentEl)
			.setName('Weiter recherchieren')
			.setDesc('Der Agent darf zusätzlich im Web suchen (Leitlinien, Fachinformation). Solche Belege werden als „außerhalb Zotero" markiert.')
			.addToggle((t) => t.setValue(this.research).onChange((v) => { this.research = v; }));

		const extraSetting = new Setting(contentEl)
			.setName('Zusatzauftrag (optional)')
			.setDesc('z. B. „Achte besonders auf Kinderdosierungen".');
		extraSetting.settingEl.addClass('anki-zotero-extra');
		const ta = contentEl.createEl('textarea', { cls: 'anki-zotero-extra-input', attr: { rows: '2' } });
		ta.addEventListener('input', () => { this.extra = ta.value; });

		const footer = contentEl.createDiv({ cls: 'anki-zotero-footer' });
		this.countEl = footer.createSpan({ cls: 'anki-zotero-count' });
		this.startBtn = new ButtonComponent(footer)
			.setButtonText('Abgleich starten')
			.setCta()
			.setDisabled(true)
			.onClick(() => {
				if (this.selected.size === 0) return;
				this.close();
				this.onStart({
					collectionKeys: [...this.selected],
					collections: this.all,
					includeSubcollections: this.includeSub,
					research: this.research,
					extra: this.extra
				});
			});

		try {
			this.all = await this.client.collections();
		} catch (e: any) {
			this.listEl.empty();
			this.listEl.addClass('is-error');
			this.listEl.setText(e?.message || String(e));
			return;
		}

		const name = this.noteTitle.toLowerCase();
		this.all.filter((c) => c.name.toLowerCase() === name).forEach((c) => this.selected.add(c.key));
		this.renderList();
		this.updateCount();
		search.focus();
	}

	private renderList() {
		this.listEl.empty();
		const byParent = new Map<string | null, ZoteroCollection[]>();
		for (const c of this.all) {
			const k = c.parentKey;
			if (!byParent.has(k)) byParent.set(k, []);
			byParent.get(k)!.push(c);
		}
		byParent.forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name, 'de')));

		// Beim Filtern flache Trefferliste mit Pfad, sonst der Baum.
		if (this.filter) {
			const hits = this.all
				.filter((c) => c.name.toLowerCase().includes(this.filter))
				.sort((a, b) => a.name.localeCompare(b.name, 'de'));
			if (!hits.length) this.listEl.createDiv({ cls: 'anki-zotero-empty', text: 'Keine Sammlung gefunden.' });
			hits.forEach((c) => this.renderRow(this.listEl, c, 0, collectionPath(c.key, this.all)));
			return;
		}

		// Ausgewaehltes zuerst sichtbar machen: Vorfahren aufklappen.
		const open = new Set<string>();
		for (const key of this.selected) {
			let cur = this.all.find((c) => c.key === key);
			while (cur?.parentKey) {
				open.add(cur.parentKey);
				cur = this.all.find((c) => c.key === cur!.parentKey);
			}
		}

		const walk = (parent: string | null, depth: number, into: HTMLElement) => {
			for (const c of byParent.get(parent) ?? []) {
				const kids = byParent.get(c.key) ?? [];
				const row = this.renderRow(into, c, depth, undefined, kids.length > 0);
				if (!kids.length) continue;
				const sub = into.createDiv({ cls: 'anki-zotero-children' });
				const isOpen = open.has(c.key);
				sub.toggleClass('is-hidden', !isOpen);
				const arrow = row.querySelector('.anki-zotero-arrow') as HTMLElement;
				setIcon(arrow, isOpen ? 'chevron-down' : 'chevron-right');
				arrow.addEventListener('click', (e) => {
					// Der Pfeil sitzt im <label>: ohne preventDefault schaltete er die Checkbox mit.
					e.preventDefault();
					const nowHidden = !sub.hasClass('is-hidden');
					sub.toggleClass('is-hidden', nowHidden);
					setIcon(arrow, nowHidden ? 'chevron-right' : 'chevron-down');
				});
				walk(c.key, depth + 1, sub);
			}
		};
		walk(null, 0, this.listEl);
	}

	private renderRow(into: HTMLElement, c: ZoteroCollection, depth: number, label?: string, hasKids = false): HTMLElement {
		const row = into.createEl('label', { cls: 'anki-zotero-row' });
		row.style.paddingLeft = `${depth * 16 + 4}px`;
		const arrow = row.createSpan({ cls: 'anki-zotero-arrow' });
		if (!hasKids) arrow.addClass('is-leaf');
		const box = row.createEl('input', { type: 'checkbox' });
		box.checked = this.selected.has(c.key);
		box.addEventListener('change', () => {
			box.checked ? this.selected.add(c.key) : this.selected.delete(c.key);
			this.updateCount();
		});
		const icon = row.createSpan({ cls: 'anki-zotero-icon' });
		setIcon(icon, 'folder');
		row.createSpan({ cls: 'anki-zotero-name', text: label ?? c.name });
		row.createSpan({ cls: 'anki-zotero-meta', text: `${c.numItems}` });
		return row;
	}

	private updateCount() {
		const n = this.selected.size;
		const items = this.all.filter((c) => this.selected.has(c.key)).reduce((s, c) => s + c.numItems, 0);
		this.countEl.setText(n === 0
			? 'Keine Sammlung gewählt'
			: `${n} Sammlung${n === 1 ? '' : 'en'} · ${items} Einträge${this.includeSub ? ' + Unterordner' : ''}`);
		this.startBtn.setDisabled(n === 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
