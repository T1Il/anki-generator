import { App, Modal, Notice, Setting, ButtonComponent, TFile, setIcon } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { Card } from '../types';
import { DriftItem, DriftReport } from '../anki/driftCheck';
import { syncAnkiBlock } from '../anki/syncManager';
import { CardEditModal } from './CardEditModal';
import { getAnkiBlocks, parseCardsFromBlockSource, formatCardsToString, parseBlockHeader, buildFullBlock, spliceBlock } from '../anki/ankiParser';


interface DiffPart {
	text: string;
	changed: boolean;
}

/**
 * Wortweiser Vergleich ueber gemeinsamen Anfang und gemeinsames Ende.
 * Reicht voellig, um zu zeigen WAS sich geaendert hat - ein vollstaendiger
 * Diff-Algorithmus waere hier Overkill.
 */
function wordDiff(a: string, b: string): [DiffPart[], DiffPart[]] {
	const aw = a.split(' ');
	const bw = b.split(' ');

	let start = 0;
	while (start < aw.length && start < bw.length && aw[start] === bw[start]) start++;

	let end = 0;
	while (
		end < aw.length - start &&
		end < bw.length - start &&
		aw[aw.length - 1 - end] === bw[bw.length - 1 - end]
	) end++;

	const build = (words: string[]): DiffPart[] => {
		const parts: DiffPart[] = [];
		const head = words.slice(0, start).join(' ');
		const mid = words.slice(start, words.length - end).join(' ');
		const tail = words.slice(words.length - end).join(' ');
		if (head) parts.push({ text: head, changed: false });
		if (mid) parts.push({ text: mid, changed: true });
		if (tail) parts.push({ text: tail, changed: false });
		return parts;
	};

	return [build(aw), build(bw)];
}

function renderParts(parent: HTMLElement, parts: DiffPart[], fallback: string) {
	if (parts.length === 0) {
		parent.createSpan({ text: fallback || '(leer)' });
		return;
	}
	const wrap = parent.createSpan({ cls: 'anki-drift-text' });
	parts.forEach((part, i) => {
		const span = wrap.createSpan({ text: part.text });
		if (part.changed) span.addClass('anki-drift-changed');
		if (i < parts.length - 1) wrap.createSpan({ text: ' ' });
	});
}

/**
 * Zeigt Karten, die in der Notiz anders aussehen als in Anki, und lässt
 * auswählen, welche davon nach Anki übertragen werden sollen.
 */
export class DriftReviewModal extends Modal {
	private plugin: AnkiGeneratorPlugin;
	private report: DriftReport;
	private selected: Set<DriftItem> = new Set();
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private syncBtn!: ButtonComponent;
	private onRecheck: () => void;

	constructor(plugin: AnkiGeneratorPlugin, report: DriftReport, onRecheck: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.report = report;
		this.onRecheck = onRecheck;
		// Standardmäßig alles ausgewählt, was wirklich abweicht.
		report.items.filter((i) => i.status === 'changed').forEach((i) => this.selected.add(i));
		this.modalEl.addClass('anki-drift-modal');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Abweichungen zu Anki' });

		this.summaryEl = contentEl.createDiv({ cls: 'anki-drift-summary' });

		const toolbar = contentEl.createDiv({ cls: 'anki-drift-toolbar' });

		new ButtonComponent(toolbar)
			.setButtonText('Alle auswählen')
			.onClick(() => {
				this.report.items.filter((i) => i.status === 'changed').forEach((i) => this.selected.add(i));
				this.renderList();
			});

		new ButtonComponent(toolbar)
			.setButtonText('Keine')
			.onClick(() => {
				this.selected.clear();
				this.renderList();
			});

		new ButtonComponent(toolbar)
			.setButtonText('Erneut prüfen')
			.onClick(() => {
				this.close();
				this.onRecheck();
			});

		this.syncBtn = new ButtonComponent(toolbar)
			.setButtonText('Ausgewählte nach Anki übertragen')
			.setCta()
			.onClick(() => void this.syncSelected());
		this.syncBtn.buttonEl.addClass('anki-drift-sync-btn');

		this.listEl = contentEl.createDiv({ cls: 'anki-drift-list' });
		this.renderList();
	}

