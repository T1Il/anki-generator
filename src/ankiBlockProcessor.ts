import { MarkdownPostProcessorContext, Notice, MarkdownView, TFile, MarkdownRenderer } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { Card } from './types';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { getCardCountForDeck } from './anki/AnkiConnect';
import { parseCardsFromBlockSource } from './anki/ankiParser';
import { runGenerationProcess } from './generationManager';
import { syncAnkiBlock, saveAnkiBlockChanges } from './anki/syncManager';
import { generateFeedbackOnly } from './aiGenerator';
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
				renderFeedback(el, feedback, plugin);
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
				renderFeedback(el, feedback, plugin);
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
				renderFeedback(el, feedback, plugin);
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

	// --- FEEDBACK BUTTON ---
	const feedbackButton = actionContainer.createEl('button', { text: '🔍 Feedback einholen' });
	feedbackButton.style.flex = '1';
	feedbackButton.title = "Fragt die KI nach Feedback zur Notiz (ohne Kartengenerierung)";
	feedbackButton.onclick = async () => {
		const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }

		feedbackButton.disabled = true;
		feedbackButton.setText("⏳ Lade...");

		try {
			let provider: 'gemini' | 'openai' | 'ollama' = 'gemini';
			if (plugin.settings.geminiApiKey) provider = 'gemini';
			else if (plugin.settings.openAiApiKey) provider = 'openai';
			else if (plugin.settings.ollamaEnabled) provider = 'ollama';

			const noteContent = view.editor.getValue();
			const feedback = await generateFeedbackOnly(plugin.app, noteContent, provider, plugin.settings);

			if (feedback) {
				renderFeedback(el, feedback, plugin);
				if (ctx.sourcePath) {
					plugin.feedbackCache.set(ctx.sourcePath, feedback);
				}
			} else {
				new Notice("Kein Feedback erhalten.");
			}
		} catch (e: any) {
			new Notice("Fehler beim Abrufen des Feedbacks: " + e.message);
			console.error(e);
		} finally {
			feedbackButton.disabled = false;
			feedbackButton.setText('🔍 Feedback einholen');
		}
	};

	const cachedFeedback = plugin.feedbackCache.get(ctx.sourcePath);
	if (cachedFeedback) {
		console.log("Found cached feedback for", ctx.sourcePath, "rendering it.");
		renderFeedback(el, cachedFeedback, plugin);
		plugin.feedbackCache.delete(ctx.sourcePath);
	}
}

function renderFeedback(container: HTMLElement, feedback: string, plugin: AnkiGeneratorPlugin) {
	const existingBox = container.querySelector('.anki-feedback-box');
	if (existingBox) existingBox.remove();

	const feedbackBox = container.createDiv({ cls: 'anki-feedback-box' });

	const header = feedbackBox.createDiv({ cls: 'anki-feedback-header' });
	header.createSpan({ text: '🤖 KI Feedback zum Aufschrieb' });

	const closeBtn = header.createEl('button', { cls: 'anki-feedback-close', text: '✖' });
	closeBtn.onclick = () => {
		feedbackBox.remove();
	};

	const content = feedbackBox.createDiv({ cls: 'anki-feedback-content' });
	MarkdownRenderer.render(plugin.app, feedback, content, container.getAttribute('src') || '', plugin);
}