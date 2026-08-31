import { MarkdownPostProcessorContext, Notice, MarkdownView, TFile, MarkdownRenderer, ButtonComponent, TextAreaComponent, Modal, App as ObsidianApp, Setting, TextComponent, setIcon, Editor } from 'obsidian';
import { renderFeedback } from './ui/FeedbackRenderer';
import AnkiGeneratorPlugin from './main';
import { Card, ChatMessage } from './types';
import { CardPreviewModal } from './ui/CardPreviewModal';
import { getCardCountForDeck, moveAnkiNotesToDeck, deleteAnkiDeck, getDeckNames } from './anki/AnkiConnect';
import { AnkiParsedInfo, parseAnkiSection, parseCardsFromBlockSource, formatCardsToString, ANKI_BLOCK_REGEX, getAnkiBlockMatches, getAnkiBlocks, buildFullBlock, spliceBlock } from './anki/ankiParser';
import { runGenerationProcess, cleanAiGeneratedText, extractImagesAndPrepareContent } from './generationManager';
import { syncAnkiBlock, saveAnkiBlockChanges } from './anki/syncManager';
import { generateFeedbackOnly, generateChatResponse, constructPrompt } from './aiGenerator';

import { t } from './lang/helpers';
import { ManualGenerationModal } from './ui/ManualGenerationModal';
import { RevisionInputModal } from './ui/RevisionInputModal';
import { RevisionOptionsModal } from './ui/RevisionOptionsModal';

import { DeckSelectionModal } from './ui/DeckSelectionModal';
import { resolveProvider } from './providers';
import { getAvailableProviders, PROVIDERS } from './providers';
import { appendFeedbackToCache } from './chat/chatHistory';