	private updateSummary() {
		const changed = this.report.items.filter((i) => i.status === 'changed').length;
		const missing = this.report.items.filter((i) => i.status === 'missing').length;

		this.summaryEl.empty();
		this.summaryEl.createSpan({
			text: `${this.report.checked} Karten mit ID geprüft in ${this.report.filesScanned} Notiz(en). `
		});
		this.summaryEl.createSpan({ text: `${changed} abweichend`, cls: 'anki-drift-count-changed' });
		if (missing > 0) {
			this.summaryEl.createSpan({ text: ', ' });
			this.summaryEl.createSpan({ text: `${missing} in Anki nicht gefunden`, cls: 'anki-drift-count-missing' });
		}
		if (this.report.withoutId > 0) {
			this.summaryEl.createSpan({ text: `, ${this.report.withoutId} noch nie synchronisiert` });
		}
		this.summaryEl.createSpan({ text: '.' });

		this.syncBtn.setButtonText(`${this.selected.size} nach Anki übertragen`);
		this.syncBtn.setDisabled(this.selected.size === 0);
	}

	private renderList() {
		this.listEl.empty();
		this.updateSummary();

		if (this.report.items.length === 0) {
			this.listEl.createDiv({
				cls: 'anki-drift-empty',
				text: 'Keine Abweichungen gefunden - Notizen und Anki stimmen überein.'
			});
			return;
		}

		// Nach Datei gruppieren.
		const byFile = new Map<string, DriftItem[]>();
		this.report.items.forEach((item) => {
			const key = item.file.path;
			if (!byFile.has(key)) byFile.set(key, []);
			(byFile.get(key) as DriftItem[]).push(item);
		});

		byFile.forEach((items, path) => {
			const group = this.listEl.createDiv({ cls: 'anki-drift-group' });
			const head = group.createDiv({ cls: 'anki-drift-group-head' });
			head.createSpan({ text: path });
			head.createSpan({ text: `${items.length}`, cls: 'anki-drift-group-count' });

			items.forEach((item) => this.renderItem(group, item));
		});
	}

	private renderItem(parent: HTMLElement, item: DriftItem) {
		const row = parent.createDiv({ cls: 'anki-drift-item' });
		if (item.status === 'missing') row.addClass('is-missing');

		const head = row.createDiv({ cls: 'anki-drift-item-head' });

		if (item.status === 'changed') {
			const cb = head.createEl('input', { type: 'checkbox' });
			cb.checked = this.selected.has(item);
			cb.addEventListener('change', () => {
				if (cb.checked) this.selected.add(item);
				else this.selected.delete(item);
				this.updateSummary();
			});
		} else {
			const warn = head.createSpan({ cls: 'anki-drift-warn-icon' });
			setIcon(warn, 'alert-triangle');
		}

		head.createSpan({
			cls: 'anki-drift-question',
			text: item.card.q.split('\n')[0].substring(0, 120)
		});
		head.createSpan({ cls: 'anki-drift-id', text: `ID ${item.noteId}` });

		if (item.status === 'missing') {
			row.createDiv({
				cls: 'anki-drift-note',
				text: 'Diese Notiz-ID existiert in Anki nicht mehr. Übertragen legt sie NICHT neu an - '
					+ 'entferne die ID-Zeile in der Notiz und synchronisiere den Block neu.'
			});
		} else {
			item.fields.filter((f) => f.differs).forEach((field) => {
				const diff = row.createDiv({ cls: 'anki-drift-diff' });
				diff.createDiv({ cls: 'anki-drift-field-label', text: field.label });

				// Die VERGLICHENE Fassung zeigen, nicht das Roh-HTML: sonst sieht
				// ein blosser Wikilink wie ein riesiger Unterschied aus, obwohl er
				// gar nicht zur Meldung gefuehrt hat.
				const [ankiParts, noteParts] = wordDiff(field.ankiNorm, field.noteNorm);

				const anki = diff.createDiv({ cls: 'anki-drift-line is-anki' });
				anki.createSpan({ cls: 'anki-drift-tag', text: 'Anki' });
				renderParts(anki, ankiParts, field.ankiNorm);

				const note = diff.createDiv({ cls: 'anki-drift-line is-note' });
				note.createSpan({ cls: 'anki-drift-tag', text: 'Notiz' });
				renderParts(note, noteParts, field.noteNorm);

				// Rohwerte auf Wunsch, fuer den Fall dass das HTML interessiert.
				const details = diff.createEl('details', { cls: 'anki-drift-raw' });
				details.createEl('summary', { text: 'Rohwerte anzeigen' });
				const rawAnki = details.createDiv({ cls: 'anki-drift-raw-line' });
				rawAnki.createSpan({ cls: 'anki-drift-tag', text: 'Anki' });
				rawAnki.createSpan({ text: field.ankiValue || '(leer)' });
				const rawNote = details.createDiv({ cls: 'anki-drift-raw-line' });
				rawNote.createSpan({ cls: 'anki-drift-tag', text: 'Notiz' });
				rawNote.createSpan({ text: field.noteValue || '(leer)' });
			});
		}

		const actions = row.createDiv({ cls: 'anki-drift-actions' });

		new ButtonComponent(actions)
			.setButtonText('Öffnen')
			.onClick(() => {
				this.plugin.app.workspace.openLinkText(item.file.path, '', false);
			});

		new ButtonComponent(actions)
			.setButtonText('Bearbeiten')
			.onClick(() => this.editItem(item, row));
	}

