import { MarkdownPostProcessorContext, Notice, MarkdownView, TFile, MarkdownRenderer, ButtonComponent, TextAreaComponent, Modal, App as ObsidianApp, Setting, TextComponent } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { Card, ChatMessage } from './types';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { getCardCountForDeck, moveAnkiNotesToDeck, deleteAnkiDeck, getDeckNames } from './anki/AnkiConnect';
import { parseCardsFromBlockSource } from './anki/ankiParser';
import { runGenerationProcess } from './generationManager';
import { syncAnkiBlock, saveAnkiBlockChanges } from './anki/syncManager';
import { generateFeedbackOnly, generateChatResponse } from './aiGenerator';
import { t } from './lang/helpers';

const ANKI_BLOCK_REGEX = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;

export async function processAnkiCardsBlock(plugin: AnkiGeneratorPlugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
	el.empty();

	const linesForDeck = source.trim().split('\n');
	const deckLine = linesForDeck.find(l => l.trim().startsWith('TARGET DECK:'));
	const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;

	const instructionLine = linesForDeck.find(l => l.trim().startsWith('INSTRUCTION:'));
	const instruction = instructionLine ? instructionLine.replace('INSTRUCTION:', '').trim() : null;

	const disabledInstructionLine = linesForDeck.find(l => l.trim().startsWith('# INSTRUCTION:'));
	const disabledInstruction = disabledInstructionLine ? disabledInstructionLine.replace('# INSTRUCTION:', '').trim() : null;

	const statusLine = linesForDeck.find(l => l.trim().startsWith('STATUS:'));
	const status = statusLine ? statusLine.replace('STATUS:', '').trim() : null;

	const cards = parseCardsFromBlockSource(source);

	el.createEl('h4', { text: 'Anki-Karten' });

	// --- STATUS WARNING ---
	if (status === 'OVERLOADED') {
		const warningEl = el.createDiv({ cls: 'anki-warning' });
		warningEl.style.backgroundColor = 'rgba(255, 165, 0, 0.2)';
		warningEl.style.border = '1px solid orange';
		warningEl.style.padding = '10px';
		warningEl.style.marginBottom = '10px';
		warningEl.style.borderRadius = '5px';
		warningEl.style.display = 'flex';
		warningEl.style.justifyContent = 'space-between';
		warningEl.style.alignItems = 'center';

		warningEl.createEl('strong', { text: t('anki.status.overloaded') });

		const closeWarningBtn = warningEl.createEl('button', { text: '✖' });
		closeWarningBtn.style.background = 'transparent';
		closeWarningBtn.style.border = 'none';
		closeWarningBtn.style.cursor = 'pointer';
		closeWarningBtn.style.fontSize = '1.2em';
		closeWarningBtn.style.padding = '0 5px';
		closeWarningBtn.onclick = async () => {
			const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (file instanceof TFile) {
				const content = await plugin.app.vault.read(file);
				let newContent = content;
				const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
				const matches = [...content.matchAll(blockRegex)];
				const match = matches.find(m => m[1].trim() === source.trim());

				if (match) {
					const fullBlock = match[0];
					const newBlock = fullBlock.replace(`STATUS: ${status}`, ''); // Remove status line
					newContent = content.replace(fullBlock, newBlock);
					await plugin.app.vault.modify(file, newContent);
				}
			}
		};
	}

	// --- INSTRUCTION DISPLAY ---
	if (instruction || disabledInstruction) {
		const instructionEl = el.createDiv({ cls: 'anki-instruction' });
		const isEnabled = !!instruction;
		const text = isEnabled ? instruction : disabledInstruction;

		instructionEl.style.color = isEnabled ? '#4a90e2' : '#888';
		instructionEl.style.fontStyle = 'italic';
		instructionEl.style.borderLeft = isEnabled ? '3px solid #4a90e2' : '3px solid #888';
		instructionEl.style.paddingLeft = '10px';
		instructionEl.style.marginBottom = '10px';
		instructionEl.style.display = 'flex';
		instructionEl.style.justifyContent = 'space-between';
		instructionEl.style.alignItems = 'center';

		const textSpan = instructionEl.createSpan({ text: `${t('anki.instruction')} "${text}"` });
		if (!isEnabled) textSpan.style.textDecoration = 'line-through';

		const toggleBtn = instructionEl.createEl('button', { text: isEnabled ? 'Deaktivieren' : 'Aktivieren' });
		toggleBtn.style.fontSize = '0.8em';
		toggleBtn.style.padding = '2px 5px';
		toggleBtn.style.marginLeft = '10px';
		toggleBtn.onclick = async () => {
			const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (file instanceof TFile) {
				const content = await plugin.app.vault.read(file);
				let newContent = content;
				const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
				const matches = [...content.matchAll(blockRegex)];
				const match = matches.find(m => m[1].trim() === source.trim());

				if (match) {
					const fullBlock = match[0];
					let newBlock = fullBlock;
					if (isEnabled) {
						newBlock = newBlock.replace(`INSTRUCTION: ${instruction}`, `# INSTRUCTION: ${instruction}`);
					} else {
						newBlock = newBlock.replace(`# INSTRUCTION: ${disabledInstruction}`, `INSTRUCTION: ${disabledInstruction}`);
					}
					newContent = content.replace(fullBlock, newBlock);
					await plugin.app.vault.modify(file, newContent);
				} else {
					new Notice("Konnte den Block zum Aktualisieren nicht finden.");
				}
			}
		};

		const editBtn = instructionEl.createEl('button', { text: 'Bearbeiten' });
		editBtn.style.fontSize = '0.8em';
		editBtn.style.padding = '2px 5px';
		editBtn.style.marginLeft = '5px';
		editBtn.onclick = () => {
			new RevisionInputModal(plugin.app, async (newInstruction) => {
				const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
				if (file instanceof TFile) {
					const content = await plugin.app.vault.read(file);
					let newContent = content;
					const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
					const matches = [...content.matchAll(blockRegex)];
					const match = matches.find(m => m[1].trim() === source.trim());

					if (match) {
						const fullBlock = match[0];
						let newBlock = fullBlock;

						// We need to replace the existing instruction line with the new one.
						// It could be active (INSTRUCTION:) or disabled (# INSTRUCTION:).
						// We will make the new one ACTIVE by default if edited? 
						// Or preserve state? Let's make it active.

						if (isEnabled) {
							newBlock = newBlock.replace(`INSTRUCTION: ${instruction}`, `INSTRUCTION: ${newInstruction}`);
						} else {
							newBlock = newBlock.replace(`# INSTRUCTION: ${disabledInstruction}`, `INSTRUCTION: ${newInstruction}`);
						}

						newContent = content.replace(fullBlock, newBlock);
						await plugin.app.vault.modify(file, newContent);
					} else {
						new Notice("Konnte den Block zum Aktualisieren nicht finden.");
					}
				}
			}, text || "").open(); // Pass current text as default, ensure string
		};
	}

	if (deckName) {
		const synchronizedCount = cards.filter(card => card.id !== null).length;
		const totalCardCount = cards.length;
		const localStatusText = `✅ ${synchronizedCount} ${t('anki.synced')} | 📝 ${totalCardCount} ${t('anki.local')}`;

		const pEl = el.createEl('p', { text: `${t('anki.check')} | ${localStatusText}`, cls: 'anki-card-count' });

		getCardCountForDeck(deckName).then(totalAnkiCount => {
			const ankiStatusText = `📈 ${totalAnkiCount} ${t('anki.inAnki')} | `;
			pEl.setText(ankiStatusText + localStatusText);
			pEl.removeClass('anki-error');
		}).catch(e => {
			const ankiStatusText = `${t('anki.connectionFailed')} | `;
			pEl.setText(ankiStatusText + localStatusText);
			pEl.addClass('anki-error');
		});
	}

	// --- BUTTONS LAYOUT ---
	const genContainer = el.createDiv({ cls: 'anki-btn-row' });
	genContainer.style.display = 'flex';
	genContainer.style.flexWrap = 'wrap';
	genContainer.style.gap = '6px';
	genContainer.style.marginBottom = '6px';

	const actionContainer = el.createDiv({ cls: 'anki-btn-row' });
	actionContainer.style.display = 'flex';
	actionContainer.style.flexWrap = 'wrap';
	actionContainer.style.gap = '6px';
	actionContainer.style.marginBottom = '10px';

	// --- GENERATE BUTTONS (Row 1) ---
	let hasAnyProvider = false;

	if (plugin.settings.geminiApiKey) {
		hasAnyProvider = true;
		const genGeminiBtn = genContainer.createEl('button', { text: '✨ Gemini generieren' });
		genGeminiBtn.style.flex = '1';
		genGeminiBtn.onclick = async () => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }

			let subdeck = "";
			if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
				subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
			}

			const feedback = await runGenerationProcess(plugin, view.editor, 'gemini', subdeck, "");
			if (feedback) {
				const history: ChatMessage[] = [{ role: 'ai', content: feedback }];
				if (ctx.sourcePath) plugin.feedbackCache.set(ctx.sourcePath, history);
				renderFeedback(el, history, plugin, ctx.sourcePath);
			}
		};
	}

	if (plugin.settings.openAiApiKey) {
		hasAnyProvider = true;
		const genOpenAiBtn = genContainer.createEl('button', { text: '🤖 OpenAI generieren' });
		genOpenAiBtn.style.flex = '1';
		genOpenAiBtn.onclick = async () => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }

			let subdeck = "";
			if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
				subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
			}

			const feedback = await runGenerationProcess(plugin, view.editor, 'openai', subdeck, "");
			if (feedback) {
				const history: ChatMessage[] = [{ role: 'ai', content: feedback }];
				if (ctx.sourcePath) plugin.feedbackCache.set(ctx.sourcePath, history);
				renderFeedback(el, history, plugin, ctx.sourcePath);
			}
		};
	}

	if (plugin.settings.ollamaEnabled) {
		hasAnyProvider = true;
		const genOllamaBtn = genContainer.createEl('button', { text: '💻 Ollama generieren' });
		genOllamaBtn.style.flex = '1';
		genOllamaBtn.onclick = async () => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }

			let subdeck = "";
			if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
				subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
			}

			await runGenerationProcess(plugin, view.editor, 'ollama', subdeck, "");
		};
	}

	if (hasAnyProvider) {
		const quickGenButton = genContainer.createEl('button', { text: '⚡ Auto generieren' });
		quickGenButton.style.flex = '1';
		quickGenButton.title = "Generiert Karten (Gemini bevorzugt)";
		quickGenButton.onclick = async () => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }

			let subdeck = "";
			if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
				subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
			}

			const provider = plugin.settings.geminiApiKey ? 'gemini' :
				(plugin.settings.openAiApiKey ? 'openai' :
					(plugin.settings.ollamaEnabled ? 'ollama' : null));

			if (!provider) { new Notice("Kein KI-Modell konfiguriert."); return; }

			const feedback = await runGenerationProcess(plugin, view.editor, provider, subdeck, "");
			if (feedback) {
				const history: ChatMessage[] = [{ role: 'ai', content: feedback }];
				if (ctx.sourcePath) plugin.feedbackCache.set(ctx.sourcePath, history);
				renderFeedback(el, history, plugin, ctx.sourcePath);
			}
		};
	}

	// --- ACTION BUTTONS (Row 2) ---
	const previewButton = actionContainer.createEl('button', { text: '📝 Vorschau & Bearbeiten' });
	previewButton.style.flex = '1';
	previewButton.onclick = () => {
		const cardsForModal = JSON.parse(JSON.stringify(cards)) as Card[];
		const currentDeckName = deckName || `${plugin.settings.mainDeck}::Standard`;

		const onSave = async (updatedCards: Card[], deletedCardIds: number[], newDeckName: string) => {
			await saveAnkiBlockChanges(plugin, source, updatedCards, deletedCardIds, newDeckName);
		};
		// FIX: Hier übergeben wir 'plugin' statt 'plugin.app'
		new CardPreviewModal(plugin, cardsForModal, currentDeckName, onSave, instruction || undefined).open();
	};

	const syncButton = actionContainer.createEl('button', { text: '🔄 Sync mit Anki' });
	syncButton.style.flex = '1';
	syncButton.onclick = async () => {
		const activeFile = plugin.app.workspace.getActiveFile();
		if (activeFile) {
			await syncAnkiBlock(plugin, source, deckName, cards, activeFile);
		} else {
			new Notice("Keine aktive Datei gefunden.");
		}
	};



	const changeDeckButton = actionContainer.createEl('button', { text: '📁 Deck ändern' });
	changeDeckButton.style.flex = '1';
	changeDeckButton.title = "Verschiebe Karten in ein anderes Deck";
	changeDeckButton.onclick = async () => {
		// Fetch live deck names
		let deckNames: string[] = [];
		try {
			deckNames = await getDeckNames();
		} catch (e: any) {
			new Notice("Anki ist nicht verbunden. Bitte starte Anki und versuche es erneut.");
			return;
		}
		// Open modal
		new DeckSelectionModal(plugin.app, deckName || plugin.settings.mainDeck, deckNames, async (newDeckName: string) => {
			if (!newDeckName || newDeckName === deckName) return;
			try {
				// Move cards
				const noteIds = cards.map(c => c.id).filter(Boolean) as number[];
				if (noteIds.length > 0) {
					await moveAnkiNotesToDeck(noteIds, newDeckName);
					new Notice(`${noteIds.length} Karte(n) nach "${newDeckName}" verschoben.`);
					// Check if old deck is empty and delete it
					if (deckName) {
						const cardCount = await getCardCountForDeck(deckName);
						if (cardCount === 0) {
							await deleteAnkiDeck(deckName);
							new Notice(`Leeres Deck "${deckName}" gelöscht.`);
						}
					}
					// Update markdown block
					const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
					if (view) {
						const editor = view.editor;
						const content = editor.getValue();
						const updatedContent = content.replace(
							/TARGET DECK: .*$/m,
							`TARGET DECK: ${newDeckName}`
						);
						editor.setValue(updatedContent);
					}
				}
			} catch (e: any) {
				new Notice("Fehler beim Verschieben: " + e.message);
			}
		}).open();
	};

	// --- REVISE BUTTON ---
	const reviseButton = actionContainer.createEl('button', { text: '✏️ Karten überarbeiten' });
	reviseButton.style.flex = '1';
	reviseButton.title = "Überarbeite bestehende Karten mit KI";
	reviseButton.onclick = async () => {
		const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }

		new RevisionInputModal(plugin.app, async (instruction) => {
			let subdeck = "";
			if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
				subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
			}

			const provider = plugin.settings.geminiApiKey ? 'gemini' :
				(plugin.settings.openAiApiKey ? 'openai' :
					(plugin.settings.ollamaEnabled ? 'ollama' : null));

			if (!provider) { new Notice("Kein KI-Modell konfiguriert."); return; }

			// Construct a revision-specific instruction
			const revisionInstruction = instruction; // Instruction from modal

			const feedback = await runGenerationProcess(plugin, view.editor, provider, subdeck, revisionInstruction, true); // isRevision = true
			if (feedback) {
				const history: ChatMessage[] = [{ role: 'ai', content: feedback }];
				if (ctx.sourcePath) plugin.feedbackCache.set(ctx.sourcePath, history);
				renderFeedback(el, history, plugin, ctx.sourcePath);
			}
		}).open();
	};

	// --- CHAT BUTTON ---
	const chatButton = actionContainer.createEl('button', { text: '💬 Chat öffnen' });
	chatButton.style.flex = '1';
	chatButton.title = "Öffnet den KI-Chat";
	chatButton.onclick = () => {
		const history: ChatMessage[] = [];
		if (ctx.sourcePath) {
			const cached = plugin.feedbackCache.get(ctx.sourcePath);
			if (cached) history.push(...cached);
		}
		renderFeedback(el, history, plugin, ctx.sourcePath);
	};

	const cachedHistory = plugin.feedbackCache.get(ctx.sourcePath);
	if (cachedHistory) {
		console.log("Found cached feedback history for", ctx.sourcePath, "rendering it.");
		renderFeedback(el, cachedHistory, plugin, ctx.sourcePath);
	}
}