export async function processAnkiCardsBlock(plugin: AnkiGeneratorPlugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
	el.empty();
	// console.log("Processing Anki Block source length:", source.length);

	const linesForDeck = source.trim().split('\n');
	const deckLine = linesForDeck.find(l => l.trim().startsWith('TARGET DECK:'));
	const deckName = deckLine ? deckLine.replace('TARGET DECK:', '').trim() : null;

	// Parse ALL instruction lines (active and disabled)
	const instructions = linesForDeck
		.filter(line => line.trim().startsWith('INSTRUCTION:') || line.trim().startsWith('# INSTRUCTION:'))
		.map(line => ({
			text: line.replace(/^#? ?INSTRUCTION:/, '').trim(),
			isActive: line.trim().startsWith('INSTRUCTION:'),
			originalLine: line
		}));

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
				const matches = getAnkiBlockMatches(content);
				const match = matches.find(m => m[1].trim() === source.trim());

				if (match) {
					const fullBlock = match[0];
					const newBlock = fullBlock.replace(`STATUS: ${status}`, ''); // Remove status line
					// Remove empty lines left behind? Regex replace might leave a blank line.
					// Simple replace is safe enough.
					newContent = spliceBlock(content, match.block, newBlock);
					await plugin.app.vault.modify(file, newContent);
				}
			}
		};
	}

	// --- INSTRUCTION DISPLAY (Multiple) ---
	const instrContainer = el.createDiv({ cls: 'anki-instructions-container' });
    if (instructions.length > 0) {
        instructions.forEach((instr, index) => {
            const row = instrContainer.createDiv({ cls: 'anki-instruction-row' });
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.marginBottom = '4px';
            row.style.padding = '4px 8px';
            row.style.backgroundColor = 'var(--background-secondary)';
            row.style.borderRadius = '4px';
            row.style.borderLeft = instr.isActive ? '3px solid #4a90e2' : '3px solid #888';

            const textSpan = row.createSpan({ text: `${t('anki.instruction')} "${instr.text}"` });
            textSpan.style.flex = '1';
            textSpan.style.marginRight = '10px';
            if (!instr.isActive) {
                textSpan.style.textDecoration = 'line-through';
                textSpan.style.color = 'var(--text-muted)';
            } else {
                textSpan.style.color = 'var(--text-normal)'; // Or accent color?
            }

            const btnGroup = row.createDiv({ cls: 'anki-instr-buttons' });
            btnGroup.style.display = 'flex';
            btnGroup.style.gap = '4px';

            // Toggle Button
            const toggleBtn = btnGroup.createEl('button');
            setIcon(toggleBtn, instr.isActive ? 'eye-off' : 'eye'); 
            toggleBtn.title = instr.isActive ? 'Deaktivieren' : 'Aktivieren';
            toggleBtn.onclick = async () => {
                const newLine = instr.isActive ? `# INSTRUCTION: ${instr.text}` : `INSTRUCTION: ${instr.text}`;
                await updateInstructionInBlock(plugin, ctx.sourcePath, source, instr.originalLine, newLine);
            };

            // Edit Button
            const editBtn = btnGroup.createEl('button');
            setIcon(editBtn, 'pencil');
            editBtn.title = 'Bearbeiten';
            editBtn.onclick = () => {
				new RevisionInputModal(plugin.app, async (newText) => {
					const newLine = instr.isActive ? `INSTRUCTION: ${newText}` : `# INSTRUCTION: ${newText}`;
					await updateInstructionInBlock(plugin, ctx.sourcePath, source, instr.originalLine, newLine);
				}, instr.text, "Anweisung bearbeiten").open();
            };

            // Delete Button
            const deleteBtn = btnGroup.createEl('button');
            setIcon(deleteBtn, 'trash');
            deleteBtn.title = 'Löschen';
            deleteBtn.style.color = 'var(--text-error)';
            deleteBtn.onclick = async () => {
                 await deleteInstructionFromBlock(plugin, ctx.sourcePath, source, instr.originalLine);
            };
        });
    }

	// Add New Instruction Button (Small)
    const addInstrBtn = instrContainer.createEl('button', { cls: 'anki-add-instr-btn' });
    addInstrBtn.innerText = "+ Anweisung hinzufügen";
    addInstrBtn.style.fontSize = '0.8em';
    addInstrBtn.style.marginTop = '4px';
    addInstrBtn.onclick = () => {
        new RevisionInputModal(plugin.app, async (newText) => {
             // Default to active
             await addInstructionToBlock(plugin, ctx.sourcePath, source, `INSTRUCTION: ${newText}`);
        }, "", "Neue Anweisung hinzufügen").open();
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
	// Ein Button je konfiguriertem Provider, aus der Registry statt hartcodiert.
	const providerIcons: Record<string, string> = {
		gemini: '\u2728',
		claude: '\u25c6',
		openai: '\u{1F916}',
		ollama: '\u{1F4BB}'
	};

	const configuredProviders = getAvailableProviders(plugin.settings);
	const hasAnyProvider = configuredProviders.length > 0;

	configuredProviders.forEach((providerId) => {
		const label = `${providerIcons[providerId] || ''} ${PROVIDERS[providerId].label} generieren`.trim();
		const genBtn = genContainer.createEl('button', { text: label });
		genBtn.style.flex = '1';
		genBtn.onclick = async () => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) { new Notice("Konnte keinen aktiven Editor finden."); return; }

			let subdeck = "";
			if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
				subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
			}

			const activeInstrText = instructions.filter(i => i.isActive).map(i => i.text).join('\n');
			const feedback = await runGenerationProcess(plugin, view.editor, providerId, subdeck, activeInstrText);
			if (feedback) {
				const history = appendFeedbackToCache(plugin, ctx.sourcePath, feedback);
				renderFeedback(el, history, plugin, ctx.sourcePath, undefined, undefined, undefined, null, false);
			}
		};
	});

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

			const provider = resolveProvider(plugin.settings);

			if (!provider) { new Notice("Kein KI-Modell konfiguriert."); return; }

            // Combine active instructions
            const activeInstrText = instructions.filter(i => i.isActive).map(i => i.text).join('\n');
			const feedback = await runGenerationProcess(plugin, view.editor, provider, subdeck, activeInstrText);
			if (feedback) {
				const history: ChatMessage[] = [{ role: 'ai', content: feedback }];
				if (ctx.sourcePath) plugin.feedbackCache.set(ctx.sourcePath, history);
				renderFeedback(el, history, plugin, ctx.sourcePath, undefined, undefined, undefined, null, false);
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
            const activeInstrText = instructions.filter(i => i.isActive).map(i => i.text).join('\n');
			const prompt = constructPrompt(preparedContent, existingCardsText, plugin.settings, activeInstrText || "", false, file.basename);

			// Open Manual Modal
			new ManualGenerationModal(plugin.app, prompt, async (manualResponse) => {
				if (!manualResponse) return;

				// Process Response (similar to generationManager)
				const cleanedResponse = cleanAiGeneratedText(manualResponse);
				
				// Re-read file to get latest content
				const currentFileContent = await plugin.app.vault.read(file);
				
				// Find the block. We look for the block that contains the exact source text.
				const matches = getAnkiBlockMatches(currentFileContent);
				const match = matches.find(m => m[1].trim() === source.trim());

				if (match) {
					const fullBlock = match[0];
					const blockContent = match[1];
					
					// Append new cards
					const newBlockContent = `${blockContent.trim()}\n\n${cleanedResponse.trim()}\n`;
					const newBlock = buildFullBlock(match.block, newBlockContent.trimEnd());
					
					const newFileContent = spliceBlock(currentFileContent, match.block, newBlock);
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
						new CardPreviewModal(plugin, newCards, currentDeckName, ctx.sourcePath, onSave, activeInstrText || undefined).open();
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
        const activeInstrText = instructions.filter(i => i.isActive).map(i => i.text).join('\n');
		new CardPreviewModal(plugin, cardsForModal, currentDeckName, ctx.sourcePath, onSave, activeInstrText || undefined).open();
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
					const matches = getAnkiBlockMatches(content);
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
                        const newBlock = buildFullBlock(match.block, blockContent.trimEnd());
                        
                        // Replace in file
                        const updatedContent = spliceBlock(content, match.block, newBlock);
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
        
			const activeInstrText = instructions.filter(i => i.isActive).map(i => i.text).join('\n');
			
			// Use RevisionInputModal
			new RevisionInputModal(plugin.app, async (instruction) => {
				let subdeck = "";
				if (deckName && deckName.startsWith(plugin.settings.mainDeck + "::")) {
					subdeck = deckName.substring(plugin.settings.mainDeck.length + 2);
				}
	
				const provider = resolveProvider(plugin.settings);
	
				if (!provider) { new Notice("Kein KI-Modell konfiguriert."); return; }
	
				// Construct a revision-specific instruction
				const revisionInstruction = instruction; // Instruction from modal
	
				const feedback = await runGenerationProcess(plugin, view.editor, provider, subdeck, revisionInstruction, true); // isRevision = true
				if (feedback) {
					const history = appendFeedbackToCache(plugin, ctx.sourcePath, feedback);
					renderFeedback(el, history, plugin, ctx.sourcePath, undefined, undefined, undefined, null, false);
				}
			}, activeInstrText, "Karten überarbeiten (Anweisung)").open();
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
        }, undefined, undefined, null, false);
	};

	const cachedHistory = plugin.feedbackCache.get(ctx.sourcePath);
	if (cachedHistory) {
		// console.log("Found cached feedback history for", ctx.sourcePath, "rendering it.");
		renderFeedback(el, cachedHistory, plugin, ctx.sourcePath, () => {
             plugin.activateFeedbackView(cachedHistory, ctx.sourcePath || "");
        }, undefined, undefined, null, false);
	}
}