	/** Karte in der Notiz bearbeiten und den Block zurückschreiben. */
	private editItem(item: DriftItem, row: HTMLElement) {
		new CardEditModal(this.plugin.app, item.card, item.file.path, async (updatedCard: Card) => {
			const ok = await this.writeCardToNote(item, updatedCard);
			if (!ok) return;

			item.card = updatedCard;
			item.blockCards[item.cardIndex] = updatedCard;
			new Notice('Karte in der Notiz gespeichert. Zum Abgleich erneut prüfen.');
			row.addClass('is-edited');
		}).open();
	}

	private async writeCardToNote(item: DriftItem, updatedCard: Card): Promise<boolean> {
		let ok = false;

		await this.plugin.app.vault.process(item.file, (content) => {
			const blocks = getAnkiBlocks(content);
			const block = blocks.find((b) => b.innerClean === item.blockSource)
				|| blocks.find((b) => b.innerClean.trim() === item.blockSource.trim());

			if (!block) return content;

			const header = parseBlockHeader(block.innerClean);
			const cards = item.blockCards.slice();
			cards[item.cardIndex] = updatedCard;

			const deckLine = header.deckName ? `TARGET DECK: ${header.deckName}` : 'TARGET DECK:';
			const inner = formatCardsToString(deckLine, cards, header.instruction, header.status, header.extraHeaderLines);

			ok = true;
			// blockSource nachziehen, damit ein zweiter Durchgang den Block wiederfindet.
			item.blockSource = inner;
			return spliceBlock(content, block, buildFullBlock(block, inner));
		});

		if (!ok) new Notice('Der Block hat sich geändert - nichts geschrieben. Bitte erneut prüfen.');
		return ok;
	}

	/**
	 * Blockquelle und Kartenliste frisch aus der Datei holen.
	 *
	 * Nötig, weil syncAnkiBlock den Block neu schreibt: nach der ersten Karte
	 * eines Blocks wäre die gemerkte Quelle der übrigen Einträge veraltet und
	 * der Block würde nicht mehr gefunden.
	 */
	private async refreshItem(item: DriftItem): Promise<boolean> {
		const content = await this.plugin.app.vault.read(item.file);

		for (const block of getAnkiBlocks(content)) {
			const cards = parseCardsFromBlockSource(block.innerClean);
			const idx = cards.findIndex((c) => c.id === item.noteId);
			if (idx === -1) continue;

			item.blockSource = block.innerClean;
			item.blockCards = cards;
			item.cardIndex = idx;
			item.deckName = parseBlockHeader(block.innerClean).deckName;
			return true;
		}

		return false;
	}

	private async syncSelected() {
		const items = Array.from(this.selected);
		if (items.length === 0) return;

		this.syncBtn.setDisabled(true);
		const notice = new Notice(`Übertrage 0/${items.length}...`, 0);

		const synced = new Set<DriftItem>();
		let failed = 0;

		for (const item of items) {
			try {
				notice.setMessage(`Übertrage ${synced.size + 1}/${items.length}: ${item.file.basename}`);

				if (!(await this.refreshItem(item))) {
					throw new Error(`Karte mit ID ${item.noteId} nicht mehr in ${item.file.path} gefunden.`);
				}

				// targetIndex sorgt dafür, dass nur diese eine Karte angefasst wird.
				await syncAnkiBlock(
					this.plugin,
					item.blockSource,
					item.deckName,
					item.blockCards,
					item.file,
					item.cardIndex
				);

				synced.add(item);
				this.selected.delete(item);
			} catch (e: any) {
				failed++;
				console.error('[DriftReview] Sync fehlgeschlagen für', item.file.path, item.noteId, e);
			}
		}

		notice.hide();
		this.syncBtn.setDisabled(false);

		if (failed > 0) {
			new Notice(`${synced.size} übertragen, ${failed} fehlgeschlagen. Details in der Konsole.`, 8000);
		} else {
			new Notice(`${synced.size} Karten nach Anki übertragen.`);
		}

		// Nur die tatsächlich übertragenen Einträge verschwinden aus der Liste.
		this.report.items = this.report.items.filter((i) => !synced.has(i));
		this.renderList();
	}

	onClose() {
		this.contentEl.empty();
	}
}
