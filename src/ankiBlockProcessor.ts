import { MarkdownPostProcessorContext, Notice, MarkdownView, TFile, MarkdownRenderer, ButtonComponent, TextAreaComponent, Modal, App as ObsidianApp, Setting, TextComponent, setIcon, Editor } from 'obsidian';
import { renderFeedback } from './ui/FeedbackRenderer';
import AnkiGeneratorPlugin from './main';
import { Card, ChatMessage } from './types';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { getCardCountForDeck, moveAnkiNotesToDeck, deleteAnkiDeck, getDeckNames } from './anki/AnkiConnect';
import { parseCardsFromBlockSource } from './anki/ankiParser';
import { runGenerationProcess, cleanAiGeneratedText, extractImagesAndPrepareContent } from './generationManager';
import { syncAnkiBlock, saveAnkiBlockChanges } from './anki/syncManager';
import { generateFeedbackOnly, generateChatResponse, constructPrompt } from './aiGenerator';

import { t } from './lang/helpers';
import { ManualGenerationModal } from './ui/ManualGenerationModal';
import { RevisionInputModal } from './ui/RevisionInputModal';
import { RevisionOptionsModal } from './ui/RevisionOptionsModal';

import { DeckSelectionModal } from './ui/DeckSelectionModal';

const ANKI_BLOCK_REGEX = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;