async function updateInstructionInBlock(plugin: AnkiGeneratorPlugin, sourcePath: string, blockSource: string, oldLine: string, newLine: string) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (file instanceof TFile) {
        const content = await plugin.app.vault.read(file);
        // Find block
        const matches = getAnkiBlockMatches(content);
        const match = matches.find(m => m[1].trim() === blockSource.trim());

        if (match) {
            const fullBlock = match[0];
            // Safe replace: escaping regex special chars in oldLine is hard used in string replace. 
			// String replace only replaces first occurrence if string provided. That is sufficient here usually.
			// But to be safer, let's use list filtering/mapping.
            const lines = match[1].split('\n');
			const newLines = lines.map(l => l.trim() === oldLine.trim() ? newLine : l);
			const newBlockContent = newLines.join('\n');
            const newBlock = buildFullBlock(match.block, newBlockContent.trimEnd());
            const newContent = spliceBlock(content, match.block, newBlock);
            await plugin.app.vault.modify(file, newContent);
        } else {
             new Notice("Konnte den Block nicht finden.");
        }
    }
}

async function addInstructionToBlock(plugin: AnkiGeneratorPlugin, sourcePath: string, blockSource: string, instructionLine: string) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (file instanceof TFile) {
        const content = await plugin.app.vault.read(file);
        const matches = getAnkiBlockMatches(content);
        const match = matches.find(m => m[1].trim() === blockSource.trim());

        if (match) {
             const fullBlock = match[0];
             let blockContent = match[1];
             const lines = blockContent.split('\n');
             
             let insertIndex = -1;
             // Append after last instruction
             for(let i = lines.length - 1; i >= 0; i--) {
                 if (lines[i].trim().startsWith('INSTRUCTION:') || lines[i].trim().startsWith('# INSTRUCTION:')) {
                     insertIndex = i + 1;
                     break;
                 }
             }
             // If no instruction, after Target Deck
             if (insertIndex === -1) {
                  const deckIdx = lines.findIndex(l => l.trim().startsWith('TARGET DECK:'));
                  insertIndex = deckIdx !== -1 ? deckIdx + 1 : 0;
             }
             
             lines.splice(insertIndex, 0, instructionLine);
             const newBlockContent = lines.join('\n');
             const newBlockReconstructed = buildFullBlock(match.block, newBlockContent.trimEnd());
             const newContent = spliceBlock(content, match.block, newBlockReconstructed);
             await plugin.app.vault.modify(file, newContent);
        }
    }
}

