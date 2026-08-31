import { ButtonComponent, MarkdownRenderer, Notice, TFile, setIcon, Component } from 'obsidian';
import AnkiGeneratorPlugin from '../../main';
import { ChatMessage } from '../../types';
import { streamChatResponse, generateFeedbackOnly } from '../../aiGenerator';
import { resolveProvider, PROVIDERS } from '../../providers';
import { parseSuggestions, stripSuggestionBlocks, Suggestion } from '../../chat/suggestions';
import { applySuggestion, canLocateEdit } from '../../chat/applySuggestion';
import { locate } from '../../chat/textLocator';
import { setHistory, clearHistory, appendFeedbackToCache } from '../../chat/chatHistory';
import { getAnkiBlocks, parseCardsFromBlockSource, formatCardsToExistingCardsString } from '../../anki/ankiParser';

export interface ChatPanelOptions {
	/** Im Notiz-Block statt in der Sidebar: begrenzte Höhe, keine Kopfzeilen-Aktionen. */
	embedded?: boolean;
	/** Callback für "In neuem Tab öffnen". */
	onPopOut?: () => void;
	collapsible?: boolean;
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

		if (this.options.onPopOut) {
			const popOut = new ButtonComponent(controls);
			popOut.setIcon('external-link').setTooltip('In neuem Tab öffnen');
			popOut.onClick(() => this.options.onPopOut && this.options.onPopOut());
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

		const prose = isAi ? stripSuggestionBlocks(content) : content;
		if (prose) {
			await MarkdownRenderer.render(this.plugin.app, prose, bubble, this.sourcePath || '', this);
		}

		if (!isAi) return;

		const suggestions = parseSuggestions(content);
		suggestions.forEach((s) => this.renderSuggestion(bubble, s));
	}

	private renderSuggestion(parent: HTMLElement, suggestion: Suggestion) {
		const box = parent.createDiv({ cls: 'anki-suggestion' });

		const title = box.createDiv({ cls: 'anki-suggestion-title' });
		const titleIcon = title.createSpan({ cls: 'anki-chat-role-icon' });

		const diff = box.createEl('pre', { cls: 'anki-suggestion-diff' });
		const line = (text: string, cls: string) =>
			diff.createSpan({ cls: `anki-diff-line ${cls}`, text });

		if (suggestion.kind === 'edit') {
			setIcon(titleIcon, 'pencil');
			title.createSpan({ text: 'Textänderung' });
			suggestion.find.split('\n').forEach(l => line('- ' + l, 'is-remove'));
			suggestion.replace.split('\n').forEach(l => line('+ ' + l, 'is-add'));
		} else {
			setIcon(titleIcon, 'layers');
			const opLabel = suggestion.op === 'add' ? 'Neue Karte'
				: suggestion.op === 'delete' ? 'Karte löschen' : 'Karte ändern';
			title.createSpan({ text: opLabel });

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

		const applyBtn = new ButtonComponent(actions);
		applyBtn.setButtonText('Übernehmen').setCta();
		applyBtn.onClick(async () => {
			applyBtn.setDisabled(true);
			const result = await applySuggestion(this.plugin.app, this.sourcePath, suggestion);
			if (result.ok) {
				box.addClass('is-applied');
				applyBtn.setButtonText('Übernommen');
			} else {
				applyBtn.setDisabled(false);
				box.addClass('is-missing');
				box.createDiv({ cls: 'anki-suggestion-note', text: result.message });
			}
		});

		if (suggestion.kind === 'edit') {
			const showBtn = new ButtonComponent(actions);
			showBtn.setButtonText('Zeigen');
			showBtn.onClick(() => void this.revealInNote(suggestion.find));

			// Früh melden, wenn der zitierte Text gar nicht auffindbar ist.
			void canLocateEdit(this.plugin.app, this.sourcePath, suggestion).then((found) => {
				if (!found) {
					box.addClass('is-missing');
					box.createDiv({
						cls: 'anki-suggestion-note',
						text: 'Textstelle nicht in der Notiz gefunden - bitte manuell prüfen.'
					});
				}
			});
		}

		const dismissBtn = new ButtonComponent(actions);
		dismissBtn.setButtonText('Verwerfen');
		dismissBtn.onClick(() => box.remove());
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

		try {
			const { content } = await this.readNote();
			const feedback = await generateFeedbackOnly(
				this.plugin.app, content, provider, this.plugin.settings, controller.signal as any
			);

			if (feedback) {
				this.history = appendFeedbackToCache(this.plugin, this.sourcePath, feedback);
				this.appendPending();
				this.scrollToBottom();
				// Auch die Sidebar/den Block-Chat informieren.
				this.plugin.app.workspace.trigger('anki:chat-update', this.sourcePath, this.history);
			}
		} catch (e: any) {
			new Notice('Feedback fehlgeschlagen: ' + (e?.message || e));
		} finally {
			notice.hide();
			if (this.sourcePath) this.plugin.removeActiveGeneration(this.sourcePath + '::feedback');
		}
	}
}