export async function processAnkiCardsBlock(plugin: AnkiGeneratorPlugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
	el.empty();

	const linesForDeck = source.trim().split('\n');
	const deckLine = linesForDeck.find(l => l.trim().startsWith('TARGET DECK:'));
	const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;

	// Parse ALL instruction lines (active and disabled)
	const instructions = linesForDeck
		.map(line => {
			const trimmed = line.trim();
			if (trimmed.startsWith('INSTRUCTION:')) {
				return { text: trimmed.replace('INSTRUCTION:', '').trim(), isActive: true, originalLine: line };
			} else if (trimmed.startsWith('# INSTRUCTION:')) {
				return { text: trimmed.replace('# INSTRUCTION:', '').trim(), isActive: false, originalLine: line };
			}
			return null;
		})
		.filter(i => i !== null) as { text: string, isActive: boolean, originalLine: string }[];

    const activeInstructions = instructions.filter(i => i.isActive).map(i => i.text).join('\n');

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

	// --- INSTRUCTION DISPLAY (Multiple) ---
	if (instructions.length > 0) {
		const instructionContainer = el.createDiv({ cls: 'anki-instructions-container' });
		instructionContainer.style.marginBottom = '10px';

		instructions.forEach((instr, index) => {
			const instructionEl = instructionContainer.createDiv({ cls: 'anki-instruction-row' });
			instructionEl.style.display = 'flex';
			instructionEl.style.justifyContent = 'space-between';
			instructionEl.style.alignItems = 'center';
			instructionEl.style.marginBottom = '4px';
			instructionEl.style.paddingLeft = '10px';
			instructionEl.style.borderLeft = instr.isActive ? '3px solid #4a90e2' : '3px solid #888';
			instructionEl.style.color = instr.isActive ? 'var(--text-normal)' : 'var(--text-muted)';

			const textSpan = instructionEl.createSpan({ text: instr.text });
            textSpan.style.flex = '1';
			textSpan.style.marginRight = '10px';
			if (!instr.isActive) textSpan.style.textDecoration = 'line-through';

            const btnGroup = instructionEl.createDiv({ cls: 'anki-instruction-btns' });
            btnGroup.style.display = 'flex';
            btnGroup.style.gap = '4px';

			// Toggle Button
			const toggleBtn = btnGroup.createEl('button');
            setIcon(toggleBtn, instr.isActive ? 'eye-off' : 'eye');
            toggleBtn.title = instr.isActive ? 'Deaktivieren' : 'Aktivieren';
			toggleBtn.onclick = async () => {
				await updateInstructionInBlock(plugin, ctx.sourcePath, source, instr.originalLine, instr.isActive ? `# INSTRUCTION: ${instr.text}` : `INSTRUCTION: ${instr.text}`);
			};

			// Edit Button
			const editBtn = btnGroup.createEl('button');
            setIcon(editBtn, 'pencil');
            editBtn.title = 'Bearbeiten';
				new RevisionInputModal(plugin.app, async (newText) => {
					const newLine = instr.isActive ? `INSTRUCTION: ${newText}` : `# INSTRUCTION: ${newText}`;
					await updateInstructionInBlock(plugin, ctx.sourcePath, source, instr.originalLine, newLine);
				}, instr.text, "Anweisung bearbeiten").open();

            // Delete Button
            const deleteBtn = btnGroup.createEl('button');
            setIcon(deleteBtn, 'trash');
            deleteBtn.title = 'Löschen';
            deleteBtn.style.color = 'var(--text-error)';
            deleteBtn.onclick = async () => {
                if(confirm("Anweisung löschen?")) {
                    await updateInstructionInBlock(plugin, ctx.sourcePath, source, instr.originalLine, null); // null means delete
                }
            };
		});
	}

    // Add Instruction Button
    const addInstructionBtn = el.createEl('button', { cls: 'anki-add-instruction-btn' });
    addInstructionBtn.setText('+ Anweisung hinzufügen');
    addInstructionBtn.style.fontSize = '0.8em';
    addInstructionBtn.style.marginBottom = '10px';
    addInstructionBtn.style.marginLeft = '0';
    addInstructionBtn.onclick = () => {
        new RevisionInputModal(plugin.app, async (newText) => {
             // Append to block. We need to find the block start or end of instructions.
             // Simplest is to prepend to the block content or append after TARGET DECK.
             // Let's use a helper for this.
             await addInstructionToBlock(plugin, ctx.sourcePath, source, `INSTRUCTION: ${newText}`);
        }, "", "Anweisung hinzufügen").open();
    };

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

	// --- MANUAL MODE BUTTON (If enabled) ---
	if (plugin.settings.enableManualMode) {
		const manualBtn = genContainer.createEl('button', { text: '🛠️ Manueller Modus' });
		manualBtn.style.flex = '1';
		manualBtn.title = "Zeigt den Prompt an und erlaubt manuelle Eingabe";
		manualBtn.onclick = async () => {
			const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!(file instanceof TFile)) {
				new Notice("Konnte Datei nicht finden.");
				return;
			}

			const content = await plugin.app.vault.read(file);
			
			// Extract Images and Prepare Content (using generationManager logic)
			const { images, preparedContent, files } = await extractImagesAndPrepareContent(plugin, content, file.path);
			
			// Construct Prompt
			const existingCardsText = cards.map(c => c.originalText).join('\n');
			const prompt = constructPrompt(preparedContent, existingCardsText, plugin.settings, activeInstructions || "", false, file.basename);

			// Open Manual Modal
			new ManualGenerationModal(plugin.app, prompt, async (manualResponse) => {
				if (!manualResponse) return;

				// Process Response (similar to generationManager)
				const cleanedResponse = cleanAiGeneratedText(manualResponse);
				
				// Re-read file to get latest content
				const currentFileContent = await plugin.app.vault.read(file);
				
				// Find the block. We look for the block that contains the exact source text.
				const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
				const matches = [...currentFileContent.matchAll(blockRegex)];
				const match = matches.find(m => m[1].trim() === source.trim());

				if (match) {
					const fullBlock = match[0];
					const blockContent = match[1];
					
					// Append new cards
					const newBlockContent = `${blockContent.trim()}\n\n${cleanedResponse.trim()}\n`;
					const newBlock = `\`\`\`anki-cards\n${newBlockContent}\`\`\``;
					
					const newFileContent = currentFileContent.replace(fullBlock, newBlock);
					await plugin.app.vault.modify(file, newFileContent);
					new Notice("Manuell generierte Karten hinzugefügt.");

					// AUTO-OPEN PREVIEW MODAL
					// Wait a moment for the cache/file to update, then just open the modal with the new content
					// We can reuse the same logic as the Preview Button, but we need the NEW content.
					// Since we just wrote 'newBlockContent', we can parse relevant cards directly from it.
					// However, the best way is to parse the new block content properly.

					try {
						const newCards = parseCardsFromBlockSource(newBlockContent);
						const currentDeckName = deckName || `${plugin.settings.mainDeck}::Standard`;

						const onSave = async (updatedCards: Card[], deletedCardIds: number[], newDeckName: string) => {
							// For 'source' we need the NEW source which matches newBlockContent. 
							// But the `processAnkiCardsBlock` might be re-run by Obsidian when file changes.
							// So passing 'newBlockContent' as source to saveAnkiBlockChanges should work 
							// IF we are careful not to create race conditions with Obsidian's re-rendering.
							// Ideally, we just update the file again.
							await saveAnkiBlockChanges(plugin, newBlockContent, updatedCards, deletedCardIds, newDeckName);
						};
						
						// Open Modal
						new CardPreviewModal(plugin, newCards, currentDeckName, ctx.sourcePath, onSave, activeInstructions || undefined).open();
					} catch (e) {
						console.error("Auto-open preview failed", e);
					}
				} else {
					new Notice("Konnte den Block nicht finden. Bitte manuell einfügen.");
					// Fallback: Copy to clipboard?
					navigator.clipboard.writeText(cleanedResponse);
					new Notice("Antwort in die Zwischenablage kopiert.");
				}
			}, undefined, files).open();
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
		new CardPreviewModal(plugin, cardsForModal, currentDeckName, ctx.sourcePath, onSave, activeInstructions || undefined).open();
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
				// Move cards (if any)
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
				}

				// Update markdown block
				const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					const editor = view.editor;
					const content = editor.getValue();
					
                    // Find the Correct Block
					const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
					const matches = [...content.matchAll(blockRegex)];
					const match = matches.find(m => m[1].trim() === source.trim());

					if (match) {
						const fullBlock = match[0];
                        let blockContent = match[1];
                        
                        // Check if TARGET DECK line exists
                        if (blockContent.includes('TARGET DECK:')) {
                            blockContent = blockContent.replace(/TARGET DECK: .*$/m, `TARGET DECK: ${newDeckName}`);
                        } else {
                            // Insert at top
                            blockContent = `TARGET DECK: ${newDeckName}\n` + blockContent;
                        }

                        // Reconstruct Block
                        const newBlock = `\`\`\`anki-cards\n${blockContent}\n\`\`\``;
                        
                        // Replace in file
                        const updatedContent = content.replace(fullBlock, newBlock);
						editor.setValue(updatedContent);
                        new Notice(`Deck geändert zu: ${newDeckName}`);
					} else {
                        new Notice("Konnte den Block nicht finden.");
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

        let activeInstructionList: string[] = [];
        if (activeInstructions && activeInstructions.trim()) {
            activeInstructionList = activeInstructions.split('\n');
        }

        const runRevision = async (instruction: string) => {
             let subdeck = "";
			if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
				subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
			}

			const provider = plugin.settings.geminiApiKey ? 'gemini' :
				(plugin.settings.openAiApiKey ? 'openai' :
					(plugin.settings.ollamaEnabled ? 'ollama' : null));

			if (!provider) { new Notice("Kein KI-Modell konfiguriert."); return; }

            const feedback = await runGenerationProcess(plugin, view.editor, provider, subdeck, instruction, true); // isRevision = true
			if (feedback) {
				const history: ChatMessage[] = [{ role: 'ai', content: feedback }];
				if (ctx.sourcePath) plugin.feedbackCache.set(ctx.sourcePath, history);
				renderFeedback(el, history, plugin, ctx.sourcePath, undefined, undefined, undefined, undefined, false);
			}
        };

        new RevisionOptionsModal(
            plugin.app, 
            activeInstructionList, 
            () => runRevision(activeInstructions), // On Use Existing
            (newInstr) => runRevision(newInstr)    // On Use New
        ).open();
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

		renderFeedback(el, history, plugin, ctx.sourcePath, () => {
             plugin.activateFeedbackView(history, ctx.sourcePath || "");
        }, undefined, undefined, undefined, false);
	};

	const cachedHistory = plugin.feedbackCache.get(ctx.sourcePath);
	if (cachedHistory) {
		console.log("Found cached feedback history for", ctx.sourcePath, "rendering it.");
		renderFeedback(el, cachedHistory, plugin, ctx.sourcePath, () => {
             plugin.activateFeedbackView(cachedHistory, ctx.sourcePath || "");
        }, undefined, undefined, undefined, false);
	}
}





