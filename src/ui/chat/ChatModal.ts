import { Component, MarkdownRenderer, Modal, Notice, TFile, TAbstractFile, loadMermaid, setIcon } from 'obsidian';
import AnkiGeneratorPlugin from '../../main';
import { ChatMessage } from '../../types';
import { ChatPanel } from './ChatPanel';
import { Suggestion, entschaerfePluginFences } from '../../chat/suggestions';
import { berechneVergleich, Vergleich } from '../../chat/vergleich';
import { getAnkiBlocks, parseCardsFromBlockSource } from '../../anki/ankiParser';
import { renderMermaidInElement } from '../../mermaidRenderer';

type Ansicht = 'vergleich' | 'notiz';

/**
 * Der AI-Chat gross: links Chat und Vorschlaege, rechts Vorher/Nachher des
 * gewaehlten Vorschlags oder die ganze Notiz gerendert.
 *
 * Im Notiz-Block war alles zu klein, um ein Diagramm oder eine geaenderte
 * Karte wirklich zu beurteilen (03.10.2026). Der Verlauf ist derselbe wie im
 * Block und in der Seitenleiste – dasselbe Array aus `feedbackCache`.
 */
export class ChatModal extends Modal {
	private plugin: AnkiGeneratorPlugin;
	private sourcePath: string;
	private panel: ChatPanel | null = null;

	private ansicht: Ansicht = 'vergleich';
	private quelltext = false;
	private gewaehlt: Suggestion | null = null;

	private rechts!: HTMLElement;
	private inhalt!: HTMLElement;
	private tabs: Record<Ansicht, HTMLElement> = {} as Record<Ansicht, HTMLElement>;
	private quellKnopf!: HTMLElement;
	private renderKomponente: Component | null = null;
	private neuTimer = 0;

	constructor(plugin: AnkiGeneratorPlugin, sourcePath: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.sourcePath = sourcePath;
	}

	onOpen() {
		this.modalEl.addClass('anki-chat-modal');
		const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
		this.titleEl.setText('AI Chat – ' + (file instanceof TFile ? file.basename : this.sourcePath));

		const raster = this.contentEl.createDiv({ cls: 'anki-chat-modal-grid' });
		const links = raster.createDiv({ cls: 'anki-chat-modal-chat' });
		this.rechts = raster.createDiv({ cls: 'anki-chat-modal-vergleich' });

		let history: ChatMessage[] | undefined = this.plugin.feedbackCache.get(this.sourcePath);
		if (!history) {
			history = [];
			this.plugin.feedbackCache.set(this.sourcePath, history);
		}

		this.panel = new ChatPanel(this.plugin, links, history, this.sourcePath, {
			collapsible: false,
			onVorschlagWaehlen: (s) => {
				this.gewaehlt = s;
				this.zeige('vergleich');
			}
		});
		this.panel.load();
		this.panel.build();

		this.baueRechts();
		void this.zeichne();

		// Nach einer Übernahme (oder Handarbeit) sofort den neuen Stand zeigen.
		const beiAenderung = (f: TAbstractFile) => {
			if (f.path !== this.sourcePath) return;
			window.clearTimeout(this.neuTimer);
			this.neuTimer = window.setTimeout(() => void this.zeichne(), 250);
		};
		this.panel.registerEvent(this.app.vault.on('modify', beiAenderung));

		window.setTimeout(() => this.contentEl.querySelector('textarea')?.focus(), 50);
	}

	onClose() {
		window.clearTimeout(this.neuTimer);
		this.renderKomponente?.unload();
		this.panel?.unload();
		this.panel = null;
		this.contentEl.empty();
		// Block und Seitenleiste auf den Stand des Modals bringen.
		this.app.workspace.trigger('anki:chat-update', this.sourcePath,
			this.plugin.feedbackCache.get(this.sourcePath) || []);
	}

	private baueRechts() {
		const kopf = this.rechts.createDiv({ cls: 'anki-vergleich-kopf' });
		const reiter = kopf.createDiv({ cls: 'anki-vergleich-tabs' });
		const tab = (a: Ansicht, text: string, icon: string) => {
			const el = reiter.createEl('button', { cls: 'anki-vergleich-tab' });
			setIcon(el.createSpan(), icon);
			el.createSpan({ text });
			el.addEventListener('click', () => this.zeige(a));
			this.tabs[a] = el;
		};
		tab('vergleich', 'Vergleich', 'columns-2');
		tab('notiz', 'Notiz', 'file-text');

		this.quellKnopf = kopf.createEl('button', { cls: 'anki-vergleich-quelle', text: 'Quelltext' });
		this.quellKnopf.addEventListener('click', () => {
			this.quelltext = !this.quelltext;
			void this.zeichne();
		});

		this.inhalt = this.rechts.createDiv({ cls: 'anki-vergleich-inhalt' });
	}

	private zeige(a: Ansicht) {
		this.ansicht = a;
		void this.zeichne();
	}

