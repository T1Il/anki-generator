import { ButtonComponent, MarkdownRenderer, Notice, Platform, TFile, setIcon, Component, loadMermaid } from 'obsidian';
import AnkiGeneratorPlugin from '../../main';
import { ChatMessage } from '../../types';
import { streamChatResponse, generateFeedbackOnly } from '../../aiGenerator';
import { resolveProvider, PROVIDERS } from '../../providers';
import { entschaerfePluginFences, mermaidAusVorschlag, parseSuggestions, schluesselFuer, stripSuggestionBlocks, Suggestion } from '../../chat/suggestions';
import { applySuggestion, canLocateEdit, pruefeKartenVorschlag } from '../../chat/applySuggestion';
import { locate } from '../../chat/textLocator';
import { setHistory, clearHistory, appendFeedbackToCache } from '../../chat/chatHistory';
import { getAnkiBlocks, parseCardsFromBlockSource, formatCardsToExistingCardsString } from '../../anki/ankiParser';
import { ZoteroClient, ZoteroSource, collectionPath } from '../../zotero/zoteroClient';
import { ZoteroAbgleichModal, AbgleichAuswahl } from '../ZoteroAbgleichModal';
import { MedikamentQuellenModal } from '../MedikamentQuellenModal';
import { buildAbgleichPrompt, readableDirs } from '../../agent/abgleichPrompt';
import { runClaudeAgent, defaultCliPath, defaultZoteroDataDir, AgentEvent } from '../../agent/claudeAgent';

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
	onVorschlagWaehlen?: (s: Suggestion) => void;
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

			const quellenBtn = new ButtonComponent(controls);
			quellenBtn.setIcon('folder-plus').setTooltip('Medikament: Zotero-Quellen zusammenstellen');
			quellenBtn.onClick(() => {
				const file = this.sourcePath && this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
				if (!(file instanceof TFile)) { new Notice('Keine Notiz.'); return; }
				new MedikamentQuellenModal(this.plugin.app, this.plugin, file.basename).open();
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

		body.createDiv({
			cls: 'anki-chat-hint',
			text: 'Enter senden · Shift+Enter neue Zeile'
		});
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
		role.createSpan({ text: msg.role === 'ai' ? 'KI' : 'Du' });

		const bubble = wrapper.createDiv({ cls: 'anki-chat-bubble' });
		await this.renderBody(bubble, msg.content, msg.role === 'ai');

		return wrapper;
	}

	/** Fließtext als Markdown, Vorschlagsblöcke als eigene Widgets. */
	private async renderBody(bubble: HTMLElement, content: string, isAi: boolean) {
		bubble.empty();

		// Erst die Vorschlagsbloecke raus, dann jede uebrig gebliebene
		// Plugin-Sprachmarke entschaerfen – sonst rendert der eigene
		// anki-cards-Prozessor in die Chat-Blase und die App friert ein.
		const prose = isAi ? entschaerfePluginFences(stripSuggestionBlocks(content)) : content;
		if (prose) {
			await MarkdownRenderer.render(this.plugin.app, prose, bubble, this.sourcePath || '', this);
		}

		if (!isAi) return;

		const suggestions = parseSuggestions(content);
		suggestions.forEach((s) => this.renderSuggestion(bubble, s));
	}

	/** Nach einer frischen Antwort: ersten Vorschlag gleich im Vergleich zeigen. */
	private waehleErsten(bubble: HTMLElement) {
		if (!this.options.onVorschlagWaehlen) return;
		const box = bubble.querySelector('.anki-suggestion') as HTMLElement | null;
		box?.click();
	}

	private markiereGewaehlt(box: HTMLElement) {
		this.log.querySelectorAll('.anki-suggestion.is-selected')
			.forEach((el) => el.removeClass('is-selected'));
		box.addClass('is-selected');
	}

	private renderSuggestion(parent: HTMLElement, suggestion: Suggestion) {
		const box = parent.createDiv({ cls: 'anki-suggestion' });
		// Inhaltsschluessel am Element, damit jede andere offene Ansicht
		// dieselbe Box wiederfindet, wenn der Vorschlag anderswo uebernommen
		// wird.
		const schluessel = schluesselFuer(suggestion);
		box.dataset.ankiVorschlag = schluessel;

		const title = box.createDiv({ cls: 'anki-suggestion-title' });
		const titleIcon = title.createSpan({ cls: 'anki-chat-role-icon' });

		const diff = box.createEl('pre', { cls: 'anki-suggestion-diff' });
		const line = (text: string, cls: string) =>
			diff.createSpan({ cls: `anki-diff-line ${cls}`, text });

		// Nicht anwendbar: trotzdem zeigen. stripSuggestionBlocks entfernt den
		// Block aus dem Fließtext, vorher war an dieser Stelle einfach nichts.
		if (suggestion.kind === 'invalid') {
			setIcon(titleIcon, 'alert-triangle');
			title.createSpan({ text: 'Vorschlag nicht anwendbar' });
			suggestion.raw.split('\n').forEach(l => line('  ' + l, 'is-meta'));
			box.addClass('is-missing');
			box.createDiv({ cls: 'anki-suggestion-note', text: suggestion.reason });
			return;
		}

		if (suggestion.kind === 'edit') {
			setIcon(titleIcon, 'pencil');
			title.createSpan({ text: 'Textänderung' });
			suggestion.find.split('\n').forEach(l => line('- ' + l, 'is-remove'));
			suggestion.replace.split('\n').forEach(l => line('+ ' + l, 'is-add'));
		} else if (suggestion.kind === 'insert') {
			setIcon(titleIcon, 'list-plus');
			title.createSpan({ text: 'Einfügen' });
			line('nach: ' + suggestion.after.split('\n')[0], 'is-meta');
			suggestion.text.split('\n').forEach(l => line('+ ' + l, 'is-add'));
		} else {
			setIcon(titleIcon, 'layers');
			const opLabel = suggestion.op === 'add' ? 'Neue Karte'
				: suggestion.op === 'delete' ? 'Karte löschen' : 'Karte ändern';
			title.createSpan({ text: opLabel });

			if (suggestion.ref !== null) line(`CARD: ${suggestion.ref}`, 'is-meta');
			if (suggestion.id !== null) line(`ID: ${suggestion.id}`, 'is-meta');
			if (suggestion.op !== 'delete') {
				suggestion.q.split('\n').forEach(l => line('Q: ' + l, 'is-add'));
				if (suggestion.a) {
					const prefix = suggestion.typeIn ? 'A (type): ' : 'A: ';
					suggestion.a.split('\n').forEach(l => line(prefix + l, 'is-add'));
				}
			}
		}

		const actions = box.createDiv({ cls: 'anki-suggestion-actions' });

		if (this.options.onVorschlagWaehlen) {
			box.addClass('is-selectable');
			box.addEventListener('click', (e) => {
				// Knöpfe haben eigene Aufgaben; „Quelltext zeigen" auch.
				if ((e.target as HTMLElement).closest('button, .anki-suggestion-source-toggle')) return;
				this.markiereGewaehlt(box);
				this.options.onVorschlagWaehlen && this.options.onVorschlagWaehlen(aktuell);
			});
		}

		// Was „Übernehmen" anwendet. „Als neue Karte" stellt das um.
		let aktuell: Suggestion = suggestion;
		const applyBtn = new ButtonComponent(actions);
		applyBtn.setButtonText('Übernehmen').setCta();
		applyBtn.onClick(async () => {
			applyBtn.setDisabled(true);
			const result = await applySuggestion(this.plugin.app, this.sourcePath, aktuell, this.plugin.settings.mainDeck);
			if (result.ok) {
				this.markiereUebernommen(box, applyBtn);
				// Jede andere offene Ansicht derselben Notiz mitziehen.
				this.plugin.app.workspace.trigger(
					'anki:suggestion-applied', this.sourcePath, schluessel
				);
			} else {
				applyBtn.setDisabled(false);
				box.addClass('is-missing');
				box.createDiv({ cls: 'anki-suggestion-note', text: result.message });
			}
		});

		// Diagramme gezeichnet zeigen und vorab pruefen: ein Syntaxfehler soll
		// hier auffallen, nicht erst als leere Flaeche in der Notiz oder in Anki.
		const diagramme = mermaidAusVorschlag(suggestion);
		if (diagramme.length) {
			diff.addClass('is-collapsed');
			const toggle = box.createDiv({ cls: 'anki-suggestion-source-toggle', text: 'Quelltext zeigen' });
			toggle.addEventListener('click', () => {
				diff.toggleClass('is-collapsed', !diff.hasClass('is-collapsed'));
				toggle.setText(diff.hasClass('is-collapsed') ? 'Quelltext zeigen' : 'Quelltext verbergen');
			});
			box.insertBefore(toggle, diff);
			const vorschau = box.createDiv({ cls: 'anki-suggestion-preview' });
			box.insertBefore(vorschau, toggle);
			void this.zeichneDiagramme(vorschau, diagramme).then((fehler) => {
				if (!fehler) return;
				applyBtn.setDisabled(true);
				applyBtn.setButtonText('Diagramm fehlerhaft');
				box.addClass('is-missing');
				box.createDiv({ cls: 'anki-suggestion-note', text: 'Mermaid-Syntaxfehler: ' + fehler });
			});
		}

		if (suggestion.kind === 'edit' || suggestion.kind === 'insert') {
			const anker = suggestion.kind === 'edit' ? suggestion.find : suggestion.after;
			const showBtn = new ButtonComponent(actions);
			showBtn.setButtonText('Zeigen');
			showBtn.onClick(() => void this.revealInNote(anker));

			// Früh melden, wenn der zitierte Text gar nicht auffindbar ist.
			// Erneut nach jeder Übernahme: ein Einfügen nach einem Callout, das
			// erst ein anderer Vorschlag anlegt, wird dann gültig.
			const pruefe = () => void canLocateEdit(this.plugin.app, this.sourcePath, suggestion).then((found) => {
				box.querySelectorAll('.anki-suggestion-note.is-locate').forEach((el) => el.remove());
				if (box.hasClass('is-applied')) return;
				if (!box.querySelector('.anki-suggestion-note:not(.is-locate)')) box.toggleClass('is-missing', !found);
				if (!found) {
					box.createDiv({
						cls: 'anki-suggestion-note is-locate',
						text: suggestion.kind === 'insert'
							? 'Ankerzeile nicht in der Notiz gefunden – evtl. erst einen anderen Vorschlag übernehmen.'
							: 'Textstelle nicht in der Notiz gefunden - bitte manuell prüfen.'
					});
				}
			});
			this.pruefungen.set(box, pruefe);
			pruefe();
		}

		if (suggestion.kind === 'card' && suggestion.op !== 'add') {
			// Erfundene oder veraltete Bezuege vor dem Klick zeigen.
			let alsNeuBtn: ButtonComponent | null = null;
			const pruefe = () => void pruefeKartenVorschlag(this.plugin.app, this.sourcePath, suggestion).then((r) => {
				box.querySelectorAll('.anki-suggestion-note.is-locate').forEach((el) => el.remove());
				if (!r || box.hasClass('is-applied') || aktuell !== suggestion) return;
				if (r.ok) {
					box.removeClass('is-missing');
					applyBtn.setDisabled(false);
					if (r.treffer.weg === 'frage') {
						box.createDiv({
							cls: 'anki-suggestion-note is-locate is-info',
							text: 'Die genannte ID passt zu keiner Karte – zugeordnet über die Frage. Bitte im Vergleich prüfen.'
						});
					}
					return;
				}
				box.addClass('is-missing');
				applyBtn.setDisabled(true);
				box.createDiv({ cls: 'anki-suggestion-note is-locate', text: r.message });
				if (suggestion.op === 'update' && !alsNeuBtn) {
					const knopf = new ButtonComponent(actions);
					alsNeuBtn = knopf;
					knopf.setButtonText('Als neue Karte');
					knopf.setTooltip('Den Vorschlag als neue Karte in den anki-cards-Block übernehmen');
					actions.insertBefore(knopf.buttonEl, applyBtn.buttonEl.nextSibling);
					knopf.onClick(() => {
						aktuell = { ...suggestion, op: 'add', id: null, ref: null };
						knopf.buttonEl.remove();
						box.querySelectorAll('.anki-suggestion-note.is-locate').forEach((el) => el.remove());
						box.removeClass('is-missing');
						applyBtn.setDisabled(false);
						applyBtn.setButtonText('Als neue Karte übernehmen');
						if (this.options.onVorschlagWaehlen) {
							this.markiereGewaehlt(box);
							this.options.onVorschlagWaehlen(aktuell);
						}
					});
				}
			});
			this.pruefungen.set(box, pruefe);
			pruefe();
		}

		const dismissBtn = new ButtonComponent(actions);
		dismissBtn.setButtonText('Verwerfen');
		dismissBtn.onClick(() => box.remove());
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
	private async readNote(): Promise<{ content: string; cards: string }> {
		if (!this.sourcePath) return { content: '', cards: '' };

		const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) return { content: '', cards: '' };

		const content = await this.plugin.app.vault.read(file);
		const cards = getAnkiBlocks(content)
			.map(b => parseCardsFromBlockSource(b.innerClean))
			.reduce((acc, list) => acc.concat(list), []);

		return { content, cards: formatCardsToExistingCardsString(cards) };
	}

	// --- Senden -----------------------------------------------------------

	/** Eine Vorschlagsbox als erledigt kennzeichnen. */
	private markiereUebernommen(box: HTMLElement, knopf?: ButtonComponent) {
		if (box.hasClass('is-applied')) return;
		box.addClass('is-applied');
		box.removeClass('is-missing');
		if (knopf) {
			knopf.setDisabled(true);
			knopf.setButtonText('Übernommen');
			return;
		}
		// Kam die Meldung aus einer anderen Ansicht, haben wir den
		// ButtonComponent nicht – dann ueber das DOM.
		const btn = box.querySelector('.anki-suggestion-actions button') as HTMLButtonElement | null;
		if (btn) {
			btn.disabled = true;
			btn.setText('Übernommen');
		}
	}

	/**
	 * Uebernahmen aus einer anderen Ansicht nachziehen.
	 *
	 * Seitenleiste und Tab zeigen denselben Chat. Ohne das bleibt der
	 * Vorschlag drueben anklickbar, und der zweite Klick meldet "Textstelle
	 * nicht gefunden" – der Text ist ja bereits ersetzt.
	 */
	private lauscheAufUebernahmen() {
		this.registerEvent(
			this.plugin.app.workspace.on('anki:suggestion-applied' as any, ((
				sourcePath: string, schluessel: string
			) => {
				if (!schluessel || sourcePath !== this.sourcePath) return;
				// Die Notiz hat sich geaendert: offene Vorschlaege neu pruefen.
				window.setTimeout(() => {
					this.pruefungen.forEach((pruefe, box) => {
						if (!box.isConnected) this.pruefungen.delete(box);
						else if (!box.hasClass('is-applied')) pruefe();
					});
				}, 50);
				const boxen = this.log.querySelectorAll('.anki-suggestion');
				boxen.forEach((el) => {
					if (el instanceof HTMLElement && el.dataset.ankiVorschlag === schluessel) {
						this.markiereUebernommen(el);
					}
				});
			}) as any)
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

		const provider = resolveProvider(this.plugin.settings);
		if (!provider) {
			new Notice('Kein KI-Modell konfiguriert.');
			return;
		}

		this.input.value = '';
		this.input.style.height = 'auto';

		const historyForRequest = this.history.slice();
		this.history.push({ role: 'user', content: text });
		this.appendPending();
		this.scrollToBottom();

		// Platzhalter für die Antwort, der live befüllt wird.
		const placeholder: ChatMessage = { role: 'ai', content: '' };
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
			const { content, cards } = await this.readNote();

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

			const { content, cards } = await this.readNote();
			const prompt = buildAbgleichPrompt({
				noteTitle: title,
				noteContent: content,
				cards,
				sources,
				research: a.research,
				extra: a.extra
			});

			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const storage = require('path').join(dataDir, 'storage');
			const result = await runClaudeAgent({
				cliPath: this.plugin.settings.claudeCliPath || defaultCliPath(),
				prompt,
				cwd: dataDir,
				addDirs: readableDirs(sources, storage),
				research: a.research,
				model: this.plugin.settings.claudeAgentModel,
				signal: this.controller.signal,
				onEvent: (ev: AgentEvent) => {
					if (ev.kind !== 'tool') return;
					schritte++;
					zeile(beschreibeWerkzeug(ev, titelZuPfad.get(norm(ev.detail))));
				}
			});

			const details = [
				'',
				'> [!info]- Abgleich-Details',
				`> Quellen: ${sources.map((s, i) => `${i + 1}. ${s.title}`).join(' · ')}`,
				`> ${result.turns ?? schritte} Schritte · ${Math.round((Date.now() - started) / 1000)} s` +
				(result.costUsd !== null ? ` · ${result.costUsd.toFixed(2)} $` : '')
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
		const provider = resolveProvider(this.plugin.settings);
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
			const { content, cards } = await this.readNote();
			const feedback = await generateFeedbackOnly(
				this.plugin.app, content, provider, this.plugin.settings, controller.signal as any, cards
			);

			// Erst die Warteblase weg, dann die echte Antwort einhaengen –
			// sonst steht sie doppelt da.
			platzhalter.remove();

			if (feedback) {
				this.history = appendFeedbackToCache(this.plugin, this.sourcePath, feedback);
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