export async function getAllCardsForFile(app: ObsidianApp, file: TFile): Promise<{ cards: Card[], deckName: string | null }> {
    try {
        const content = await app.vault.read(file);
        const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
        const matches = [...content.matchAll(blockRegex)];
        
        let allCards: Card[] = [];
        let firstDeckName: string | null = null;

        for (const match of matches) {
            const blockContent = match[1];
             // Extract deck name from first block if not yet found
             if (!firstDeckName) {
                const lines = blockContent.split('\n');
                const deckLine = lines.find(l => l.trim().startsWith('TARGET DECK:'));
                if (deckLine) firstDeckName = deckLine.replace('TARGET DECK:', '').trim();
            }
            const cards = parseCardsFromBlockSource(blockContent);
            allCards = allCards.concat(cards);
        }
        return { cards: allCards, deckName: firstDeckName };
    } catch (e) {
        console.error("Error extracting cards from file:", e);
        return { cards: [], deckName: null };
    }
}

// function to start revision
export async function startRevisionProcess(plugin: AnkiGeneratorPlugin, editor: Editor, deckName: string | null, sourcePath: string | undefined, onFeedback: (history: ChatMessage[]) => void) {
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

        const feedback = await runGenerationProcess(plugin, editor, provider, subdeck, revisionInstruction, true); // isRevision = true
        if (feedback) {
            const history: ChatMessage[] = [{ role: 'ai', content: feedback }];
            if (sourcePath) plugin.feedbackCache.set(sourcePath, history);
            onFeedback(history);
        }
    }, "", "Karten überarbeiten").open();
}

