import { ButtonComponent, MarkdownRenderer, Menu, Notice, Platform, TFile, setIcon, Component, loadMermaid, requestUrl } from 'obsidian';
import AnkiGeneratorPlugin from '../../main';
import { AiProvider, ChatMessage, KartenBezug, VorschlagZustand } from '../../types';
import { streamChatResponse, generateFeedbackOnly, buildChatSystemPrompt } from '../../aiGenerator';
import { resolveProvider, PROVIDERS, getAvailableProviders, modelLabel } from '../../providers';
import { MermaidEditorModal } from '../MermaidEditorModal';
import { klappbareCallouts } from '../callouts';
import { ersetzeGleicheMermaid } from '../../mermaid/mermaidBloecke';
import { diagrammNorm, mapVorschlagText, entschaerfePluginFences, mermaidAusVorschlag, parseAntwort, schluesselFuer, vorschlagAlsBlock, QuelleSuggestion, Suggestion } from '../../chat/suggestions';
import { DiffTeil, linkText, wortDiff } from '../../chat/wortDiff';
import { zoteroZielFuer } from '../../chat/quellen';
import { applySuggestion, ladeKartenKontext } from '../../chat/applySuggestion';
import { locate } from '../../chat/textLocator';
import { setHistory, clearHistory, appendFeedbackToCache } from '../../chat/chatHistory';
import { ohneAlteKarten } from '../../anki/legacyStrip';
import { getAnkiBlocks,parseCardsFromBlockSource, formatCardsToExistingCardsString } from '../../anki/ankiParser';
import { ZoteroClient, ZoteroSource, collectionPath } from '../../zotero/zoteroClient';
import { ZoteroAbgleichModal, AbgleichAuswahl } from '../ZoteroAbgleichModal';
import { MedikamentQuellenModal } from '../MedikamentQuellenModal';
import { anknuepfungAnQuellensuche, buildAbgleichPrompt, readableDirs } from '../../agent/abgleichPrompt';
import { runMitSitzung, defaultCliPath, defaultZoteroDataDir, AgentEvent } from '../../agent/claudeAgent';
import { buildKonzeptkartenAuftrag, rechercheHinweise } from '../../agent/verstehenPrompt';

export interface ChatPanelOptions {
	/** Im Notiz-Block statt in der Sidebar: begrenzte Höhe, keine Kopfzeilen-Aktionen. */
	embedded?: boolean;
	/** Callback für "In neuem Tab öffnen". */
	onPopOut?: () => void;
	collapsible?: boolean;
	/** Groß im Modal öffnen (Knopf in der Kopfzeile). */
	onMaximize?: () => void;
	/**
	 * Ein Vorschlag wurde zum Vergleichen gewählt. Gesetzt nur im Modal – dort
	 * zeigt die rechte Spalte Vorher/Nachher.
	 */
	onVorschlagWaehlen?: (s: Suggestion, diagrammBearbeiten?: () => void) => void;
	/** Ein Vorschlag wurde übernommen, verworfen oder zurückgenommen. */
	onZustand?: () => void;
}

/**
 * Der AI-Chat.
 *
 * Kernunterschied zum alten Renderer: hier wird NICHT bei jeder Nachricht das
 * gesamte DOM neu gebaut. Nachrichten werden angehängt, wodurch Eingabefeld,
 * Scrollposition und Fokus erhalten bleiben.
 */
export class ChatPanel extends Component {
	private plugin: AnkiGeneratorPlugin;
	private container: HTMLElement;
	private options: ChatPanelOptions;

	private root!: HTMLElement;
	private log!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private sendBtn!: ButtonComponent;

	private history: ChatMessage[] = [];
	private sourcePath: string | undefined;

	/** Wie viele Nachrichten der History bereits im DOM stehen. */
	private renderedCount = 0;
	private controller: AbortController | null = null;
	private collapsed = false;
	/** Pruefungen offener Vorschlaege – nach jeder Übernahme erneut ausgefuehrt. */
	private pruefungen = new Map<HTMLElement, () => void>();
	/** Kontext jeder Vorschlagsbox: Original, Nachricht, Begruendung. */
	private boxKontext = new WeakMap<HTMLElement, BoxKontext>();
	private modellChip!: HTMLElement;
	/** Zu welcher Nachricht eine Blase gehoert – Diagramm-Edits landen im Verlauf. */
	private blaseNachricht = new WeakMap<HTMLElement, ChatMessage>();

	constructor(
		plugin: AnkiGeneratorPlugin,
		container: HTMLElement,
		history: ChatMessage[],
		sourcePath: string | undefined,
		options: ChatPanelOptions = {}
	) {
		super();
		this.plugin = plugin;
		this.container = container;
		this.history = history;
		this.sourcePath = sourcePath;
		this.options = options;
	}

	// --- Aufbau -----------------------------------------------------------

	build() {
		this.root = this.container.createDiv({ cls: 'anki-chat-panel' });
		if (this.options.embedded) this.root.addClass('is-embedded');

		this.buildHeader();

		const body = this.root.createDiv({ cls: 'anki-chat-body' });
		this.log = body.createDiv({ cls: 'anki-chat-log' });
		this.buildInput(body);

		this.renderAll();
		// Erst nach renderAll(): vorher gibt es keine Boxen zum Markieren.
		this.lauscheAufUebernahmen();
		this.lauscheAufVerlauf();
		if (this.options.embedded) this.merkeHoehe();
	}

