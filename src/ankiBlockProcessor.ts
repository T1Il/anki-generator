import { MarkdownPostProcessorContext, Notice, MarkdownView } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { Card } from './types';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { getCardCountForDeck } from './anki/AnkiConnect';
import { parseCardsFromBlockSource } from './anki/ankiParser';
import { runGenerationProcess } from './generationManager';
import { syncAnkiBlock, saveAnkiBlockChanges } from './anki/syncManager';
import { generateFeedbackOnly } from './aiGenerator';

const ANKI_BLOCK_REGEX = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;

export async function processAnkiCardsBlock(plugin: AnkiGeneratorPlugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
	el.empty();

	const linesForDeck = source.trim().split('\n');
	const deckLine = linesForDeck.find(l => l.trim().startsWith('TARGET DECK:'));
	const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;
	const cards = parseCardsFromBlockSource(source);

	el.createEl('h4', { text: 'Anki-Karten' });

	if (deckName) {
		const synchronizedCount = cards.filter(card => card.id !== null).length;
		const totalCardCount = cards.length;
		const localStatusText = `✅ ${synchronizedCount} Synchronisiert | 📝 ${totalCardCount} Lokal`;

		// Initial render with loading state
		const pEl = el.createEl('p', { text: `⏳ Prüfe Anki... | ${localStatusText}`, cls: 'anki-card-count' });

		// Async check
		getCardCountForDeck(deckName).then(totalAnkiCount => {
			const ankiStatusText = `📈 ${totalAnkiCount} in Anki | `;
			pEl.setText(ankiStatusText + localStatusText);
			pEl.removeClass('anki-error'); // Ensure error class is removed if it was there (re-render case)
		}).catch(e => {
			const ankiStatusText = '⚠️ Anki-Verbindung fehlgeschlagen | ';
			pEl.setText(ankiStatusText + localStatusText);
			pEl.addClass('anki-error');
		});
	}
	// --- BUTTONS LAYOUT ---
	// Row 1: Generation
	const genContainer = el.createDiv({ cls: 'anki-btn-row' });
	genContainer.style.display = 'flex';
	genContainer.style.flexWrap = 'wrap';
	genContainer.style.gap = '6px';
	genContainer.style.marginBottom = '6px';

	// Row 2: Actions
	const actionContainer = el.createDiv({ cls: 'anki-btn-row' });
	actionContainer.style.display = 'flex';
	actionContainer.style.flexWrap = 'wrap';
	actionContainer.style.gap = '6px';
	actionContainer.style.marginBottom = '10px';

	// --- GENERATE BUTTONS (Row 1) ---
	let hasAnyProvider = false;

	if (plugin.settings.geminiApiKey) {
		hasAnyProvider = true;
		const genGeminiBtn = genContainer.createEl('button', { text: '✨ Gemini Generieren' });
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
				renderFeedback(el, feedback);
			}
		};
	}

	if (plugin.settings.openAiApiKey) {
		hasAnyProvider = true;
		const genOpenAiBtn = genContainer.createEl('button', { text: '🤖 OpenAI Generieren' });
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
				renderFeedback(el, feedback);
			}
		};
	}

	if (plugin.settings.ollamaEnabled) {
		hasAnyProvider = true;
		const genOllamaBtn = genContainer.createEl('button', { text: '💻 Ollama Generieren' });
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
		const quickGenButton = genContainer.createEl('button', { text: '⚡ Auto Generieren' });
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
				renderFeedback(el, feedback);
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
		new CardPreviewModal(plugin.app, cardsForModal, currentDeckName, onSave).open();
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
				renderFeedback(el, feedback);
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

	// Check for cached feedback (from recent generation)
	const cachedFeedback = plugin.feedbackCache.get(ctx.sourcePath);
	if (cachedFeedback) {
		console.log("Found cached feedback for", ctx.sourcePath, "rendering it.");
		renderFeedback(el, cachedFeedback);
		plugin.feedbackCache.delete(ctx.sourcePath); // Clear after rendering
	}
}

// Helper function to render feedback
function renderFeedback(container: HTMLElement, feedback: string) { // Renamed 'el' to 'container' for consistency with original
	// Remove existing feedback box if any
	const existingBox = container.querySelector('.anki-feedback-box'); // Changed selector to match new class
	if (existingBox) existingBox.remove();

	const feedbackBox = container.createDiv({ cls: 'anki-feedback-box' }); // Changed class name to 'anki-feedback-box'

	const header = feedbackBox.createDiv({ cls: 'anki-feedback-header' });
	header.createSpan({ text: '🤖 KI Feedback zum Aufschrieb' });

	const closeBtn = header.createEl('button', { cls: 'anki-feedback-close', text: '✖' });
	closeBtn.onclick = () => {
		feedbackBox.remove();
	};

	const content = feedbackBox.createDiv({ cls: 'anki-feedback-content' });
	content.setText(feedback);
}