// Fügt den generierten Text korrekt in den Block ein
function insertGeneratedText(editor: Editor, blockStartIndex: number, insertionPoint: CodeMirror.Position, generatedText: string) {
    editor.replaceRange(generatedText, insertionPoint);
}

export async function updateFirstBlockDeck(app: ObsidianApp, file: TFile, newDeckName: string) {
    const content = await app.vault.read(file);
    const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
    const match = content.match(blockRegex);

    if (match) {
        const fullBlock = match[0];
        let blockContent = match[1];
        
        // Check if TARGET DECK line exists
        if (blockContent.includes('TARGET DECK:')) {
            blockContent = blockContent.replace(/TARGET DECK: .*$/m, `TARGET DECK: ${newDeckName}`);
        } else {
            // Insert at top
            blockContent = `TARGET DECK: ${newDeckName}\n` + blockContent;
        }

        // Reconstruct Block
        const newBlock = `\`\`\`anki-cards\n${blockContent}\n\`\`\``;
        
        // Replace in file
        const updatedContent = content.replace(fullBlock, newBlock);
        await app.vault.modify(file, updatedContent);
        new Notice(`Deck geändert zu: ${newDeckName}`);
    } else {
        new Notice("Konnte keinen Anki-Block finden.");
    }
}

// Helper to update specific instruction line
async function updateInstructionInBlock(plugin: AnkiGeneratorPlugin, sourcePath: string, blockSource: string, originalLine: string, newLine: string | null) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    const content = await plugin.app.vault.read(file);
    const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
    const matches = [...content.matchAll(blockRegex)];
    const match = matches.find(m => m[1].trim() === blockSource.trim());

    if (match) {
        const fullBlock = match[0];
        let newBlock = fullBlock;
        
        if (newLine === null) {
            // Delete: Replace with empty string (and maybe cleanup newline)
            newBlock = newBlock.replace(originalLine, '');
            // Cleanup double newlines if left behind
            newBlock = newBlock.replace(/\n\s*\n/g, '\n');
        } else {
            // Replace
            newBlock = newBlock.replace(originalLine, newLine);
        }

        const newContent = content.replace(fullBlock, newBlock);
        await plugin.app.vault.modify(file, newContent);
    } else {
        new Notice("Konnte den Block nicht finden.");
    }
}

async function addInstructionToBlock(plugin: AnkiGeneratorPlugin, sourcePath: string, blockSource: string, instructionLine: string) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    const content = await plugin.app.vault.read(file);
    const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
    const matches = [...content.matchAll(blockRegex)];
    const match = matches.find(m => m[1].trim() === blockSource.trim());

    if (match) {
        const fullBlock = match[0];
        let blockContent = match[1];

        // Insert after TARGET DECK if exists, otherwise at top
        if (blockContent.includes('TARGET DECK:')) {
            // Find end of TARGET DECK line
            const deckMatch = blockContent.match(/^TARGET DECK:.*$/m);
            if (deckMatch) {
                const insertPos = deckMatch.index! + deckMatch[0].length;
                blockContent = blockContent.slice(0, insertPos) + '\n' + instructionLine + blockContent.slice(insertPos);
            } else {
                blockContent = instructionLine + '\n' + blockContent;
            }
        } else {
            blockContent = instructionLine + '\n' + blockContent;
        }

        const newBlock = `\`\`\`anki-cards\n${blockContent}\n\`\`\``; 

        const newContent = content.replace(fullBlock, newBlock);
        await plugin.app.vault.modify(file, newContent);
    } else {
        new Notice("Konnte den Block nicht finden.");
    }
}