	/**
	 * Der eingebettete Chat ist per CSS (`resize: vertical`) aufziehbar. Die
	 * gewaehlte Hoehe gilt fuer alle Notizen und ueberlebt Neustarts – sonst
	 * stuende er bei jeder Notiz wieder auf 320 px.
	 */
	private merkeHoehe() {
		const KEY = 'anki-generator-chat-hoehe';
		try {
			const h = parseInt(window.localStorage.getItem(KEY) || '', 10);
			if (h >= 160) this.log.style.height = `${h}px`;
		} catch { /* Speicher gesperrt: Standardhoehe */ }

		let timer = 0;
		const obs = new ResizeObserver(() => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				const h = Math.round(this.log.getBoundingClientRect().height);
				// 0 = eingeklappt oder ausgeblendet, nicht speichern.
				if (h < 160) return;
				try { window.localStorage.setItem(KEY, String(h)); } catch { /* egal */ }
			}, 300);
		});
		obs.observe(this.log);
		this.register(() => obs.disconnect());
	}

	private buildHeader() {
		const header = this.root.createDiv({ cls: 'anki-chat-header' });

		const arrow = header.createSpan({ cls: 'anki-chat-arrow' });
		setIcon(arrow, 'chevron-down');

		const icon = header.createSpan({ cls: 'anki-chat-role-icon' });
		setIcon(icon, 'bot');

		header.createEl('h4', { cls: 'anki-chat-header-title', text: 'AI Chat' });

		const controls = header.createDiv({ cls: 'anki-chat-header-controls' });
		controls.addEventListener('click', (e) => e.stopPropagation());

		if (this.options.onMaximize) {
			const max = new ButtonComponent(controls);
			max.setIcon('maximize-2').setTooltip('Groß öffnen (mit Vergleichsansicht)');
			max.onClick(() => this.options.onMaximize && this.options.onMaximize());
		}

		if (this.options.onPopOut) {
			const popOut = new ButtonComponent(controls);
			popOut.setIcon('external-link').setTooltip('In neuem Tab öffnen');
			popOut.onClick(() => this.options.onPopOut && this.options.onPopOut());
		}

		if (Platform.isDesktopApp) {
			const zoteroBtn = new ButtonComponent(controls);
			zoteroBtn.setIcon('library').setTooltip('Mit Zotero-Quellen abgleichen (Claude-Agent)');
			zoteroBtn.onClick(() => this.openZoteroAbgleich());

			const karteBtn = new ButtonComponent(controls);
			karteBtn.setIcon('network').setTooltip('Konzeptkarte: Zusammenhänge erklären (Claude-Agent). Text im Eingabefeld = Schwerpunkt');
			karteBtn.onClick(() => void this.konzeptkarte());

			const quellenBtn = new ButtonComponent(controls);
			quellenBtn.setIcon('folder-plus').setTooltip('Medikament: Zotero-Quellen zusammenstellen');
			quellenBtn.onClick(() => {
				const file = this.sourcePath && this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
				if (!(file instanceof TFile)) { new Notice('Keine Notiz.'); return; }
				new MedikamentQuellenModal(this.plugin.app, this.plugin, file.basename, file.path).open();
			});
		}

		const feedbackBtn = new ButtonComponent(controls);
		feedbackBtn.setIcon('search-check').setTooltip('Feedback zur Notiz einholen');
		feedbackBtn.onClick(() => void this.requestFeedback());

		const clearBtn = new ButtonComponent(controls);
		clearBtn.setIcon('trash').setTooltip('Chat leeren');
		clearBtn.onClick(() => {
			this.history.length = 0;
			clearHistory(this.plugin, this.sourcePath);
			this.renderAll();
		});

		if (this.options.collapsible !== false) {
			header.addEventListener('click', () => {
				this.collapsed = !this.collapsed;
				this.root.toggleClass('is-collapsed', this.collapsed);
			});
		}
	}

	private buildInput(body: HTMLElement) {
		const area = body.createDiv({ cls: 'anki-chat-input-area' });

		this.input = area.createEl('textarea', {
			attr: { placeholder: 'Frage an die KI…', rows: '1' }
		});

		// Mitwachsendes Eingabefeld statt fester 40px.
		const autoGrow = () => {
			this.input.style.height = 'auto';
			this.input.style.height = Math.min(this.input.scrollHeight, 180) + 'px';
		};
		this.registerDomEvent(this.input, 'input', autoGrow);
		this.registerDomEvent(this.input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		});

		this.sendBtn = new ButtonComponent(area);
		this.sendBtn.setIcon('send').setTooltip('Senden (Enter)');
		this.sendBtn.buttonEl.addClass('anki-chat-send');
		this.sendBtn.onClick(() => void this.send());

		const hint = body.createDiv({ cls: 'anki-chat-hint' });
		this.modellChip = hint.createEl('button', { cls: 'anki-chat-modell', attr: { 'aria-label': 'Wer antwortet?' } });
		this.registerDomEvent(this.modellChip, 'click', (e: MouseEvent) => this.zeigeModellMenue(e));
		this.zeichneModellChip();
		hint.createSpan({ text: 'Enter senden · Shift+Enter neue Zeile' });
	}

	// --- Modellwahl ---------------------------------------------------------

	/** Gewaehlter Antwortgeber: Anbieter oder 'claude-agent'. null = keiner verfuegbar. */
	private gewaehltesModell(): AiProvider | 'claude-agent' | null {
		const s = this.plugin.settings;
		if (s.chatProvider === 'claude-agent' && Platform.isDesktopApp) return 'claude-agent';
		const p = s.chatProvider as AiProvider;
		if (p && PROVIDERS[p] && PROVIDERS[p].isAvailable(s)) return p;
		return resolveProvider(s);
	}

	private modellName(m: AiProvider | 'claude-agent' | null): string {
		if (m === 'claude-agent') {
			const mod = this.plugin.settings.claudeAgentModel;
			return mod ? `Claude-Agent (${mod})` : 'Claude-Agent';
		}
		if (!m) return 'kein Modell';
		return `${PROVIDERS[m].label.replace(/^(Google|Anthropic) /, '')} · ${modelLabel(m, this.plugin.settings)}`;
	}

	private zeichneModellChip() {
		if (!this.modellChip) return;
		const m = this.gewaehltesModell();
		this.modellChip.empty();
		setIcon(this.modellChip.createSpan({ cls: 'anki-chat-modell-icon' }), m === 'claude-agent' ? 'library' : 'sparkles');
		this.modellChip.createSpan({ text: this.modellName(m) });
		setIcon(this.modellChip.createSpan({ cls: 'anki-chat-modell-icon' }), 'chevron-down');
	}

	private zeigeModellMenue(e: MouseEvent) {
		const s = this.plugin.settings;
		const aktuell = this.gewaehltesModell();
		const menu = new Menu();
		const waehle = async (wert: string) => {
			s.chatProvider = wert;
			await this.plugin.saveSettings();
			this.zeichneModellChip();
			// Andere offene Chats zeigen dieselbe Wahl.
			this.plugin.app.workspace.trigger('anki:chat-modell');
		};
		getAvailableProviders(s).forEach((p) => {
			menu.addItem((item) => item
				.setTitle(this.modellName(p))
				.setChecked(aktuell === p)
				.onClick(() => void waehle(p)));
		});
		if (Platform.isDesktopApp) {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle('Claude-Agent – Zotero + Websuche')
				.setIcon('library')
				.setChecked(aktuell === 'claude-agent')
				.onClick(() => void waehle('claude-agent')));
		}
		menu.showAtMouseEvent(e);
	}

	// --- Rendering --------------------------------------------------------

	/** Vollständig neu zeichnen (nur bei Notizwechsel oder Leeren nötig). */
	renderAll() {
		this.log.empty();
		this.pruefungen.clear();
		this.renderedCount = 0;

		if (this.history.length === 0) {
			this.log.createDiv({
				cls: 'anki-chat-empty',
				text: 'Noch keine Nachrichten. Stelle eine Frage oder hole Feedback zur Notiz ein.'
			});
			return;
		}

		this.appendPending();
		this.scrollToBottom();
	}

	/** Nur die noch nicht gezeichneten Nachrichten anhängen. */
	appendPending() {
		const empty = this.log.querySelector('.anki-chat-empty');
		if (empty && this.history.length > 0) empty.remove();

		for (let i = this.renderedCount; i < this.history.length; i++) {
			void this.renderMessage(this.history[i]);
		}
		this.renderedCount = this.history.length;
	}

	get rootEl(): HTMLElement {
		return this.root;
	}

	get path(): string | undefined {
		return this.sourcePath;
	}

	/**
	 * Auf dasselbe (moeglicherweise neue) Array zeigen und nur Neues zeichnen.
	 * Wurde der Verlauf gekuerzt oder geleert, wird komplett neu gezeichnet.
	 */
	syncHistoryRef(history: ChatMessage[]) {
		const shrunk = history.length < this.renderedCount;
		this.history = history;
		if (shrunk) {
			this.renderAll();
		} else {
			this.appendPending();
		}
	}

	/** Historie von außen ersetzen (Notizwechsel, Sync-Event). */
	setHistoryAndRender(history: ChatMessage[], sourcePath: string | undefined) {
		this.history = history;
		this.sourcePath = sourcePath;
		this.renderAll();
	}

	private async renderMessage(msg: ChatMessage): Promise<HTMLElement> {
		const wrapper = this.log.createDiv({
			cls: `anki-chat-message ${msg.role === 'ai' ? 'is-ai' : 'is-user'}`
		});

		const role = wrapper.createDiv({ cls: 'anki-chat-role' });
		const roleIcon = role.createSpan({ cls: 'anki-chat-role-icon' });
		setIcon(roleIcon, msg.role === 'ai' ? 'bot' : 'user');
		role.createSpan({ text: msg.role === 'ai' ? (msg.modell ? `KI · ${msg.modell}` : 'KI') : 'Du' });

		// Ganze Nachricht als Markdown kopieren – msg.content erst beim Klick
		// lesen, der Platzhalter einer gestreamten Antwort wird spaeter befuellt.
		const kopieren = role.createEl('button', { cls: 'anki-chat-copy', attr: { 'aria-label': 'Nachricht kopieren' } });
		setIcon(kopieren, 'copy');
		kopieren.addEventListener('click', () => {
			void navigator.clipboard.writeText(msg.content).then(() => new Notice('Kopiert.'));
		});

		const bubble = wrapper.createDiv({ cls: 'anki-chat-bubble' });
		this.blaseNachricht.set(bubble, msg);
		await this.renderBody(bubble, msg.content, msg.role === 'ai');

		return wrapper;
	}

	/** Fließtext als Markdown, Vorschläge als eigene Boxen – in Reihenfolge. */
	private async renderBody(bubble: HTMLElement, content: string, isAi: boolean) {
		bubble.empty();

		if (!isAi) {
			if (content) await MarkdownRenderer.render(this.plugin.app, content, bubble, this.sourcePath || '', this);
			return;
		}

		// Begruendung und Vorschlag gehoeren zusammen: der Absatz direkt vor
		// einem Block steht in dessen Box, nicht gesammelt ueber allen.
		const msg = this.blaseNachricht.get(bubble);
		const teile = parseAntwort(content);
		const anzahl = teile.filter((t) => t.art === 'vorschlag').length;
		let leisteGesetzt = false;

		for (const teil of teile) {
			if (teil.art === 'text') {
				// Jede uebrig gebliebene Plugin-Sprachmarke entschaerfen – sonst
				// rendert der eigene anki-cards-Prozessor in die Chat-Blase und
				// die App friert ein.
				const div = bubble.createDiv({ cls: 'anki-chat-prose' });
				await MarkdownRenderer.render(this.plugin.app, entschaerfePluginFences(teil.text), div, this.sourcePath || '', this);
				klappbareCallouts(div);
				continue;
			}
			if (!leisteGesetzt && anzahl > 1) {
				bubble.createDiv({ cls: 'anki-vs-leiste' });
				leisteGesetzt = true;
			}
			this.renderSuggestion(bubble, teil.vorschlag, msg, teil.warum);
		}
		this.aktualisiereLeiste(bubble);
	}

	/** „5 Vorschläge · 1 übernommen · 1 verworfen" über den Vorschlägen. */
	private aktualisiereLeiste(bubble: HTMLElement) {
		const leiste = bubble.querySelector('.anki-vs-leiste') as HTMLElement | null;
		if (!leiste) return;
		const boxen = Array.from(bubble.querySelectorAll('.anki-suggestion'));
		const uebernommen = boxen.filter((b) => b.hasClass('is-applied')).length;
		const verworfen = boxen.filter((b) => b.hasClass('is-dismissed')).length;
		leiste.empty();
		leiste.createSpan({ cls: 'anki-vs-leiste-zahl', text: `${boxen.length} Vorschläge` });
		if (uebernommen) leiste.createSpan({ cls: 'anki-vs-pille', text: `${uebernommen} übernommen` });
		if (verworfen) leiste.createSpan({ cls: 'anki-vs-pille', text: `${verworfen} verworfen` });
	}

	/** Nach einer frischen Antwort: ersten Vorschlag gleich im Vergleich zeigen. */
	private waehleErsten(bubble: HTMLElement) {
		if (!this.options.onVorschlagWaehlen) return;
		const box = bubble.querySelector('.anki-suggestion:not(.is-applied):not(.is-dismissed)') as HTMLElement | null;
		box?.click();
	}

	private markiereGewaehlt(box: HTMLElement) {
		this.log.querySelectorAll('.anki-suggestion.is-selected')
			.forEach((el) => el.removeClass('is-selected'));
		box.addClass('is-selected');
	}

	private renderSuggestion(parent: HTMLElement, vorschlag: Suggestion, msg: ChatMessage | undefined, warum: string): HTMLElement {
		const box = parent.createDiv({ cls: 'anki-suggestion' });
		// Inhaltsschluessel am Element, damit jede andere offene Ansicht
		// dieselbe Box wiederfindet. Er kommt vom ORIGINAL – bearbeitete
		// Fassungen haengen im Verlauf unter genau diesem Schluessel.
		const schluessel = schluesselFuer(vorschlag);
		box.dataset.ankiVorschlag = schluessel;

		// Kartenbezug aus dem gespeicherten Kartenstand der Antwort.
		if (vorschlag.kind === 'card' && vorschlag.ref !== null && msg?.karten) {
			const b = msg.karten[vorschlag.ref - 1];
			if (b) vorschlag = { ...vorschlag, bezug: b };
		}

		const ktx: BoxKontext = { box, original: vorschlag, schluessel, msg, warum, bearbeiten: false, quelltext: false };
		this.boxKontext.set(box, ktx);

		if (this.options.onVorschlagWaehlen) {
			box.addClass('is-selectable');
			box.addEventListener('click', (e) => {
				const ziel = e.target as HTMLElement;
				if (ziel.closest('button, textarea, input, .anki-vs-zu')) return;
				// Wer Text markiert, will kopieren, nicht den Vergleich wechseln.
				if (window.getSelection()?.toString()) return;
				if (ktx.bearbeiten) return;
				const aktuell = this.aktuellerVorschlag(ktx);
				const diagramme = mermaidAusVorschlag(aktuell);
				this.markiereGewaehlt(box);
				this.options.onVorschlagWaehlen && this.options.onVorschlagWaehlen(aktuell,
					diagramme.length ? () => this.bearbeiteDiagramm(box, diagramme[0]) : undefined);
			});
		}

		this.zeichneBox(ktx);
		return box;
	}

	private zustand(ktx: BoxKontext): VorschlagZustand {
		return ktx.msg?.vorschlaege?.[ktx.schluessel] ?? ktx.fluechtig ?? {};
	}

	/** Was „Übernehmen" anwenden würde: die bearbeitete Fassung oder das Original. */
	private aktuellerVorschlag(ktx: BoxKontext): Suggestion {
		return (this.zustand(ktx).bearbeitet as Suggestion | undefined) ?? ktx.original;
	}

	/**
	 * Zustand einer Box aendern und im Verlauf speichern – bearbeitete
	 * Fassungen, Übernahmen und Verwerfen ueberstehen so den Neustart.
	 */
	private setzeZustand(ktx: BoxKontext, aenderung: Partial<VorschlagZustand>) {
		const neu: VorschlagZustand = { ...this.zustand(ktx), ...aenderung };
		(Object.keys(neu) as (keyof VorschlagZustand)[]).forEach((k) => { if (neu[k] === undefined) delete neu[k]; });

		if (ktx.msg) {
			const alle = ktx.msg.vorschlaege ?? (ktx.msg.vorschlaege = {});
			if (Object.keys(neu).length) alle[ktx.schluessel] = neu;
			else delete alle[ktx.schluessel];
			if (!Object.keys(alle).length) delete ktx.msg.vorschlaege;
			setHistory(this.plugin, this.sourcePath, this.history);
		} else {
			ktx.fluechtig = neu;
		}

		this.zeichneBox(ktx);
		this.options.onZustand?.();
		const blase = ktx.box.closest('.anki-chat-bubble') as HTMLElement | null;
		if (blase) this.aktualisiereLeiste(blase);
		this.plugin.app.workspace.trigger('anki:vorschlag-zustand', this.sourcePath, ktx.schluessel, ktx.msg, neu);
	}

	/** Kurze Beschreibung für die zugeklappte Zeile. */
	private kurz(v: Suggestion): string {
		const k = (t: string) => {
			const s = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/\s+/g, ' ').trim();
			return s.length > 70 ? s.slice(0, 69) + '…' : s;
		};
		switch (v.kind) {
			case 'card': {
				const art = v.op === 'add' ? 'Neue Karte' : v.op === 'delete' ? 'Karte gelöscht' : 'Karte geändert';
				return `${art}: „${k(v.op === 'delete' ? (v.bezug?.q ?? `Karte ${v.ref ?? v.id}`) : v.q)}“`;
			}
			case 'edit': return `Textänderung: „${k(v.find)}“`;
			case 'insert': return `Eingefügt nach „${k(v.after)}“`;
			case 'quelle': return `Quelle: „${k(v.titel)}“`;
			default: return 'Nicht anwendbarer Vorschlag';
		}
	}

	/** Die Box komplett neu zeichnen – nach jeder Zustandsänderung. */
	private zeichneBox(ktx: BoxKontext) {
		const { box } = ktx;
		const z = this.zustand(ktx);
		const v = this.aktuellerVorschlag(ktx);
		this.pruefungen.delete(box);

		box.empty();
		box.className = 'anki-suggestion' + (box.hasClass('is-selected') ? ' is-selected' : '');
		if (this.options.onVorschlagWaehlen) box.addClass('is-selectable');
		box.addClass(artKlasse(v));

		// --- Zugeklappt: übernommen oder verworfen -------------------------
		if (z.status) {
			box.addClass(z.status === 'applied' ? 'is-applied' : 'is-dismissed');
			const zeile = box.createDiv({ cls: 'anki-vs-zu' });
			const icon = zeile.createSpan({ cls: 'anki-vs-zu-icon' });
			setIcon(icon, z.status === 'applied' ? 'check' : 'x');
			zeile.createSpan({ cls: 'anki-vs-zu-status', text: z.status === 'applied' ? 'Übernommen' : 'Verworfen' });
			zeile.createSpan({ cls: 'anki-vs-zu-text', text: this.kurz(v) });
			const rechts = zeile.createDiv({ cls: 'anki-vs-rechts' });
			if (z.status === 'applied') {
				if (RUECKGAENGIG.has(this.undoSchluessel(ktx))) {
					const b = rechts.createEl('button', { cls: 'anki-vs-leise', text: 'Rückgängig' });
					b.addEventListener('click', () => void this.macheRueckgaengig(ktx));
				}
			} else {
				const b = rechts.createEl('button', { cls: 'anki-vs-leise', text: 'Wiederherstellen' });
				b.addEventListener('click', () => this.setzeZustand(ktx, { status: undefined }));
			}
			return;
		}

		// --- Kopf ------------------------------------------------------------
		const kopf = box.createDiv({ cls: 'anki-vs-kopf' });
		const chip = kopf.createSpan({ cls: 'anki-vs-chip' });
		setIcon(chip.createSpan({ cls: 'anki-vs-chip-icon' }), artIcon(v));
		chip.createSpan({ text: artLabel(v) });
		const bezugEl = kopf.createSpan({ cls: 'anki-vs-bezug' });
		if (z.bearbeitet) kopf.createSpan({ cls: 'anki-vs-badge', text: 'bearbeitet' });

		const warumText = ktx.warum || (v.kind === 'quelle' ? v.grund ?? '' : '');
		if (warumText) {
			const warum = box.createDiv({ cls: 'anki-vs-warum' });
			setIcon(warum.createSpan({ cls: 'anki-vs-warum-icon' }), 'message-square');
			const text = warum.createDiv({ cls: 'anki-vs-warum-text' });
			void MarkdownRenderer.render(this.plugin.app, warumText, text, this.sourcePath || '', this);
		}

		if (v.kind === 'card' && v.op !== 'add') {
			bezugEl.setText(v.bezug ? `„${einzeilig(v.bezug.q)}“` : (v.ref !== null ? `Karte ${v.ref}` : `ID ${v.id}`));
		}

		if (ktx.bearbeiten) {
			this.zeichneFormular(ktx, v);
			return;
		}

		const felder = box.createDiv({ cls: 'anki-vs-felder' });
		const notizen = box.createDiv({ cls: 'anki-vs-notizen' });
		const quelle = box.createEl('pre', { cls: 'anki-vs-quelle', text: vorschlagAlsBlock(v) });
		quelle.toggleClass('is-collapsed', !ktx.quelltext);
		const notiz = (text: string, info = false) =>
			notizen.createDiv({ cls: 'anki-suggestion-note' + (info ? ' is-info' : ''), text });

		// --- Aktionen --------------------------------------------------------
		const aktionen = box.createDiv({ cls: 'anki-suggestion-actions' });
		const haupt = new ButtonComponent(aktionen);
		const hauptText = v.kind === 'card' && v.op === 'add' ? 'Hinzufügen'
			: v.kind === 'card' && v.op === 'delete' ? 'Löschen'
				: v.kind === 'quelle' ? 'In Notiz eintragen' : 'Übernehmen';
		haupt.setButtonText(hauptText).setCta();
		if (v.kind === 'card' && v.op === 'delete') haupt.buttonEl.addClass('mod-warning');
		if (v.kind === 'invalid') haupt.buttonEl.remove();
		haupt.onClick(() => void this.uebernehme(ktx, haupt, notizen));

		if (v.kind === 'invalid') {
			const b = new ButtonComponent(aktionen);
			b.setButtonText('Als Textänderung bearbeiten');
			b.onClick(() => {
				ktx.bearbeiten = true;
				this.setzeZustand(ktx, { bearbeitet: { kind: 'edit', find: v.raw, replace: v.raw } });
			});
		} else if (!(v.kind === 'card' && v.op === 'delete')) {
			const b = new ButtonComponent(aktionen);
			b.setButtonText('Bearbeiten');
			b.onClick(() => { ktx.bearbeiten = true; this.zeichneBox(ktx); });
		}

		if (v.kind === 'edit' || v.kind === 'insert') {
			const anker = v.kind === 'edit' ? v.find : v.after;
			const b = new ButtonComponent(aktionen);
			b.setButtonText('Zeigen');
			b.onClick(() => void this.revealInNote(anker));
		}

		const diagramme = mermaidAusVorschlag(v);
		diagramme.forEach((code, k) => {
			const b = new ButtonComponent(aktionen);
			b.setIcon('pencil').setButtonText(diagramme.length > 1 ? `Diagramm ${k + 1}` : 'Diagramm');
			b.setTooltip('Mermaid-Editor: Richtung, Kanten, Abstände, Quelltext');
			b.onClick(() => this.bearbeiteDiagramm(box, code));
		});

		const rechts = aktionen.createDiv({ cls: 'anki-vs-rechts' });
		if (z.bearbeitet) {
			const b = rechts.createEl('button', { cls: 'anki-vs-leise', attr: { 'aria-label': 'Bearbeitung verwerfen, Vorschlag der KI wiederherstellen' } });
			setIcon(b.createSpan({ cls: 'anki-vs-leise-icon' }), 'rotate-ccw');
			b.createSpan({ text: 'Original' });
			b.addEventListener('click', () => this.setzeZustand(ktx, { bearbeitet: undefined }));
		}
		const qb = rechts.createEl('button', { cls: 'anki-vs-leise', text: ktx.quelltext ? 'Quelltext aus' : 'Quelltext' });
		qb.addEventListener('click', () => {
			ktx.quelltext = !ktx.quelltext;
			quelle.toggleClass('is-collapsed', !ktx.quelltext);
			qb.setText(ktx.quelltext ? 'Quelltext aus' : 'Quelltext');
		});
		const vb = rechts.createEl('button', { cls: 'anki-vs-leise', text: 'Verwerfen' });
		vb.addEventListener('click', () => this.setzeZustand(ktx, { status: 'dismissed' }));

		// --- Inhalt je Art ---------------------------------------------------
		if (v.kind === 'invalid') {
			box.addClass('is-missing');
			felder.createEl('pre', { cls: 'anki-vs-roh', text: v.raw });
			notiz(v.reason);
			return;
		}

		if (diagramme.length) {
			// Diagramme gezeichnet zeigen und vorab pruefen: ein Syntaxfehler
			// soll hier auffallen, nicht erst als leere Flaeche in der Notiz.
			felder.addClass('is-collapsed');
			const vorschau = box.createDiv({ cls: 'anki-suggestion-preview' });
			box.insertBefore(vorschau, felder);
			const toggle = box.createDiv({ cls: 'anki-suggestion-source-toggle', text: 'Text zeigen' });
			box.insertBefore(toggle, felder);
			toggle.addEventListener('click', () => {
				felder.toggleClass('is-collapsed', !felder.hasClass('is-collapsed'));
				toggle.setText(felder.hasClass('is-collapsed') ? 'Text zeigen' : 'Text verbergen');
			});
			void this.zeichneDiagramme(vorschau, diagramme).then((fehler) => {
				if (!fehler) return;
				haupt.setDisabled(true);
				haupt.setButtonText('Diagramm fehlerhaft');
				box.addClass('is-missing');
				notiz('Mermaid-Syntaxfehler: ' + fehler);
			});
		}

		if (v.kind === 'edit') {
			feld(felder, '', wortDiff(v.find, v.replace));
			const pruefe = () => void this.notizInhalt().then((content) => {
				if (!box.isConnected || this.zustand(ktx).status) return;
				notizen.querySelectorAll('.is-locate').forEach((el) => el.remove());
				const hit = content !== null ? locate(content, v.find) : null;
				box.toggleClass('is-missing', !hit);
				if (hit && content !== null) bezugEl.setText(abschnittVor(content, hit.start));
				else notiz('Textstelle nicht in der Notiz gefunden. Passe „Wird ersetzt“ über „Bearbeiten“ an oder prüfe die Stelle über „Zeigen“.').addClass('is-locate');
			});
			this.pruefungen.set(box, pruefe);
			pruefe();
			return;
		}

		if (v.kind === 'insert') {
			bezugEl.setText(`nach „${einzeilig(v.after)}“`);
			feld(felder, '', [{ art: 'neu', text: v.text }]);
			const pruefe = () => void this.notizInhalt().then((content) => {
				if (!box.isConnected || this.zustand(ktx).status) return;
				notizen.querySelectorAll('.is-locate').forEach((el) => el.remove());
				const hit = content !== null ? locate(content, v.after) : null;
				box.toggleClass('is-missing', !hit);
				if (!hit) notiz('Ankerzeile nicht in der Notiz gefunden – evtl. erst einen anderen Vorschlag übernehmen.').addClass('is-locate');
			});
			this.pruefungen.set(box, pruefe);
			pruefe();
			return;
		}

		if (v.kind === 'quelle') {
			this.zeichneQuelle(ktx, v, { felder, notizen, aktionen, haupt, bezugEl });
			return;
		}

		// Karten: erst ohne Vergleich zeichnen, dann mit der aktuellen Karte.
		const zeichneKarte = (alt: { q: string; a: string } | null) => {
			felder.empty();
			if (v.op === 'delete') {
				const q = alt?.q ?? v.bezug?.q ?? '';
				if (q) feld(felder, 'Frage', [{ art: 'weg', text: q }]);
				if (alt?.a) feld(felder, 'Antwort', [{ art: 'weg', text: alt.a }]);
				return;
			}
			const typ = v.typeIn ? 'Antwort (Eintippen)' : 'Antwort';
			if (v.op === 'add' || !alt) {
				feld(felder, 'Frage', [{ art: v.op === 'add' ? 'neu' : 'gleich', text: v.q }]);
				if (v.a) feld(felder, typ, [{ art: v.op === 'add' ? 'neu' : 'gleich', text: v.a }]);
				return;
			}
			// Die Frage steht schon im Kopf – nur zeigen, wenn sie sich aendert.
			if (alt.q !== v.q) feld(felder, 'Frage', wortDiff(alt.q, v.q));
			if (v.a || alt.a) feld(felder, typ, wortDiff(alt.a, v.a));
			if (alt.q === v.q && alt.a === v.a) {
				felder.createDiv({ cls: 'anki-suggestion-note is-info', text: 'Keine Änderung gegenüber der Karte in der Notiz.' });
			}
		};
		zeichneKarte(null);

		const pruefe = () => void ladeKartenKontext(this.plugin.app, this.sourcePath, v).then((r) => {
			if (!box.isConnected || this.zustand(ktx).status) return;
			notizen.querySelectorAll('.is-locate').forEach((el) => el.remove());
			if (v.op === 'add') {
				bezugEl.setText(r.deck ? `in „${r.deck}“` : 'neuer Kartenblock');
				return;
			}
			const s = r.suche;
			if (s && s.ok && r.karte) {
				box.removeClass('is-missing');
				haupt.setDisabled(false);
				bezugEl.setText(`„${einzeilig(r.karte.q)}“`);
				zeichneKarte({ q: r.karte.q, a: r.karte.a });
				if (s.treffer.weg === 'frage') {
					notiz('Zugeordnet über die Ähnlichkeit der Frage – bitte prüfen.', true).addClass('is-locate');
				}
				return;
			}
			box.addClass('is-missing');
			haupt.setDisabled(true);
			notiz(s && !s.ok ? s.message : 'Karte nicht gefunden.').addClass('is-locate');
			if (v.op === 'update' && !aktionen.querySelector('.anki-vs-als-neu')) {
				const knopf = new ButtonComponent(aktionen);
				knopf.buttonEl.addClass('anki-vs-als-neu');
				knopf.setButtonText('Als neue Karte');
				knopf.setTooltip('Den Vorschlag als neue Karte in den anki-cards-Block übernehmen');
				aktionen.insertBefore(knopf.buttonEl, haupt.buttonEl.nextSibling);
				knopf.onClick(() => {
					this.setzeZustand(ktx, { bearbeitet: { ...v, op: 'add', id: null, ref: null, bezug: null } });
					if (this.options.onVorschlagWaehlen) box.click();
				});
			}
		});
		this.pruefungen.set(box, pruefe);
		pruefe();
	}

	/** Formular zum Bearbeiten – ändert nur die Fassung im Chat, nicht die Notiz. */
	private zeichneFormular(ktx: BoxKontext, v: Suggestion) {
		const form = ktx.box.createDiv({ cls: 'anki-vs-formular' });
		const eingaben: { name: string; el: HTMLTextAreaElement }[] = [];
		const feldEingabe = (label: string, name: string, wert: string, zeilen = 3) => {
			const f = form.createDiv({ cls: 'anki-vs-feld' });
			f.createDiv({ cls: 'anki-vs-feldname', text: label });
			const ta = f.createEl('textarea', { cls: 'anki-vs-eingabe' });
			ta.value = wert;
			ta.rows = Math.min(14, Math.max(zeilen, wert.split('\n').length + 1));
			eingaben.push({ name, el: ta });
			return ta;
		};

		if (v.kind === 'card') {
			feldEingabe('Frage', 'q', v.q, 2);
			feldEingabe(v.typeIn ? 'Antwort (Eintippen)' : 'Antwort', 'a', v.a, 3);
		} else if (v.kind === 'edit') {
			feldEingabe('Wird ersetzt (exakt wie in der Notiz)', 'find', v.find, 2);
			feldEingabe('Neuer Text', 'replace', v.replace, 3);
		} else if (v.kind === 'insert') {
			feldEingabe('Nach dieser Zeile', 'after', v.after, 1);
			feldEingabe('Einzufügender Text', 'text', v.text, 4);
		} else if (v.kind === 'quelle') {
			feldEingabe('Zitat (so kommt es unter „## Quellen“)', 'zitat', v.zitat, 3);
			feldEingabe('Titel', 'titel', v.titel, 1);
			feldEingabe('URL', 'url', v.url ?? '', 1);
			feldEingabe('PDF-URL (optional)', 'pdf_url', v.pdf_url ?? '', 1);
			feldEingabe('Zotero-Sammlung', 'sammlung', this.zoteroZiel(v), 1);
		}

		const wert = (name: string) => eingaben.find((e) => e.name === name)?.el.value ?? '';
		const speichern = () => {
			let neu: Suggestion = v;
			if (v.kind === 'card') neu = { ...v, q: wert('q').trim(), a: wert('a').trim() };
			else if (v.kind === 'edit') neu = { ...v, find: wert('find'), replace: wert('replace') };
			else if (v.kind === 'insert') neu = { ...v, after: wert('after'), text: wert('text') };
			else if (v.kind === 'quelle') {
				const sammlung = wert('sammlung').trim();
				neu = {
					...v, zitat: wert('zitat').trim(), titel: wert('titel').trim() || v.titel,
					url: wert('url').trim() || undefined, pdf_url: wert('pdf_url').trim() || undefined,
					sammlung: sammlung && sammlung !== zoteroZielFuer(this.sourcePath || '') ? sammlung : undefined
				};
			}
			ktx.bearbeiten = false;
			const gleichOriginal = schluesselFuer(neu) === schluesselFuer(ktx.original)
				&& JSON.stringify((neu as any).bezug ?? null) === JSON.stringify((ktx.original as any).bezug ?? null);
			this.setzeZustand(ktx, { bearbeitet: gleichOriginal ? undefined : neu });
			if (this.options.onVorschlagWaehlen && ktx.box.hasClass('is-selected')) ktx.box.click();
		};
		const abbrechen = () => { ktx.bearbeiten = false; this.zeichneBox(ktx); };

		// Obsidian belegt Mod+Enter global und verschluckt das keydown, bevor
		// das Textfeld es sieht (gemessen 11.10.2026). keyup kommt trotzdem an.
		let erledigt = false;
		const einmal = (f: () => void) => { if (erledigt) return; erledigt = true; f(); };
		const taste = (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); einmal(speichern); }
			else if (e.key === 'Escape' && e.type === 'keydown') { e.preventDefault(); e.stopPropagation(); einmal(abbrechen); }
		};
		form.addEventListener('keydown', taste, true);
		form.addEventListener('keyup', taste, true);
		window.setTimeout(() => eingaben[eingaben.length - 1]?.el.focus(), 0);

		const aktionen = ktx.box.createDiv({ cls: 'anki-suggestion-actions' });
		const s = new ButtonComponent(aktionen);
		s.setButtonText('Speichern').setCta().setTooltip('Strg+Enter');
		s.onClick(() => einmal(speichern));
		const a = new ButtonComponent(aktionen);
		a.setButtonText('Abbrechen').setTooltip('Esc');
		a.onClick(() => einmal(abbrechen));
		aktionen.createDiv({ cls: 'anki-vs-hinweis', text: 'Ändert nur den Vorschlag – erst „Übernehmen“ schreibt in die Notiz.' });
	}

	private undoSchluessel(ktx: BoxKontext): string {
		return `${this.sourcePath}\n${ktx.schluessel}`;
	}

	private async notizInhalt(): Promise<string | null> {
		const file = this.sourcePath && this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		return file instanceof TFile ? await this.plugin.app.vault.read(file) : null;
	}

	private async uebernehme(ktx: BoxKontext, knopf: ButtonComponent, notizen: HTMLElement) {
		knopf.setDisabled(true);
		const v = this.aktuellerVorschlag(ktx);
		const vorher = await this.notizInhalt();
		const result = await applySuggestion(this.plugin.app, this.sourcePath, v, this.plugin.settings.mainDeck);
		if (!result.ok) {
			knopf.setDisabled(false);
			ktx.box.addClass('is-missing');
			notizen.createDiv({ cls: 'anki-suggestion-note', text: result.message });
			return;
		}
		const nachher = await this.notizInhalt();
		if (vorher !== null && nachher !== null) RUECKGAENGIG.set(this.undoSchluessel(ktx), { vorher, nachher });
		if (v.kind === 'quelle') {
			// Zugeklappt erst, wenn sie auch in Zotero liegt.
			const erledigt = Array.from(new Set([...(this.zustand(ktx).erledigt ?? []), 'notiz']));
			this.setzeZustand(ktx, { erledigt, status: erledigt.includes('zotero') ? 'applied' : undefined });
		} else {
			this.setzeZustand(ktx, { status: 'applied' });
		}
		// Kartenlisten und andere Ansichten mitziehen.
		this.plugin.app.workspace.trigger('anki:suggestion-applied', this.sourcePath, ktx.schluessel);
	}

	/**
	 * Eine Übernahme zurücknehmen. Nur solange die Notiz genau so aussieht wie
	 * direkt danach – sonst würde jede spätere Änderung mit überschrieben.
	 */
	private async macheRueckgaengig(ktx: BoxKontext) {
		const key = this.undoSchluessel(ktx);
		const stand = RUECKGAENGIG.get(key);
		const file = this.sourcePath && this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!stand || !(file instanceof TFile)) return;
		let ok = false;
		await this.plugin.app.vault.process(file, (c) => {
			if (c !== stand.nachher) return c;
			ok = true;
			return stand.vorher;
		});
		if (!ok) {
			new Notice('Die Notiz wurde seitdem geändert – Rückgängig ist nicht mehr möglich. Nimm zuerst die spätere Übernahme zurück.', 7000);
			return;
		}
		RUECKGAENGIG.delete(key);
		new Notice('Rückgängig gemacht.');
		const rest = (this.zustand(ktx).erledigt ?? []).filter((e) => e !== 'notiz');
		this.setzeZustand(ktx, { status: undefined, erledigt: rest.length ? rest : undefined });
		this.plugin.app.workspace.trigger('anki:suggestion-applied', this.sourcePath, '');
	}

	private zoteroZiel(v: QuelleSuggestion): string {
		return v.sammlung || zoteroZielFuer(this.sourcePath || '');
	}

	/** Inhalt und Knöpfe einer Quellen-Box. */
	private zeichneQuelle(ktx: BoxKontext, v: QuelleSuggestion, el: {
		felder: HTMLElement; notizen: HTMLElement; aktionen: HTMLElement; haupt: ButtonComponent; bezugEl: HTMLElement;
	}) {
		const erledigt = this.zustand(ktx).erledigt ?? [];
		el.bezugEl.setText(`Zotero: ${this.zoteroZiel(v)}`);

		const f = el.felder.createDiv({ cls: 'anki-vs-feld' });
		f.createDiv({ cls: 'anki-vs-feldname', text: 'Zitat' });
		const zitat = f.createDiv({ cls: 'anki-vs-inhalt anki-vs-zitat' });
		void MarkdownRenderer.render(this.plugin.app, v.zitat, zitat, this.sourcePath || '', this);

		const meta = el.felder.createDiv({ cls: 'anki-vs-meta' });
		const typen: Record<string, string> = {
			webpage: 'Webseite', document: 'Dokument', journalArticle: 'Artikel',
			bookSection: 'Buchkapitel', book: 'Buch', report: 'Bericht'
		};
		if (v.typ) meta.createSpan({ text: typen[v.typ] ?? v.typ });
		if (v.url) meta.createEl('a', { text: einzeilig(v.url.replace(/^https?:\/\//, ''), 50), href: v.url });
		if (v.pdf_url) meta.createEl('a', { text: 'PDF', href: v.pdf_url });
		if (v.doi) meta.createSpan({ text: 'DOI ' + v.doi });

		const fertig = (wo: string) => {
			const chip = createSpan({ cls: 'anki-vs-fertig' });
			setIcon(chip.createSpan({ cls: 'anki-vs-leise-icon' }), 'check');
			chip.createSpan({ text: wo });
			return chip;
		};

		if (erledigt.includes('notiz')) {
			el.aktionen.insertBefore(fertig('in der Notiz'), el.haupt.buttonEl);
			el.haupt.buttonEl.remove();
		}

		const nachHaupt = el.haupt.buttonEl.isConnected ? el.haupt.buttonEl.nextSibling : el.aktionen.firstChild?.nextSibling ?? null;
		if (erledigt.includes('zotero')) {
			el.aktionen.insertBefore(fertig('in Zotero'), nachHaupt);
		} else {
			const z = new ButtonComponent(el.aktionen);
			z.setButtonText('In Zotero ablegen');
			z.setTooltip(`Als Eintrag in die Sammlung „${this.zoteroZiel(v)}“ (über den Fitness-Manager-Server, Datei wird angehängt)`);
			el.aktionen.insertBefore(z.buttonEl, nachHaupt);
			z.onClick(() => void this.inZotero(ktx, v, z, el.notizen));
		}
	}

	/** Quelle ueber das Backend nach Zotero – derselbe Weg wie der Medikamenten-Assistent. */
	private async inZotero(ktx: BoxKontext, v: QuelleSuggestion, knopf: ButtonComponent, notizen: HTMLElement) {
		const basis = (this.plugin.settings.fitnessManagerUrl || '').replace(/\/$/, '');
		if (!basis) {
			new Notice('Keine Fitness-Manager-Adresse in den Einstellungen.');
			return;
		}
		knopf.setDisabled(true);
		knopf.setButtonText('Lege in Zotero ab …');
		const name = (this.sourcePath || '').split('/').pop()?.replace(/\.md$/i, '') || 'Notiz';
		const { kind, zitat, sammlung, ...daten } = v;
		try {
			const res = await requestUrl({
				url: `${basis}/api/zotero/medikamente/anlegen`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify({
					wirkstoff: name,
					sammlung: this.zoteroZiel(v),
					quellen: [{ ...daten, art: 'neu', kategorie: 'Chat' }]
				}),
				throw: false
			});
			if (res.status !== 200) throw new Error(res.json?.detail || `HTTP ${res.status}`);
			const e = res.json?.ergebnisse?.[0];
			if (!e || e.status === 'fehler') throw new Error(e?.grund || 'Zotero hat den Eintrag abgelehnt.');
			new Notice(`Zotero: ${e.status}${e.anhang ? ' · ' + e.anhang : ''} – ${this.zoteroZiel(v)}`);
			const erledigt = Array.from(new Set([...(this.zustand(ktx).erledigt ?? []), 'zotero']));
			this.setzeZustand(ktx, { erledigt, status: erledigt.includes('notiz') ? 'applied' : undefined });
		} catch (err: any) {
			knopf.setDisabled(false);
			knopf.setButtonText('In Zotero ablegen');
			ktx.box.addClass('is-missing');
			notizen.createDiv({ cls: 'anki-suggestion-note', text: 'Zotero: ' + (err?.message || err) });
		}
	}

	/**
	 * Diagramm eines Vorschlags im Mermaid-Editor aendern.
	 *
	 * Dasselbe Diagramm steht meist zweimal in einer Antwort: im Callout fuer
	 * die Notiz und in der Karte, die es abfragt. Die Aenderung geht deshalb an
	 * jede offene Box der Nachricht mit demselben Diagramm – als bearbeitete
	 * Fassung, damit „Original" sie wieder zuruecknehmen kann.
	 */
	private bearbeiteDiagramm(box: HTMLElement, alt: string) {
		new MermaidEditorModal(this.plugin.app, alt, (neu) => {
			const blase = box.closest('.anki-chat-bubble') as HTMLElement | null;
			if (!blase) return;
			const ersetze = (t: string) => ersetzeGleicheMermaid(t, alt, neu, diagrammNorm);

			const warGewaehlt = blase.querySelector('.anki-suggestion.is-selected');
			blase.querySelectorAll<HTMLElement>('.anki-suggestion').forEach((b) => {
				const ktx = this.boxKontext.get(b);
				if (!ktx || this.zustand(ktx).status) return;
				const vorher = this.aktuellerVorschlag(ktx);
				const nachher = mapVorschlagText(vorher, ersetze);
				if (JSON.stringify(nachher) === JSON.stringify(vorher)) return;
				this.setzeZustand(ktx, { bearbeitet: nachher });
				if (b === warGewaehlt || (!warGewaehlt && b === box)) b.click();
			});
		}).open();
	}

	/**
	 * Mermaid-Code als SVG in die Vorschlagsbox zeichnen. Ueber die Bibliothek
	 * direkt, nicht ueber MarkdownRenderer – der liefert ausserhalb des Editors
	 * nur einen Codeblock (siehe mermaidRenderer.ts).
	 * Gibt die erste Fehlermeldung zurueck oder null.
	 */
	private async zeichneDiagramme(ziel: HTMLElement, codes: string[]): Promise<string | null> {
		let mermaid: any;
		try {
			mermaid = await loadMermaid();
		} catch {
			mermaid = (window as any).mermaid;
		}
		if (!mermaid?.render) {
			ziel.createDiv({ cls: 'anki-suggestion-note', text: 'Vorschau nicht verfügbar.' });
			return null;
		}
		for (const code of codes) {
			const id = `anki-vorschlag-mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			try {
				if (typeof mermaid.parse === 'function') await mermaid.parse(code);
				const ergebnis = await mermaid.render(id, code);
				const svg = typeof ergebnis === 'string' ? ergebnis : ergebnis?.svg;
				const huelle = ziel.createDiv({ cls: 'mermaid' });
				huelle.innerHTML = svg ?? '';
			} catch (e: any) {
				// mermaid.render() haengt bei Fehlern ein Fehler-SVG an <body>.
				document.getElementById(id)?.remove();
				document.getElementById('d' + id)?.remove();
				return String(e?.message || e).split('\n').slice(0, 3).join(' ');
			}
		}
		return null;
	}

	/** Springt im Editor zur zitierten Stelle. */
	private async revealInNote(find: string) {
		const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
		const leaf = leaves.find((l) => (l.view as any)?.file?.path === this.sourcePath) || leaves[0];
		if (!leaf) {
			new Notice('Notiz ist nicht geöffnet.');
			return;
		}

		this.plugin.app.workspace.revealLeaf(leaf);
		const editor = (leaf.view as any).editor;
		if (!editor) return;

		const hit = locate(editor.getValue(), find);
		if (!hit) {
			new Notice('Textstelle nicht gefunden.');
			return;
		}

		const from = editor.offsetToPos(hit.start);
		const to = editor.offsetToPos(hit.end);
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}

	private scrollToBottom() {
		window.setTimeout(() => {
			this.log.scrollTop = this.log.scrollHeight;
		}, 0);
	}

	// --- Kontext ----------------------------------------------------------

	/** Notizinhalt über sourcePath lesen - nicht über den gerade aktiven View. */
	private async readNote(): Promise<{ content: string; cards: string; karten: KartenBezug[] }> {
		if (!this.sourcePath) return { content: '', cards: '', karten: [] };

		const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) return { content: '', cards: '', karten: [] };

		const content = await this.plugin.app.vault.read(file);
		const cards = getAnkiBlocks(content)
			.map(b => parseCardsFromBlockSource(b.innerClean))
			.reduce((acc, list) => acc.concat(list), []);

		// Alte Legacy-Karten nicht mitschicken – siehe legacyStrip.ts.
		return {
			content: ohneAlteKarten(content),
			cards: formatCardsToExistingCardsString(cards),
			// Merken, welche Karte hinter welcher CARD-Nummer steht – siehe kartenSuche.ts.
			karten: cards.map((c) => ({ id: c.id, q: c.q }))
		};
	}

	// --- Senden -----------------------------------------------------------

	/**
	 * Zustandsaenderungen aus anderen Ansichten nachziehen.
	 *
	 * Seitenleiste, Block und Modal zeigen denselben Chat. Ohne das bliebe ein
	 * Vorschlag drueben anklickbar, und der zweite Klick meldete „Textstelle
	 * nicht gefunden" – der Text ist ja bereits ersetzt.
	 */
	private lauscheAufUebernahmen() {
		this.registerEvent(
			this.plugin.app.workspace.on('anki:suggestion-applied' as any, ((sourcePath: string) => {
				if (sourcePath !== this.sourcePath) return;
				// Die Notiz hat sich geaendert: offene Vorschlaege neu pruefen.
				window.setTimeout(() => {
					this.pruefungen.forEach((pruefe, box) => {
						if (!box.isConnected) this.pruefungen.delete(box);
						else pruefe();
					});
				}, 50);
			}) as any)
		);
		this.registerEvent(
			this.plugin.app.workspace.on('anki:vorschlag-zustand' as any, ((
				sourcePath: string, schluessel: string, msg: ChatMessage | undefined, zustand: VorschlagZustand
			) => {
				if (sourcePath !== this.sourcePath || !schluessel) return;
				this.log.querySelectorAll<HTMLElement>('.anki-suggestion').forEach((box) => {
					if (box.dataset.ankiVorschlag !== schluessel) return;
					const ktx = this.boxKontext.get(box);
					if (!ktx) return;
					if (ktx.msg && ktx.msg === msg) {
						if (ktx.bearbeiten) return;
					} else if (zustand.status === 'applied' && !this.zustand(ktx).status) {
						// Derselbe Vorschlag in einer anderen Antwort: er ist ja
						// angewendet, ein zweiter Klick wuerde nur scheitern.
						this.setzeZustand(ktx, { status: 'applied' });
						return;
					} else return;
					this.zeichneBox(ktx);
					const blase = box.closest('.anki-chat-bubble') as HTMLElement | null;
					if (blase) this.aktualisiereLeiste(blase);
				});
			}) as any)
		);
		this.registerEvent(
			this.plugin.app.workspace.on('anki:chat-modell' as any, (() => this.zeichneModellChip()) as any)
		);
	}

	/**
	 * Nachrichten aus einer anderen Ansicht derselben Notiz (Modal, Block,
	 * Seitenleiste) nachziehen. Waehrend eine eigene Anfrage laeuft nicht –
	 * dann steht der Platzhalter im DOM, aber noch nicht im Verlauf.
	 */
	private lauscheAufVerlauf() {
		this.registerEvent(
			this.plugin.app.workspace.on('anki:chat-update' as any, ((
				sourcePath: string, history: ChatMessage[]
			) => {
				if (sourcePath !== this.sourcePath || this.controller || !Array.isArray(history)) return;
				if (history === this.history && history.length === this.renderedCount) return;
				this.syncHistoryRef(history);
			}) as any)
		);
	}

	private setBusy(busy: boolean) {
		this.sendBtn.setIcon(busy ? 'square' : 'send');
		this.sendBtn.setTooltip(busy ? 'Abbrechen' : 'Senden (Enter)');
	}

	async send() {
		if (this.controller) {
			// Zweiter Klick während des Streams = abbrechen.
			this.controller.abort();
			return;
		}

		const text = this.input.value.trim();
		if (!text) return;

		const modell = this.gewaehltesModell();
		if (!modell) {
			new Notice('Kein KI-Modell konfiguriert.');
			return;
		}

		this.input.value = '';
		this.input.style.height = 'auto';

		if (modell === 'claude-agent') {
			await this.agentChat(text);
			return;
		}
		const provider = modell;

		const historyForRequest = this.history.slice();
		this.history.push({ role: 'user', content: text });
		this.appendPending();
		this.scrollToBottom();

		// Platzhalter für die Antwort, der live befüllt wird.
		const placeholder: ChatMessage = { role: 'ai', content: '', modell: this.modellName(provider) };
		const wrapper = await this.renderMessage(placeholder);
		const bubble = wrapper.querySelector('.anki-chat-bubble') as HTMLElement;
		const typing = bubble.createDiv({ cls: 'anki-chat-typing' });
		typing.createSpan(); typing.createSpan(); typing.createSpan();

		this.controller = new AbortController();
		this.setBusy(true);
		if (this.sourcePath) {
			this.plugin.addActiveGeneration(this.sourcePath + '::chat', this.controller, 'AI Chat', this.sourcePath);
		}

		let streamed = '';
		let raf = 0;
		const paint = () => {
			raf = 0;
			bubble.setText(streamed);
		};

		try {
			const { content, cards, karten } = await this.readNote();
			placeholder.karten = karten;

			streamed = await streamChatResponse(
				this.plugin.app,
				historyForRequest,
				text,
				content,
				provider,
				this.plugin.settings,
				this.controller.signal,
				(delta) => {
					if (typing.isConnected) typing.remove();
					streamed += delta;
					// Während des Streams nur Rohtext malen - Markdown erst am Ende.
					if (!raf) raf = window.requestAnimationFrame(paint);
				},
				cards
			);

			if (raf) window.cancelAnimationFrame(raf);
			placeholder.content = streamed;
			this.history.push(placeholder);
			this.renderedCount = this.history.length;
			await this.renderBody(bubble, streamed, true);
			this.waehleErsten(bubble);

		} catch (e: any) {
			if (raf) window.cancelAnimationFrame(raf);
			const aborted = e?.name === 'AbortError' || e?.message === 'Aborted by user';
			const message = aborted ? '_(Abgebrochen)_' : 'Fehler: ' + (e?.message || String(e));

			placeholder.content = streamed || message;
			this.history.push(placeholder);
			this.renderedCount = this.history.length;

			if (!aborted) wrapper.addClass('is-error');
			await this.renderBody(bubble, placeholder.content, true);
			if (!aborted) new Notice('Fehler bei der Antwort: ' + (e?.message || e));

		} finally {
			this.controller = null;
			this.setBusy(false);
			if (this.sourcePath) this.plugin.removeActiveGeneration(this.sourcePath + '::chat');

			setHistory(this.plugin, this.sourcePath, this.history);
			this.plugin.app.workspace.trigger('anki:chat-update', this.sourcePath, this.history);
			this.scrollToBottom();
		}
	}

	/**
	 * Eine Chat-Frage an den Claude-Agenten (Claude CLI).
	 *
	 * Gedacht fuer Rueckfragen nach einem Zotero-Abgleich und fuer alles, was
	 * Quellen braucht: der Agent darf in Zotero lesen und im Web suchen. Er
	 * bekommt denselben Systemkontext wie der normale Chat – also auch das
	 * Vorschlagsformat.
	 *
	 * Stammt eine fruehere Antwort von einem Agenten (Abgleich oder Rueckfrage),
	 * knuepft die Frage an dessen Sitzung an: er weiss dann noch, was er in den
	 * Quellen gelesen hat, und muss es nicht neu oeffnen. Mit kommt nur, was
	 * seitdem im Chat stand, plus der aktuelle Stand der Notiz – Vorschlaege
	 * koennen sie inzwischen veraendert haben. Gibt es die Sitzung nicht mehr,
	 * geht der ganze Verlauf als Text an eine frische.
	 */
	private async agentChat(text: string, auftrag = text) {
		const verlauf = this.history.slice();
		this.history.push({ role: 'user', content: text });
		this.appendPending();

		const placeholder: ChatMessage = { role: 'ai', content: '', modell: this.modellName('claude-agent') };
		const wrapper = await this.renderMessage(placeholder);
		const bubble = wrapper.querySelector('.anki-chat-bubble') as HTMLElement;
		const status = bubble.createDiv({ cls: 'anki-agent-progress' });
		const statusHead = status.createDiv({ cls: 'anki-agent-progress-head', text: 'Claude denkt nach …' });
		const statusLines = status.createDiv({ cls: 'anki-agent-progress-lines' });
		const typing = bubble.createDiv({ cls: 'anki-chat-typing' });
		typing.createSpan(); typing.createSpan(); typing.createSpan();
		this.scrollToBottom();

		this.controller = new AbortController();
		this.setBusy(true);
		const genKey = this.sourcePath + '::agent';
		if (this.sourcePath) this.plugin.addActiveGeneration(genKey, this.controller, 'Claude-Agent', this.sourcePath);

		const started = Date.now();
		let schritte = 0;
		const ticker = window.setInterval(() => {
			const sek = Math.round((Date.now() - started) / 1000);
			statusHead.setText(`Claude arbeitet … ${Math.floor(sek / 60)}:${String(sek % 60).padStart(2, '0')} · ${schritte} Schritte`);
		}, 1000);

		try {
			const { content, cards, karten } = await this.readNote();
			placeholder.karten = karten;
			const alsText = (ms: ChatMessage[]) => ms
				.filter((m) => m.content.trim())
				.map((m) => `### ${m.role === 'user' ? 'Nutzer' : 'Assistent'}\n${m.content}`)
				.join('\n\n');
			const dataDir = this.plugin.settings.zoteroDataDir || defaultZoteroDataDir();
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const fs = require('fs');
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const storage = require('path').join(dataDir, 'storage');
			const hatZotero = !!dataDir && fs.existsSync(dataDir);
			const hatStorage = hatZotero && fs.existsSync(storage);
			const vaultDir = this.vaultDir();
			const werkzeuge = rechercheHinweise({ vaultDir, zoteroStorage: hatStorage ? storage : null });
			const frisch = () => {
				const gespraech = alsText(verlauf);
				return [
					buildChatSystemPrompt(content, cards),
					werkzeuge,
					gespraech ? '## Bisheriges Gespräch\n\n' + gespraech : '',
					'## Neue Nachricht des Nutzers\n\n' + auftrag
				].filter(Boolean).join('\n\n');
			};

			let letzte = -1;
			for (let i = verlauf.length - 1; i >= 0; i--) if (verlauf[i].agentSitzung) { letzte = i; break; }
			const sitzung = letzte >= 0 ? verlauf[letzte].agentSitzung : undefined;
			const seitdem = alsText(verlauf.slice(letzte + 1));
			const prompt = sitzung ? [
				'# Rückfrage im selben Chat',
				'Du arbeitest an deinem bisherigen Auftrag weiter. Was du gelesen hast, weißt du noch – öffne Quellen nur erneut, wenn du eine Stelle genau brauchst.',
				'## Aktueller Stand (ersetzt frühere Fassungen der Notiz und der Kartenliste)\n\n' + buildChatSystemPrompt(content, cards),
				werkzeuge,
				seitdem ? '## Seit deiner letzten Antwort im Chat\n\n' + seitdem : '',
				'## Neue Nachricht des Nutzers\n\n' + auftrag
			].filter(Boolean).join('\n\n') : frisch();

			const result = await runMitSitzung({
				cliPath: this.plugin.settings.claudeCliPath || defaultCliPath(),
				prompt,
				cwd: hatZotero ? dataDir : require('os').tmpdir(),
				addDirs: [...(hatStorage ? [storage] : []), ...(vaultDir ? [vaultDir] : [])],
				research: true,
				model: this.plugin.settings.claudeAgentModel,
				fortsetzen: sitzung,
				frisch,
				signal: this.controller.signal,
				onEvent: (ev: AgentEvent) => {
					if (ev.kind !== 'tool') return;
					schritte++;
					statusLines.createDiv({ cls: 'anki-agent-progress-line', text: beschreibeWerkzeug(ev) });
					while (statusLines.childElementCount > 8) statusLines.firstElementChild?.remove();
					this.scrollToBottom();
				}
			});
			placeholder.content = result.text.trim();
			if (result.sessionId) placeholder.agentSitzung = result.sessionId;
			const info = [`${result.turns ?? schritte} Schritte`, `${Math.round((Date.now() - started) / 1000)} s`];
			if (result.costUsd !== null) info.push(`${result.costUsd.toFixed(2).replace('.', ',')} $`);
			if (sitzung) info.push(result.fortgesetzt ? 'knüpft an die letzte Agenten-Sitzung an' : 'alte Sitzung nicht mehr da – neu gestartet');
			placeholder.content += `\n\n> [!info]- Claude-Agent\n> ${info.join(' · ')}`;
		} catch (e: any) {
			const aborted = e?.name === 'AbortError' || e?.message === 'Aborted by user';
			placeholder.content = aborted ? '_(Abgebrochen)_' : 'Fehler beim Claude-Agenten: ' + (e?.message || String(e));
			if (!aborted) {
				wrapper.addClass('is-error');
				new Notice('Claude-Agent fehlgeschlagen: ' + (e?.message || e));
			}
		} finally {
			window.clearInterval(ticker);
			this.history.push(placeholder);
			this.renderedCount = this.history.length;
			await this.renderBody(bubble, placeholder.content, true);
			this.waehleErsten(bubble);

			this.controller = null;
			this.setBusy(false);
			if (this.sourcePath) this.plugin.removeActiveGeneration(genKey);
			setHistory(this.plugin, this.sourcePath, this.history);
			this.plugin.app.workspace.trigger('anki:chat-update', this.sourcePath, this.history);
			this.scrollToBottom();
		}
	}

	/** Wurzel des Vaults auf der Platte – fuer Querverweise des Agenten. */
	private vaultDir(): string | null {
		const adapter = this.plugin.app.vault.adapter as any;
		return typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null;
	}

	/**
	 * Konzeptkarte: der Agent erklaert die Zusammenhaenge der Notiz als
	 * Begriffsnetz und recherchiert, was darin fehlt. Laeuft als gewoehnliche
	 * Agenten-Frage – Rueckfragen dazu knuepfen an dieselbe Sitzung an.
	 */
	private async konzeptkarte() {
		if (this.controller) {
			new Notice('Es läuft schon eine Anfrage in diesem Chat.');
			return;
		}
		const file = this.sourcePath && this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) { new Notice('Keine Notiz.'); return; }
		const schwerpunkt = this.input.value.trim();
		this.input.value = '';
		this.input.style.height = 'auto';
		const anzeige = '🗺️ **Konzeptkarte**' + (schwerpunkt ? `\n> Schwerpunkt: ${schwerpunkt.replace(/\n/g, '\n> ')}` : '');
		await this.agentChat(anzeige, buildKonzeptkartenAuftrag(file.basename, schwerpunkt));
	}

	// --- Zotero-Abgleich ----------------------------------------------------

	private zoteroClient(): { client: ZoteroClient; dataDir: string } {
		const s = this.plugin.settings;
		const dataDir = s.zoteroDataDir || defaultZoteroDataDir();
		return { client: new ZoteroClient(s.zoteroApiUrl || 'http://localhost:23119/api', dataDir), dataDir };
	}

	private openZoteroAbgleich() {
		if (!this.sourcePath) {
			new Notice('Keine Notiz zum Abgleichen.');
			return;
		}
		if (this.controller) {
			new Notice('Es läuft schon eine Anfrage in diesem Chat.');
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		const title = file instanceof TFile ? file.basename : this.sourcePath;
		const { client } = this.zoteroClient();
		new ZoteroAbgleichModal(this.plugin.app, client, title, (a) => void this.runZoteroAbgleich(title, a)).open();
	}

	/**
	 * Laesst einen Claude-Agenten die Notiz gegen Zotero-Quellen pruefen.
	 *
	 * Die Antwort landet als gewoehnliche KI-Nachricht im Chat. Ihre
	 * Vorschlagsbloecke werden also genauso angezeigt und per Klick
	 * uebernommen wie die des normalen Chats – der Agent selbst schreibt nichts.
	 */
	private async runZoteroAbgleich(title: string, a: AbgleichAuswahl) {
		const namen = a.collectionKeys.map((k) => collectionPath(k, a.collections)).join(', ');
		const anfrage = [
			`📚 **Zotero-Abgleich** mit ${namen}${a.includeSubcollections ? ' (inkl. Unterordner)' : ''}` +
			(a.research ? ' · mit Web-Recherche' : ''),
			a.extra.trim() ? `\n> ${a.extra.trim().replace(/\n/g, '\n> ')}` : ''
		].join('');
		this.history.push({ role: 'user', content: anfrage });
		this.appendPending();

		const placeholder: ChatMessage = { role: 'ai', content: '' };
		const wrapper = await this.renderMessage(placeholder);
		const bubble = wrapper.querySelector('.anki-chat-bubble') as HTMLElement;
		const status = bubble.createDiv({ cls: 'anki-agent-progress' });
		const statusHead = status.createDiv({ cls: 'anki-agent-progress-head' });
		const statusLines = status.createDiv({ cls: 'anki-agent-progress-lines' });
		const typing = bubble.createDiv({ cls: 'anki-chat-typing' });
		typing.createSpan(); typing.createSpan(); typing.createSpan();
		const zeile = (text: string) => {
			statusLines.createDiv({ cls: 'anki-agent-progress-line', text });
			while (statusLines.childElementCount > 8) statusLines.firstElementChild?.remove();
			this.scrollToBottom();
		};
		statusHead.setText('Sammle Quellen aus Zotero…');
		this.scrollToBottom();

		this.controller = new AbortController();
		this.setBusy(true);
		const genKey = this.sourcePath + '::zotero';
		if (this.sourcePath) {
			this.plugin.addActiveGeneration(genKey, this.controller, 'Zotero-Abgleich', this.sourcePath);
		}

		const started = Date.now();
		let schritte = 0;
		const ticker = window.setInterval(() => {
			const sek = Math.round((Date.now() - started) / 1000);
			statusHead.setText(`Claude prüft die Quellen … ${Math.floor(sek / 60)}:${String(sek % 60).padStart(2, '0')} · ${schritte} Schritte`);
		}, 1000);

		let sources: ZoteroSource[] = [];
		try {
			const { client, dataDir } = this.zoteroClient();
			sources = await client.sources(a.collectionKeys, a.collections, a.includeSubcollections);
			if (sources.length === 0) throw new Error('In den gewählten Sammlungen liegen keine Einträge.');
			const mitText = sources.filter((s) => s.attachments.some((at) => at.fullTextPath || at.filePath)).length;
			zeile(`${sources.length} Quellen, ${mitText} davon mit Datei/Volltext`);

			// Pfad → Quellentitel, damit der Fortschritt „liest: Fachinformation" sagt.
			const titelZuPfad = new Map<string, string>();
			const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
			sources.forEach((s) => s.attachments.forEach((at) => {
				[at.fullTextPath, at.filePath].forEach((p) => p && titelZuPfad.set(norm(p), s.title));
			}));

			const { content, cards, karten } = await this.readNote();
			placeholder.karten = karten;
			placeholder.modell = 'Claude-Agent';
			const prompt = buildAbgleichPrompt({
				noteTitle: title,
				noteContent: content,
				cards,
				sources,
				research: a.research,
				extra: a.extra
			});
			// Hat derselbe Agent die Quellen fuer diese Notiz zusammengestellt,
			// pruefen wir in seiner Sitzung: er kennt dann noch, was er gelesen
			// und warum er welche Quelle gewaehlt hat.
			const suche = this.sourcePath ? this.plugin.settings.quellenSitzungen?.[this.sourcePath] : undefined;
			if (suche) zeile(`Knüpfe an die Quellensuche vom ${new Date(suche.datum).toLocaleDateString('de-DE')} an`);

			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const storage = require('path').join(dataDir, 'storage');
			const result = await runMitSitzung({
				cliPath: this.plugin.settings.claudeCliPath || defaultCliPath(),
				prompt: suche ? anknuepfungAnQuellensuche(suche) + '\n\n' + prompt : prompt,
				cwd: dataDir,
				addDirs: readableDirs(sources, storage),
				research: a.research,
				model: this.plugin.settings.claudeAgentModel,
				fortsetzen: suche?.id,
				frisch: () => prompt,
				signal: this.controller.signal,
				onEvent: (ev: AgentEvent) => {
					if (ev.kind !== 'tool') return;
					schritte++;
					zeile(beschreibeWerkzeug(ev, titelZuPfad.get(norm(ev.detail))));
				}
			});

			// Quellen als nummerierte Liste – als eine mit „·" verkettete Zeile
			// war das bei elf Quellen ein unlesbarer Block (Glucose, 13.10.2026).
			if (result.sessionId) placeholder.agentSitzung = result.sessionId;
			const details = [
				'',
				'> [!info]- Abgleich-Details',
				`> ${result.turns ?? schritte} Schritte · ${Math.round((Date.now() - started) / 1000)} s` +
				(result.costUsd !== null ? ` · ${result.costUsd.toFixed(2).replace('.', ',')} $` : ''),
				...(suche ? ['>', result.fortgesetzt
					? `> Knüpft an die Quellensuche vom ${new Date(suche.datum).toLocaleDateString('de-DE')} an.`
					: '> Die Sitzung der Quellensuche war nicht mehr da – neu gestartet.'] : []),
				'>',
				'> **Quellen**',
				...sources.map((s, i) => `> ${i + 1}. ${s.title.replace(/\s+/g, ' ').trim()}`)
			].join('\n');
			placeholder.content = result.text.trim() + '\n' + details;
		} catch (e: any) {
			const aborted = e?.name === 'AbortError' || e?.message === 'Aborted by user';
			placeholder.content = aborted ? '_(Abgleich abgebrochen)_' : 'Fehler beim Zotero-Abgleich: ' + (e?.message || String(e));
			if (!aborted) {
				wrapper.addClass('is-error');
				new Notice('Zotero-Abgleich fehlgeschlagen: ' + (e?.message || e));
			}
		} finally {
			window.clearInterval(ticker);
			this.history.push(placeholder);
			this.renderedCount = this.history.length;
			await this.renderBody(bubble, placeholder.content, true);

			this.controller = null;
			this.setBusy(false);
			if (this.sourcePath) this.plugin.removeActiveGeneration(genKey);
			setHistory(this.plugin, this.sourcePath, this.history);
			this.plugin.app.workspace.trigger('anki:chat-update', this.sourcePath, this.history);
			this.scrollToBottom();
		}
	}

	/** "Feedback einholen" - eine einmalige Analyse der Notiz. */
	private async requestFeedback() {
		// Feedback laeuft ueber die API; ist der Agent gewaehlt, der Standard.
		const gewaehlt = this.gewaehltesModell();
		const provider = gewaehlt === 'claude-agent' ? resolveProvider(this.plugin.settings) : gewaehlt;
		if (!provider) {
			new Notice('Kein KI-Modell konfiguriert.');
			return;
		}

		const notice = new Notice(`Hole Feedback von ${PROVIDERS[provider].label}…`, 0);
		const controller = new AbortController();
		if (this.sourcePath) {
			this.plugin.addActiveGeneration(this.sourcePath + '::feedback', controller, 'Anki Feedback', this.sourcePath);
		}

		// DAS WARTEN MUSS IM PANEL SICHTBAR SEIN, NICHT NUR IN EINER NOTICE.
		//
		// Feedback kommt anders als der Chat nicht gestreamt: es passiert bis
		// zur fertigen Antwort sichtbar gar nichts. Die Notice verschwindet
		// hinter anderen Meldungen oder wird uebersehen, und dann sieht es
		// aus, als haette der Knopf nicht reagiert. Deshalb dieselbe
		// Warteblase mit den drei Punkten wie beim Streamen.
		const platzhalter = await this.renderMessage({ role: 'ai', content: '' });
		const blase = platzhalter.querySelector('.anki-chat-bubble') as HTMLElement | null;
		if (blase) {
			const punkte = blase.createDiv({ cls: 'anki-chat-typing' });
			punkte.createSpan(); punkte.createSpan(); punkte.createSpan();
		}
		this.scrollToBottom();

		try {
			const { content, cards, karten } = await this.readNote();
			const feedback = await generateFeedbackOnly(
				this.plugin.app, content, provider, this.plugin.settings, controller.signal as any, cards
			);

			// Erst die Warteblase weg, dann die echte Antwort einhaengen –
			// sonst steht sie doppelt da.
			platzhalter.remove();

			if (feedback) {
				this.history = appendFeedbackToCache(this.plugin, this.sourcePath, feedback);
				const neu = this.history[this.history.length - 1];
				if (neu) {
					neu.karten = karten;
					neu.modell = this.modellName(provider);
				}
				this.appendPending();
				this.scrollToBottom();
				// Auch die Sidebar/den Block-Chat informieren.
				this.plugin.app.workspace.trigger('anki:chat-update', this.sourcePath, this.history);
			}
		} catch (e: any) {
			platzhalter.remove();
			new Notice('Feedback fehlgeschlagen: ' + (e?.message || e));
		} finally {
			// Doppelt haelt besser: bei einem Fehler VOR dem try-Block bliebe
			// die Blase sonst stehen.
			if (platzhalter.isConnected) platzhalter.remove();
			notice.hide();
			if (this.sourcePath) this.plugin.removeActiveGeneration(this.sourcePath + '::feedback');
		}
	}
}

/** Eine Werkzeug-Nutzung des Agenten als lesbare Fortschrittszeile. */
function beschreibeWerkzeug(ev: { name: string; detail: string }, quelle?: string): string {
	const datei = quelle ?? ev.detail.split(/[\/]/).pop() ?? ev.detail;
	switch (ev.name) {
		case 'Read': return `📖 liest: ${datei}`;
		case 'Grep': return `🔍 sucht „${ev.detail}"`;
		case 'Glob': return `📂 sieht nach: ${ev.detail}`;
		case 'WebSearch': return `🌐 Websuche: ${ev.detail}`;
		case 'WebFetch': return `🌐 öffnet: ${ev.detail}`;
		default: return `⚙️ ${ev.name} ${ev.detail}`.trim();
	}
}

// --- Vorschlagsboxen: Hilfen ----------------------------------------------

interface BoxKontext {
	box: HTMLElement;
	/** Der Vorschlag, wie die KI ihn geschrieben hat (mit Kartenbezug). */
	original: Suggestion;
	schluessel: string;
	msg: ChatMessage | undefined;
	warum: string;
	bearbeiten: boolean;
	quelltext: boolean;
	/** Zustand ohne Nachricht (sollte nicht vorkommen) – nur im Speicher. */
	fluechtig?: VorschlagZustand;
}

/**
 * Notizstand vor und nach jeder Übernahme, fuer „Rückgängig". Bewusst nur im
 * Speicher und modulweit: jede offene Ansicht soll zuruecknehmen koennen, aber
 * ganze Notizfassungen gehoeren nicht in chat-history.json.
 */
const RUECKGAENGIG = new Map<string, { vorher: string; nachher: string }>();

function artKlasse(v: Suggestion): string {
	if (v.kind === 'card') return v.op === 'add' ? 'is-art-neu' : v.op === 'delete' ? 'is-art-loeschen' : 'is-art-karte';
	if (v.kind === 'edit') return 'is-art-text';
	if (v.kind === 'insert') return 'is-art-einfuegen';
	if (v.kind === 'quelle') return 'is-art-quelle';
	return 'is-art-kaputt';
}

function artIcon(v: Suggestion): string {
	if (v.kind === 'card') return v.op === 'add' ? 'square-plus' : v.op === 'delete' ? 'trash-2' : 'layers';
	if (v.kind === 'edit') return 'pencil';
	if (v.kind === 'insert') return 'list-plus';
	if (v.kind === 'quelle') return 'book-open';
	return 'alert-triangle';
}

function artLabel(v: Suggestion): string {
	if (v.kind === 'card') return v.op === 'add' ? 'Neue Karte' : v.op === 'delete' ? 'Karte löschen' : 'Karte ändern';
	if (v.kind === 'edit') return 'Textänderung';
	if (v.kind === 'insert') return 'Einfügen';
	if (v.kind === 'quelle') return 'Quelle';
	return 'Nicht anwendbar';
}

function einzeilig(t: string, max = 80): string {
	const s = t
		.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
		.replace(/\[\[([^\]]*)\]\]/g, '$1')
		.replace(/^[\s>#*-]+/, '')
		.replace(/\s+/g, ' ')
		.trim();
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Die naechste Ueberschrift ueber einer Textstelle – als Ortsangabe im Kopf. */
function abschnittVor(content: string, offset: number): string {
	const davor = content.slice(0, offset).split('\n');
	for (let i = davor.length - 1; i >= 0; i--) {
		const m = davor[i].match(/^[ \t>]*#{1,6}\s+(.+?)\s*#*\s*$/);
		if (m) return `Abschnitt „${einzeilig(m[1], 50)}“`;
	}
	return 'Notiztext';
}

/** Ein Feld (Frage, Antwort, Text) mit Wort-Diff zeichnen. */
function feld(parent: HTMLElement, name: string, teile: DiffTeil[]): HTMLElement {
	const f = parent.createDiv({ cls: 'anki-vs-feld' });
	if (name) f.createDiv({ cls: 'anki-vs-feldname', text: name });
	const inhalt = f.createDiv({ cls: 'anki-vs-inhalt' });
	const nurNeu = teile.length > 0 && teile.every((t) => t.art === 'neu');
	const nurWeg = teile.length > 0 && teile.every((t) => t.art === 'weg');
	if (nurNeu) inhalt.addClass('is-ganz-neu');
	if (nurWeg) inhalt.addClass('is-ganz-weg');
	teile.forEach((t) => {
		const ziel = t.art === 'gleich' || nurNeu || nurWeg
			? inhalt
			: inhalt.createSpan({ cls: t.art === 'weg' ? 'anki-vs-weg' : 'anki-vs-neu' });
		schreibe(ziel, t.text);
	});
	return f;
}

/** Text schreiben, Wikilinks als Begriff im Linkstil (Quelltext steht unter „Quelltext"). */
function schreibe(el: HTMLElement, text: string) {
	const re = /\[\[[^\]]*\]\]/g;
	let pos = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (m.index > pos) el.appendText(text.slice(pos, m.index));
		el.createSpan({ cls: 'anki-vs-link', text: linkText(m[0]) ?? m[0], attr: { title: m[0] } });
		pos = m.index + m[0].length;
	}
	if (pos < text.length) el.appendText(text.slice(pos));
}