function renderFeedback(container: HTMLElement, history: ChatMessage[], plugin: AnkiGeneratorPlugin, sourcePath?: string) {
	const existingBox = container.querySelector('.anki-feedback-box');
	if (existingBox) existingBox.remove();

	const feedbackBox = container.createDiv({ cls: 'anki-feedback-box' });

	// Styling for persistence and visibility
	feedbackBox.style.border = '1px solid #4a90e2';
	feedbackBox.style.borderRadius = '5px';
	feedbackBox.style.padding = '10px';
	feedbackBox.style.marginTop = '10px';
	feedbackBox.style.backgroundColor = 'rgba(74, 144, 226, 0.1)';

	const header = feedbackBox.createDiv({ cls: 'anki-feedback-header' });
	header.style.display = 'flex';
	header.style.justifyContent = 'space-between';
	header.style.alignItems = 'center';
	header.style.marginBottom = '10px';
	header.style.borderBottom = '1px solid rgba(74, 144, 226, 0.3)';
	header.style.paddingBottom = '5px';

	header.createSpan({ text: '🤖 KI Chat & Feedback', cls: 'anki-feedback-title' }).style.fontWeight = 'bold';

	const closeBtn = header.createEl('button', { cls: 'anki-feedback-close', text: '✖' });
	closeBtn.title = "Schließen";
	closeBtn.onclick = () => {
		feedbackBox.remove();
	};

	const clearBtn = header.createEl('button', { cls: 'anki-feedback-close', text: '🗑️' });
	clearBtn.title = "Chat leeren";
	clearBtn.style.marginRight = "5px";
	clearBtn.onclick = () => {
		history.length = 0; // Clear array
		if (sourcePath) plugin.feedbackCache.delete(sourcePath);
		renderFeedback(container, history, plugin, sourcePath);
	};

	const contentArea = feedbackBox.createDiv({ cls: 'anki-feedback-content' });
	contentArea.style.maxHeight = '300px';
	contentArea.style.overflowY = 'auto';
	contentArea.style.marginBottom = '10px';

	// Scrollbar Styling (Webkit)
	const styleEl = feedbackBox.createEl('style');
	styleEl.textContent = `
		.anki-feedback-content::-webkit-scrollbar {
			width: 12px;
			background-color: rgba(0, 0, 0, 0.05);
		}
		.anki-feedback-content::-webkit-scrollbar-track {
			background: rgba(0, 0, 0, 0.1);
			border-radius: 6px;
		}
		.anki-feedback-content::-webkit-scrollbar-thumb {
			background-color: #2e6da4; /* High contrast blue (darker) */
			border-radius: 6px;
			border: 2px solid #ffffff; /* White border for contrast against track */
		}
		.anki-feedback-content::-webkit-scrollbar-thumb:hover {
			background-color: #1d4e7a;
		}
	`;

	// Render History
	if (history.length === 0) {
		const emptyMsg = contentArea.createDiv({ cls: 'anki-chat-empty' });
		emptyMsg.setText("Noch keine Nachrichten. Starte eine Unterhaltung oder hole Feedback ein.");
		emptyMsg.style.fontStyle = 'italic';
		emptyMsg.style.color = '#888';
		emptyMsg.style.textAlign = 'center';
		emptyMsg.style.padding = '20px';
	} else {
		history.forEach(msg => {
			const msgDiv = contentArea.createDiv({ cls: `anki-chat-message ${msg.role}` });
			msgDiv.style.marginBottom = '8px';
			msgDiv.style.padding = '8px';
			msgDiv.style.borderRadius = '5px';
			msgDiv.style.backgroundColor = msg.role === 'ai' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(74, 144, 226, 0.2)';
			msgDiv.style.alignSelf = msg.role === 'ai' ? 'flex-start' : 'flex-end';

			const roleLabel = msgDiv.createDiv({ cls: 'anki-chat-role' });
			roleLabel.setText(msg.role === 'ai' ? '🤖 AI:' : '👤 Du:');
			roleLabel.style.fontWeight = 'bold';
			roleLabel.style.fontSize = '0.8em';
			roleLabel.style.marginBottom = '4px';

			const textDiv = msgDiv.createDiv({ cls: 'anki-chat-text' });
			MarkdownRenderer.render(plugin.app, msg.content, textDiv, container.getAttribute('src') || '', plugin);
		});
	}

	// Auto-scroll to bottom
	setTimeout(() => {
		contentArea.scrollTop = contentArea.scrollHeight;
	}, 0);

	// Input Area
	const inputArea = feedbackBox.createDiv({ cls: 'anki-feedback-input' });
	inputArea.style.display = 'flex';
	inputArea.style.flexDirection = 'column'; // Stack input and buttons
	inputArea.style.gap = '5px';

	const textInputContainer = inputArea.createDiv();
	textInputContainer.style.display = 'flex';
	textInputContainer.style.gap = '5px';

	const input = new TextAreaComponent(textInputContainer);
	input.setPlaceholder("Stelle eine Rückfrage...");
	input.inputEl.style.flex = '1';
	input.inputEl.rows = 2;

	const sendBtn = new ButtonComponent(textInputContainer);
	sendBtn.setButtonText("Senden");
	sendBtn.setCta();
	sendBtn.onClick(async () => {
		const userText = input.getValue().trim();
		if (!userText) return;

		// Add user message to history
		history.push({ role: 'user', content: userText });
		input.setValue("");

		// Re-render immediately to show user message
		renderFeedback(container, history, plugin, sourcePath);

		// Call AI
		try {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			const noteContent = view ? view.editor.getValue() : "";

			let provider: 'gemini' | 'openai' | 'ollama' = 'gemini';
			if (plugin.settings.geminiApiKey) provider = 'gemini';
			else if (plugin.settings.openAiApiKey) provider = 'openai';
			else if (plugin.settings.ollamaEnabled) provider = 'ollama';

			const aiResponse = await generateChatResponse(plugin.app, history, userText, noteContent, provider, plugin.settings);

			history.push({ role: 'ai', content: aiResponse });
			if (sourcePath) plugin.feedbackCache.set(sourcePath, history);

			renderFeedback(container, history, plugin, sourcePath);

		} catch (e: any) {
			new Notice("Fehler bei der Antwort: " + e.message);
			history.push({ role: 'ai', content: "Fehler: " + e.message });
			renderFeedback(container, history, plugin, sourcePath);
		}
	});

	// --- FEEDBACK BUTTON INSIDE CHAT ---
	const feedbackBtnContainer = inputArea.createDiv();
	feedbackBtnContainer.style.display = 'flex';
	feedbackBtnContainer.style.justifyContent = 'flex-start';

	const getFeedbackBtn = new ButtonComponent(feedbackBtnContainer);
	getFeedbackBtn.setButtonText("🔍 Feedback einholen");
	getFeedbackBtn.setTooltip("Analysiert die Notiz und gibt Feedback");
	getFeedbackBtn.onClick(async () => {
		getFeedbackBtn.setDisabled(true);
		getFeedbackBtn.setButtonText("⏳ Lade...");

		try {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }
			const noteContent = view.editor.getValue();

			let provider: 'gemini' | 'openai' | 'ollama' = 'gemini';
			if (plugin.settings.geminiApiKey) provider = 'gemini';
			else if (plugin.settings.openAiApiKey) provider = 'openai';
			else if (plugin.settings.ollamaEnabled) provider = 'ollama';

			const feedback = await generateFeedbackOnly(plugin.app, noteContent, provider, plugin.settings);

			if (feedback) {
				history.push({ role: 'ai', content: feedback });
				if (sourcePath) plugin.feedbackCache.set(sourcePath, history);
				renderFeedback(container, history, plugin, sourcePath);
			} else {
				new Notice("Kein Feedback erhalten.");
			}
		} catch (e: any) {
			new Notice("Fehler beim Abrufen des Feedbacks: " + e.message);
			console.error(e);
		} finally {
			getFeedbackBtn.setDisabled(false);
			getFeedbackBtn.setButtonText("🔍 Feedback einholen");
		}
	});
}