	private async zeichne() {
		(Object.keys(this.tabs) as Ansicht[]).forEach((k) => this.tabs[k].toggleClass('is-active', k === this.ansicht));
		this.quellKnopf.toggleClass('is-active', this.quelltext);

		const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);

		const scroll = this.inhalt.scrollTop;
		this.renderKomponente?.unload();
		this.renderKomponente = new Component();
		this.renderKomponente.load();
		this.inhalt.empty();

		if (this.ansicht === 'notiz') {
			await this.markdown(this.inhalt, content);
			this.inhalt.scrollTop = scroll;
			return;
		}

		if (!this.gewaehlt) {
			this.inhalt.createDiv({
				cls: 'anki-vergleich-leer',
				text: 'Klicke links auf einen Vorschlag, um Vorher und Nachher nebeneinander zu sehen.'
			});
			return;
		}

		const bloecke = getAnkiBlocks(content).map((b) => ({ cards: parseCardsFromBlockSource(b.innerClean) }));
		const v = berechneVergleich(content, bloecke, this.gewaehlt);
		if (!v) {
			this.inhalt.createDiv({ cls: 'anki-vergleich-leer', text: 'Dieser Vorschlag lässt sich nicht vergleichen.' });
			return;
		}
		await this.zeichneVergleich(v);
	}

	private async zeichneVergleich(v: Vergleich) {
		if (v.hinweis) this.inhalt.createDiv({ cls: 'anki-vergleich-hinweis', text: v.hinweis });

		if (v.art === 'text' && this.quelltext) {
			const pre = this.inhalt.createEl('pre', { cls: 'anki-suggestion-diff anki-vergleich-diff' });
			v.entfernt.forEach((l) => pre.createSpan({ cls: 'anki-diff-line is-remove', text: '- ' + l }));
			v.hinzu.forEach((l) => pre.createSpan({ cls: 'anki-diff-line is-add', text: '+ ' + l }));
			return;
		}

		const spalten = this.inhalt.createDiv({ cls: 'anki-vergleich-spalten' });
		const quelle = (k: { q: string; a: string } | null) => !k ? '' : k.a ? `Q: ${k.q}\nA: ${k.a}` : `Q: ${k.q}`;
		const spalte = (titel: string, cls: string, text: string) => {
			const s = spalten.createDiv({ cls: 'anki-vergleich-spalte ' + cls });
			const kopf = s.createDiv({ cls: 'anki-vergleich-spaltentitel' });
			kopf.createSpan({ text: titel });
			if (text) {
				// Markdown-Quelltext kopieren; markierter Text geht ohnehin.
				const k = kopf.createEl('button', { cls: 'anki-chat-copy', attr: { 'aria-label': titel + ' kopieren' } });
				setIcon(k, 'copy');
				k.addEventListener('click', () => {
					void navigator.clipboard.writeText(text).then(() => new Notice('Kopiert.'));
				});
			}
			return s.createDiv({ cls: 'anki-vergleich-spalteninhalt markdown-rendered' });
		};
		const vorher = spalte('Vorher', 'is-vorher', v.art === 'text' ? v.vorher : quelle(v.vorher));
		const nachher = spalte('Nachher', 'is-nachher', v.art === 'text' ? v.nachher : quelle(v.nachher));

		if (v.art === 'text') {
			if (v.vorher) await this.inhaltOderQuelle(vorher, v.vorher);
			else vorher.createDiv({ cls: 'anki-vergleich-leer', text: '—' });
			await this.inhaltOderQuelle(nachher, v.nachher);
			return;
		}

		const karte = async (ziel: HTMLElement, k: { q: string; a: string } | null, leer: string) => {
			if (!k) {
				ziel.createDiv({ cls: 'anki-vergleich-leer', text: leer });
				return;
			}
			const box = ziel.createDiv({ cls: 'anki-vergleich-karte' });
			box.createDiv({ cls: 'anki-vergleich-kartenlabel', text: 'Frage' });
			await this.inhaltOderQuelle(box.createDiv(), k.q);
			if (k.a) {
				box.createDiv({ cls: 'anki-vergleich-kartenlabel', text: 'Antwort' });
				await this.inhaltOderQuelle(box.createDiv(), k.a);
			}
		};
		await karte(vorher, v.vorher, 'Neue Karte – vorher gab es sie nicht.');
		await karte(nachher, v.nachher, 'Karte wird gelöscht.');
	}

	private async inhaltOderQuelle(ziel: HTMLElement, text: string) {
		if (this.quelltext) {
			ziel.createEl('pre', { cls: 'anki-vergleich-quelltext', text });
			return;
		}
		await this.markdown(ziel, text);
	}

	/** Markdown rendern, Plugin-Fences entschaerft, Mermaid als Bild. */
	private async markdown(ziel: HTMLElement, text: string) {
		await MarkdownRenderer.render(this.app, entschaerfePluginFences(text), ziel, this.sourcePath,
			this.renderKomponente ?? this.panel!);
		if (ziel.querySelector('code.language-mermaid')) {
			try { await loadMermaid(); } catch { /* window.mermaid reicht dann evtl. */ }
			await renderMermaidInElement(ziel);
		}
	}
}