async function deleteInstructionFromBlock(plugin: AnkiGeneratorPlugin, sourcePath: string, blockSource: string, lineToDelete: string) {
     const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (file instanceof TFile) {
        const content = await plugin.app.vault.read(file);
        const matches = getAnkiBlockMatches(content);
        const match = matches.find(m => m[1].trim() === blockSource.trim());

        if (match) {
            const fullBlock = match[0];
             const lines = match[1].split('\n');
             const newLines = lines.filter(l => l.trim() !== lineToDelete.trim());
             const newBlockContent = newLines.join('\n');
             
             const newBlock = buildFullBlock(match.block, newBlockContent.trimEnd());
             const newContent = spliceBlock(content, match.block, newBlock);
             await plugin.app.vault.modify(file, newContent);
        }
    }
}





export async function getAllCardsForFile(app: ObsidianApp, file: TFile): Promise<{ cards: Card[], deckName: string | null }> {
    try {
        const content = await app.vault.read(file);
        const blockRegex = /^```anki-cards\s*\n([\s\S]*?)\n^```$/gm;
        const matches = getAnkiBlockMatches(content);
        
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

        const provider = resolveProvider(plugin.settings);

        if (!provider) { new Notice("Kein KI-Modell konfiguriert."); return; }

        // Construct a revision-specific instruction
        const revisionInstruction = instruction; // Instruction from modal

        const feedback = await runGenerationProcess(plugin, editor, provider, subdeck, revisionInstruction, true); // isRevision = true
        if (feedback) {
            const history = appendFeedbackToCache(plugin, sourcePath, feedback);
            onFeedback(history);
        }
    }, "", "Karten überarbeiten").open();
}

// Fügt den generierten Text korrekt in den Block ein
function insertGeneratedText(editor: Editor, blockStartIndex: number, insertionPoint: CodeMirror.Position, generatedText: string) {
    editor.replaceRange(generatedText, insertionPoint);
}

export async function updateFirstBlockDeck(app: ObsidianApp, file: TFile, newDeckName: string) {
    let changed = false;

    // vault.process ist atomar: lesen und schreiben koennen nicht auseinanderlaufen.
    await app.vault.process(file, (content) => {
        const blocks = getAnkiBlocks(content);
        if (blocks.length === 0) return content;

        const block = blocks[0];
        let blockContent = block.innerClean;

        if (/^TARGET DECK[ 	]*:/im.test(blockContent)) {
            blockContent = blockContent.replace(/^TARGET DECK[ 	]*:.*$/im, "TARGET DECK: " + newDeckName);
        } else {
            blockContent = "TARGET DECK: " + newDeckName + "\n" + blockContent;
        }

        changed = true;
        return spliceBlock(content, block, buildFullBlock(block, blockContent.trimEnd()));
    });

    if (changed) {
        new Notice(`Deck geändert zu: ${newDeckName}`);
    } else {
        new Notice("Konnte keinen Anki-Block finden.");
    }
}