class RevisionInputModal extends Modal {
	onSubmit: (result: string) => void;
	instruction: string;
	initialValue: string;

	constructor(app: ObsidianApp, onSubmit: (result: string) => void, initialValue: string = "") {
		super(app);
		this.onSubmit = onSubmit;
		this.instruction = initialValue;
		this.initialValue = initialValue;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.initialValue ? "Anweisung bearbeiten" : "Karten überarbeiten" });

		new TextAreaComponent(contentEl)
			.setPlaceholder("Anweisung...")
			.setValue(this.initialValue)
			.onChange((value) => {
				this.instruction = value;
			})
			.inputEl.style.width = '100%';

		const btnContainer = contentEl.createDiv();
		btnContainer.style.marginTop = '10px';
		btnContainer.style.display = 'flex';
		btnContainer.style.justifyContent = 'flex-end';

		new ButtonComponent(btnContainer)
			.setButtonText(this.initialValue ? "Speichern" : "Überarbeiten")
			.setCta()
			.onClick(() => {
				this.close();
				this.onSubmit(this.instruction);
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class DeckSelectionModal extends Modal {
	onSubmit: (result: string) => void;
	deckName: string;
	deckNames: string[];
	mainDeck: string;
	constructor(app: ObsidianApp, currentDeck: string, deckNames: string[], onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.deckName = currentDeck;
		this.deckNames = deckNames;
		// Extract mainDeck from currentDeck or use first part of any deck
		this.mainDeck = currentDeck.split('::')[0] || 'Default';
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Deck ändern" });
		contentEl.createEl("p", { text: "Wähle ein existierendes Deck oder gib einen neuen Namen ein." });
		const container = contentEl.createDiv();
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.gap = '10px';
		// Preview Area
		const previewEl = container.createDiv({ cls: 'anki-deck-preview' });
		previewEl.style.padding = '10px';
		previewEl.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
		previewEl.style.borderRadius = '5px';
		previewEl.style.fontFamily = 'monospace';
		previewEl.style.marginBottom = '10px';
		this.updatePreview(previewEl, this.deckName);
		// Input field using Setting
		const deckSetting = new Setting(container)
			.setName("Deck Name")
			.setDesc("Gib den Namen des Decks ein oder wähle aus der Liste.");
		let deckInput: TextComponent;
		deckSetting.addText((text) => {
			deckInput = text;
			text.setValue(this.deckName)
				.setPlaceholder("Deck Name")
				.onChange((value) => {
					this.deckName = value;
					this.updatePreview(previewEl, value);
					this.renderSuggestions(suggestionsEl, deckInput, previewEl);
				});
			text.inputEl.style.width = '100%';
		});
		// Suggestions List
		const suggestionsEl = container.createDiv({ cls: 'anki-deck-suggestions' });
		suggestionsEl.style.maxHeight = '400px';
		suggestionsEl.style.overflowY = 'auto';
		suggestionsEl.style.border = '1px solid rgba(255, 255, 255, 0.1)';
		suggestionsEl.style.borderRadius = '5px';
		suggestionsEl.style.padding = '5px';
		suggestionsEl.style.marginTop = '-10px';
		suggestionsEl.style.marginBottom = '10px';
		suggestionsEl.style.display = 'block'; // Always visible
		this.renderSuggestions(suggestionsEl, deckInput!, previewEl);
		// Focus input
		setTimeout(() => deckInput.inputEl.focus(), 50);
		const btnContainer = contentEl.createDiv();
		btnContainer.style.marginTop = '10px';
		btnContainer.style.display = 'flex';
		btnContainer.style.justifyContent = 'flex-end';
		new ButtonComponent(btnContainer)
			.setButtonText("Ändern & Verschieben")
			.setCta()
			.onClick(() => {
				this.close();
				this.onSubmit(this.deckName);
			});
	}
	updatePreview(el: HTMLElement, name: string) {
		el.empty();
		if (!name) {
			el.setText("Vorschau: (Kein Name)");
			return;
		}
		const parts = name.split("::");
		const hierarchy = parts.join(" ➤ ");
		el.setText("Vorschau: " + hierarchy);
	}
	renderSuggestions(container: HTMLElement, input: TextComponent, previewEl: HTMLElement) {
		container.empty();
		container.style.display = 'block'; // Always show
		// Build a tree structure from filtered deck names
		interface TreeNode {
			name: string;
			fullPath: string;
			children: Map<string, TreeNode>;
			level: number;
		}
		const root: TreeNode = { name: '', fullPath: '', children: new Map(), level: -1 };
		// Parse all decks into tree - ONLY decks within mainDeck
		this.deckNames.forEach(deckPath => {
			// Skip if not a subdeck of mainDeck
			if (!deckPath.startsWith(this.mainDeck + "::")) return;
			// Extract subdeck part (remove mainDeck prefix)
			const relevantPath = deckPath.substring(this.mainDeck.length + 2);
			const parts = relevantPath.split('::');
			let currentNode = root;
			parts.forEach((part, index) => {
				if (!currentNode.children.has(part)) {
					const pathSoFar = parts.slice(0, index + 1).join('::');
					currentNode.children.set(part, {
						name: part,
						fullPath: pathSoFar,
						children: new Map(),
						level: index
					});
				}
				currentNode = currentNode.children.get(part)!;
			});
		});
		// Render tree recursively
		const renderNode = (node: TreeNode, parentEl: HTMLElement) => {
			node.children.forEach(child => {
				const item = parentEl.createDiv({ cls: 'anki-deck-suggestion-item' });
				item.style.padding = '5px';
				item.style.paddingLeft = `${child.level * 20 + 5}px`;
				item.style.cursor = 'pointer';
				item.style.borderRadius = '3px';
				item.style.transition = 'background-color 0.2s';
				const emoji = child.level === 0 ? '🗂️' : '📂';
				item.setText(`${emoji} ${child.name}`);
				item.style.fontSize = '0.9em';
				// Check if this deck is in the path of the input
				// Normalize both to compare relative paths
				const normalizedInput = this.deckName.replace(this.mainDeck + '::', '').toLowerCase();
				const isMatch = child.fullPath.toLowerCase() === normalizedInput;
				const isInPath = normalizedInput.startsWith(child.fullPath.toLowerCase() + '::') || isMatch;
				if (isInPath) {
					item.style.backgroundColor = isMatch ? 'rgba(74, 144, 226, 0.4)' : 'rgba(74, 144, 226, 0.2)';
					item.style.fontWeight = isMatch ? 'bold' : '600';
				}
				item.onmouseover = () => {
					if (!isInPath) {
						item.style.backgroundColor = 'rgba(74, 144, 226, 0.15)';
					}
				};
				item.onmouseout = () => {
					if (!isInPath) {
						item.style.backgroundColor = 'transparent';
					} else {
						item.style.backgroundColor = isMatch ? 'rgba(74, 144, 226, 0.4)' : 'rgba(74, 144, 226, 0.2)';
					}
				};
				item.onclick = () => {
					// Set full path including mainDeck
					this.deckName = this.mainDeck + '::' + child.fullPath;
					input.setValue(this.deckName);
					this.updatePreview(previewEl, this.deckName);
					this.renderSuggestions(container, input, previewEl); // Re-render to highlight
				};
				// Recursively render children
				if (child.children.size > 0) {
					renderNode(child, parentEl);
				}
			});
		};
		renderNode(root, container);
	}
	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}