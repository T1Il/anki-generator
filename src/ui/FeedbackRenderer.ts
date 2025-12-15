import { MarkdownRenderer, ButtonComponent, TextAreaComponent, Notice, setIcon, MarkdownView, App, TFile, Setting } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ChatMessage, CardPreviewState } from '../types';
import { generateChatResponse, generateFeedbackOnly } from '../aiGenerator';
import { parseCardsFromBlockSource, ANKI_BLOCK_REGEX } from '../anki/ankiParser';
import { CardEditModal } from './CardEditModal';
import { saveAnkiBlockChanges } from '../anki/syncManager';

export async function renderFeedback(
    container: HTMLElement, 
    history: ChatMessage[], 
    plugin: AnkiGeneratorPlugin, 
    sourcePath: string | undefined, 
    onOpenInAction?: () => void,
    state?: CardPreviewState
) {
	const existingBox = container.querySelector('.anki-feedback-box');
	if (existingBox) existingBox.remove();

	const feedbackBox = container.createDiv({ cls: 'anki-feedback-box' });

	// Styling for persistence and visibility
	feedbackBox.style.border = '1px solid #4a90e2';
	feedbackBox.style.borderRadius = '5px';
	feedbackBox.style.padding = '10px';
	feedbackBox.style.marginTop = '10px';
	feedbackBox.style.backgroundColor = 'rgba(74, 144, 226, 0.1)';
    // Resize capability
    feedbackBox.style.resize = 'vertical';
    feedbackBox.style.overflow = 'auto';
    feedbackBox.style.minHeight = '200px';

	const header = feedbackBox.createDiv({ cls: 'anki-feedback-header' });
	header.style.display = 'flex';
	header.style.justifyContent = 'space-between';
	header.style.alignItems = 'center';
	header.style.marginBottom = '10px';
	header.style.marginBottom = '10px';

	header.createSpan({ text: '🤖 KI Chat & Feedback', cls: 'anki-feedback-title' }).style.fontWeight = 'bold';

	const controlsDiv = header.createDiv({ cls: 'anki-feedback-controls' });
	controlsDiv.style.display = 'flex';
	controlsDiv.style.gap = '5px';

    // Open in New Tab Button (only if callback provided)
    if (onOpenInAction) {
        const openBtn = controlsDiv.createEl('button', { cls: 'anki-feedback-action' });
        openBtn.title = "In neuem Tab öffnen";
        setIcon(openBtn, 'external-link'); // or 'monitor-play' or 'layout-sidebar-right'
        openBtn.onclick = onOpenInAction;
    }

	const clearBtn = controlsDiv.createEl('button', { cls: 'anki-feedback-close' });
	clearBtn.title = "Chat leeren";
	setIcon(clearBtn, 'trash');
	clearBtn.onclick = () => {
		history.length = 0; // Clear array
		if (sourcePath) plugin.feedbackCache.delete(sourcePath);
		renderFeedback(container, history, plugin, sourcePath, onOpenInAction);
	};

	const closeBtn = controlsDiv.createEl('button', { cls: 'anki-feedback-close' });
	closeBtn.title = "Schließen";
	setIcon(closeBtn, 'x');
	closeBtn.onclick = () => {
		feedbackBox.remove();
	};

	const contentArea = feedbackBox.createDiv({ cls: 'anki-feedback-content' });
	contentArea.style.maxHeight = '600px'; // Increased height
    contentArea.style.minHeight = '150px';
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
        /* Quote Styling for Click-to-Edit */
        .anki-feedback-content blockquote {
            cursor: pointer;
            border-left: 4px solid #4a90e2;
            padding-left: 10px;
            margin-left: 0;
            background-color: rgba(255, 255, 255, 0.1);
            transition: background-color 0.2s;
            position: relative;
        }
        .anki-feedback-content blockquote:hover {
            background-color: rgba(74, 144, 226, 0.2);
        }
        .anki-feedback-content blockquote::after {
            content: "✏️";
            position: absolute;
            right: 5px;
            top: 5px;
            font-size: 0.8em;
            opacity: 0.5;
        }
        .anki-feedback-content blockquote:hover::after {
            opacity: 1;
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
		history.forEach(async msg => {
			const msgDiv = contentArea.createDiv({ cls: `anki-chat-message ${msg.role}` });
			msgDiv.style.marginBottom = '8px';
			msgDiv.style.padding = '8px';
			msgDiv.style.borderRadius = '5px';
			msgDiv.style.backgroundColor = msg.role === 'ai' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(74, 144, 226, 0.2)';
			msgDiv.style.alignSelf = msg.role === 'ai' ? 'flex-start' : 'flex-end';
            msgDiv.style.width = '100%'; // Ensure full width usage

			const roleLabel = msgDiv.createDiv({ cls: 'anki-chat-role' });
			roleLabel.setText(msg.role === 'ai' ? '🤖 AI:' : '👤 Du:');
			roleLabel.style.fontWeight = 'bold';
			roleLabel.style.fontSize = '0.8em';
			roleLabel.style.marginBottom = '4px';

			const textDiv = msgDiv.createDiv({ cls: 'anki-chat-text' });
			await MarkdownRenderer.render(plugin.app, msg.content, textDiv, sourcePath || '', plugin);

            // --- CLICK-TO-EDIT LOGIC ---
            if (msg.role === 'ai') {
                // Select both standard blockquotes and callouts
                const quoteElements = textDiv.querySelectorAll('blockquote, .callout');
                
                // EXTRACT RAW QUOTES FROM SOURCE (msg.content)
                const rawQuotes: string[] = [];
                const lines = msg.content.split('\n');
                let currentQuote: string[] = [];
                let inQuote = false;

                for (const line of lines) {
                    if (line.trim().startsWith('>')) {
                        inQuote = true;
                        // Remove the leading '>' and space. 
                        const cleanLine = line.replace(/^\s*>\s?/, ''); 
                        currentQuote.push(cleanLine);
                    } else {
                        if (inQuote) {
                            // Quote ended
                            if (currentQuote.length > 0) {
                                rawQuotes.push(currentQuote.join('\n'));
                                currentQuote = [];
                            }
                            inQuote = false;
                        }
                    }
                }
                // Flush last quote if message ends with one
                if (inQuote && currentQuote.length > 0) {
                     rawQuotes.push(currentQuote.join('\n'));
                }

                // Map DOM elements to raw quotes by index
                // Note: This relies on the assumption that markdown 'blocks' starting with > 
                // match 1:1 with rendered blockquotes/callouts.
                quoteElements.forEach((el, index) => {
                    // Type assertion for title property
                    (el as HTMLElement).title = "Klicken, um Textstelle im Editor zu suchen";
                    
                    // Assign raw content if available (fallback to textContent if mismatch)
                    const rawContent = rawQuotes[index] ? rawQuotes[index].trim() : el.textContent?.trim() || "";

                    el.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault(); // Prevent default callout folding if applicable
                        
                        // Clean the quote from AI artifacts like [...] or (omitted)
                        const cleanQuote = (text: string) => {
                            return text
                                .replace(/\[\.\.\.\]/g, ' ') // Replace [...] with space
                                .replace(/\(omitted\)/g, ' ')
                                .replace(/^\s*[\.\u2026]+\s*/, '') // Leading ellipses
                                .replace(/\s*[\.\u2026]+\s*$/, '') // Trailing ellipses
                                .trim();
                        };

                        const searchText = cleanQuote(rawContent);

                        if (searchText) {
                            // Find correct view
                            let view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                            if (sourcePath) {
                                const leaves = plugin.app.workspace.getLeavesOfType('markdown');
                                const matchingLeaf = leaves.find(l => (l.view as MarkdownView).file?.path === sourcePath);
                                if (matchingLeaf) view = matchingLeaf.view as MarkdownView;
                            }

                            if (view) {
                                const editor = view.editor;
                                const content = editor.getValue();
                                
                                console.log("AnkiGenerator: Searching for:", searchText);

                                // Helper to find index
                                const findIndex = (text: string, query: string): number => {
                                    if (!query) return -1;
                                    
                                    // 1. Exact match
                                    let idx = text.indexOf(query);
                                    if (idx !== -1) return idx;

                                    // 2. Normalized match (ignore whitespace diffs AND blockquote markers >)
                                    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                    // Replace whitespace in query with a pattern matching whitespace OR > characters (for multiline quotes)
                                    const pattern = escapeRegExp(query).replace(/\s+/g, '[\\s>]+');
                                    try {
                                        const regex = new RegExp(pattern);
                                        const match = text.match(regex);
                                        if (match && match.index !== undefined) return match.index;
                                    } catch (e) { console.error("Regex error:", e); }

                                    // 3. Fallback: Search for the first significant part (e.g. first 50 chars)
                                    // This helps if the AI hallucinated the end of the sentence or formatting
                                    if (query.length > 50) {
                                        const stub = query.substring(0, 50);
                                        console.log("AnkiGenerator: Trying stub search:", stub);
                                        const stubIdx = text.indexOf(stub);
                                        if (stubIdx !== -1) return stubIdx;
                                        
                                        // Normalized stub with > support
                                        const stubPattern = escapeRegExp(stub).replace(/\s+/g, '[\\s>]+');
                                        try {
                                            const match = text.match(new RegExp(stubPattern));
                                            if (match && match.index !== undefined) return match.index;
                                        } catch (e) {}
                                    }

                                    return -1;
                                };

                                const idx = findIndex(content, searchText);

                                if (idx !== -1) {
                                    const pos = editor.offsetToPos(idx);
                                    const endPos = editor.offsetToPos(Math.min(content.length, idx + searchText.length));
                                    
                                    editor.setCursor(pos);
                                    editor.scrollIntoView({ from: pos, to: endPos }, true);
                                    editor.setSelection(pos, endPos);
                                    new Notice("Textstelle gefunden!");
                                } else {
                                    new Notice("Textstelle nicht gefunden. (Details in Konsole)");
                                    console.warn("AnkiGenerator: Could not find quote in document.");
                                    console.log("Search Text:", searchText);
                                }
                            } else {
                                new Notice("Editor nicht gefunden.");
                            }
                        }
                    });
                });
            }
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
		renderFeedback(container, history, plugin, sourcePath, onOpenInAction);

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
			if (sourcePath) {
                plugin.feedbackCache.set(sourcePath, history);
                // Trigger Sync
                plugin.app.workspace.trigger('anki:chat-update', sourcePath, history);
            }

			renderFeedback(container, history, plugin, sourcePath, onOpenInAction);

		} catch (e: any) {
			new Notice("Fehler bei der Antwort: " + e.message);
			history.push({ role: 'ai', content: "Fehler: " + e.message });
			renderFeedback(container, history, plugin, sourcePath, onOpenInAction);
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
			// Find the correct view based on sourcePath
			let view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
            
            // If we have a sourcePath, try to find the specific leaf for it
            if (sourcePath) {
                 const leaves = plugin.app.workspace.getLeavesOfType('markdown');
                 const matchingLeaf = leaves.find(l => (l.view as MarkdownView).file?.path === sourcePath);
                 if (matchingLeaf) {
                     view = matchingLeaf.view as MarkdownView;
                 } else {
                     console.log("AnkiGenerator Debug: No matching leaf found for sourcePath:", sourcePath);
                     console.log("Open leaves:", leaves.map(l => (l.view as MarkdownView).file?.path));
                 }
            } else {
                console.log("AnkiGenerator Debug: sourcePath is undefined in renderFeedback.");
            }

			if (!view) { new Notice("Konnte die zugehörige Notiz nicht finden (ist sie geöffnet?)."); return; }
			const noteContent = view.editor.getValue();

			let provider: 'gemini' | 'openai' | 'ollama' = 'gemini';
			if (plugin.settings.geminiApiKey) provider = 'gemini';
			else if (plugin.settings.openAiApiKey) provider = 'openai';
			else if (plugin.settings.ollamaEnabled) provider = 'ollama';

			const feedback = await generateFeedbackOnly(plugin.app, noteContent, provider, plugin.settings);

			if (feedback) {
				history.push({ role: 'ai', content: feedback });
				if (sourcePath) plugin.feedbackCache.set(sourcePath, history);
				renderFeedback(container, history, plugin, sourcePath, onOpenInAction);
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

    // --- CARD PREVIEW SECTION ---
    if (sourcePath && state) {
        // Create a wrapper for the preview section to isolate re-renders if needed
        const previewWrapper = container.createDiv({ cls: 'anki-preview-wrapper' });
        await renderCardPreviewSection(previewWrapper, sourcePath, plugin, state);
    }
}

async function renderCardPreviewSection(container: HTMLElement, sourcePath: string, plugin: AnkiGeneratorPlugin, state: CardPreviewState) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    try {
        const content = await plugin.app.vault.read(file);
        
        // Use imported regex (needs import) or just match locally for now to avoid circular deps if possible,
        // but we should reuse parser.
        
        const matches = [...content.matchAll(ANKI_BLOCK_REGEX as RegExp)];
        if (matches.length === 0) return;

        const lastMatch = matches[matches.length - 1];
        const blockContent = lastMatch[1];
        const cards = parseCardsFromBlockSource(blockContent);

        if (cards.length === 0) return;

        container.empty();
        const previewContainer = container.createDiv({ cls: 'anki-sidebar-preview' });
        previewContainer.style.marginTop = '20px';
        previewContainer.style.paddingTop = '10px';
        previewContainer.style.borderTop = '1px solid var(--background-modifier-border)';

        // --- STYLES (Scoped to sidebar preview) ---
        // (Moved styles to CSS file ideally, but keeping inline for now as per request)
        const styleEl = previewContainer.createEl('style');
        styleEl.textContent = `
            .anki-sidebar-controls {
                margin-bottom: 10px;
                background: var(--background-secondary);
                padding: 8px;
                border-radius: 5px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .anki-control-row {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .anki-sidebar-card {
                border: 1px solid var(--background-modifier-border);
                border-radius: 8px;
                margin-bottom: 12px; /* Increased margin */
                background-color: var(--background-primary);
                overflow: hidden;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1); /* Added shadow for separation */
            }
            .anki-sidebar-card-header {
                padding: 10px 12px; /* Increased padding */
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background-color: var(--background-secondary);
                transition: background-color 0.2s;
            }
            .anki-sidebar-card-header:hover {
                background-color: var(--background-modifier-hover);
            }
            .anki-sidebar-card-body {
                padding: 12px;
                border-top: 1px solid var(--background-modifier-border);
                background-color: var(--background-primary);
            }
            .anki-sidebar-q {
                font-weight: 600;
                color: var(--text-normal);
                margin-bottom: 4px;
                font-size: 0.95em;
            }
            .anki-sidebar-a {
                color: var(--text-muted);
                font-size: 0.95em;
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px dashed var(--background-modifier-border);
            }
            .anki-sidebar-meta {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 0.8em;
                flex-shrink: 0; /* Prevent checking/type from shrinking */
            }
            .anki-type-badge {
                padding: 1px 5px;
                border-radius: 3px;
                font-weight: bold;
                text-transform: uppercase;
                font-size: 0.7em;
            }
            .anki-arrow {
                transition: transform 0.2s;
                opacity: 0.6;
            }
            .anki-collapsed .anki-arrow {
                transform: rotate(-90deg);
            }
            .anki-card-actions {
                display: flex;
                gap: 5px;
                margin-top: 8px;
                justify-content: flex-end;
            }
            .anki-card-title-preview {
                flex-grow: 1;
                margin-left: 10px;
                font-weight: 500;
                font-size: 0.9em;
                line-height: 1.3;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
                color: var(--text-normal);
            }
            /* Highlight/Link stripping style if needed, but we rely on text stripping */
        `;

        // TITLE & COUNT
        const headerRow = previewContainer.createDiv({ cls: 'anki-sidebar-header-row' });
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';
        
        const h4 = headerRow.createEl('h4', { text: `📝 Fragen (${cards.length})` });
        h4.style.margin = '0';
        
        // CONTROLS
        const controlsDiv = previewContainer.createDiv({ cls: 'anki-sidebar-controls' });
        
        // Row 1: Search
        const searchRow = controlsDiv.createDiv({ cls: 'anki-control-row' });
        const searchEl = searchRow.createEl('input', { type: 'text', placeholder: '🔍 Suchen...' });
        searchEl.value = state.searchQuery;
        searchEl.style.width = '100%'; // Full width
        searchEl.oninput = () => {
             state.searchQuery = searchEl.value.toLowerCase();
             // Re-render
             renderCardPreviewSection(container, sourcePath, plugin, state);
        };

        // Row 2: Sort + Expand/Collapse
        const actionRow = controlsDiv.createDiv({ cls: 'anki-control-row' });
        actionRow.style.justifyContent = 'space-between'; // Spread them out

        // Sort
        const sortSelect = actionRow.createEl('select');
        sortSelect.style.maxWidth = '120px'; // Slightly wider
        const sortOpts = [
            {val: 'default', text: 'Standard'}, // Renamed from Std.
            {val: 'type', text: 'Nach Typ'},
            {val: 'question', text: 'A-Z'}
        ];
        sortOpts.forEach(o => {
            const opt = sortSelect.createEl('option', {text: o.text, value: o.val});
            if (state.sortOrder === o.val) opt.selected = true;
        });
        sortSelect.onchange = () => {
            state.sortOrder = sortSelect.value as any;
             renderCardPreviewSection(container, sourcePath, plugin, state);
        };

        // Expand/Collapse
        const toggleAllBtn = new ButtonComponent(actionRow);
        toggleAllBtn.setButtonText(state.isAllExpanded ? "🔼 Alle einklappen" : "🔽 Alle ausklappen");
        toggleAllBtn.buttonEl.style.flex = '1'; // Take remaining space or share?
        toggleAllBtn.onClick(() => {
            state.isAllExpanded = !state.isAllExpanded;
            if (state.isAllExpanded) {
                cards.forEach((_, i) => state.expandedIndices.add(i));
            } else {
                state.expandedIndices.clear();
            }
            renderCardPreviewSection(container, sourcePath, plugin, state);
        });

        const cardsDiv = previewContainer.createDiv({ cls: 'anki-sidebar-cards' });
        cardsDiv.style.maxHeight = '500px';
        cardsDiv.style.overflowY = 'auto';

        // FILTER & SORT LOGIC
        let displayCards = cards.map((c, i) => ({ card: c, originalIndex: i }));
        
        // Search Filter
        if (state.searchQuery) {
            const q = state.searchQuery;
            displayCards = displayCards.filter(item => 
                item.card.q.toLowerCase().includes(q) || item.card.a.toLowerCase().includes(q)
            );
        }

        // Sort
        if (state.sortOrder === 'question') {
            displayCards.sort((a, b) => a.card.q.localeCompare(b.card.q));
        } else if (state.sortOrder === 'type') {
            displayCards.sort((a, b) => {
                const tA = a.card.typeIn ? 'Type-In' : a.card.type;
                const tB = b.card.typeIn ? 'Type-In' : b.card.type;
                return tA.localeCompare(tB);
            });
        }

        if (displayCards.length === 0) {
            const msg = cardsDiv.createDiv({ text: "Keine Karten gefunden." });
            msg.style.padding = "10px";
            msg.style.color = "#888";
        }

        for (const item of displayCards) {
            const { card, originalIndex } = item;
            const isExpanded = state.expandedIndices.has(originalIndex);
            
            const cardEl = cardsDiv.createDiv({ cls: `anki-sidebar-card ${isExpanded ? '' : 'anki-collapsed'}` });

            // HEADER
            const header = cardEl.createDiv({ cls: 'anki-sidebar-card-header' });
            
            // Meta (Arrow + Type)
            const metaDiv = header.createDiv({ cls: 'anki-sidebar-meta' });
            const arrow = metaDiv.createSpan({ cls: 'anki-arrow', text: '🔽' }); 
            if (!isExpanded) arrow.style.transform = 'rotate(-90deg)';
             
            // Type Badge Colors
            let typeColor = '#3498db'; 
            let typeBg = 'rgba(52, 152, 219, 0.15)';
            let typeText = 'Basic';
            if (card.type === 'Cloze') { 
                typeColor = '#9b59b6'; typeBg = 'rgba(155, 89, 182, 0.15)'; typeText = 'Lücke';
            } else if (card.typeIn) {
                typeColor = '#d4af37'; typeBg = 'rgba(212, 175, 55, 0.15)'; typeText = 'Type';
            }

            const badge = metaDiv.createSpan({ cls: 'anki-type-badge', text: typeText });
            badge.style.color = typeColor;
            badge.style.backgroundColor = typeBg;

            // Short Question Preview in Header
            const titlePreview = header.createDiv({ cls: 'anki-card-title-preview' });
            
            // Link Stripping Logic:
            // 1. Replace [[Target|Alias]] with Alias
            // 2. Replace [[Target]] with Target
            // 3. Replace [Text](Target) with Text
            // 4. Remove Bold/Italic chars (*, _)
            let rawQ = card.q;
            
            // [[Target|Alias]] -> Alias
            rawQ = rawQ.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1');
            // [[Target]] -> Target
            rawQ = rawQ.replace(/\[\[([^\]]+)\]\]/g, '$1');
            // [Text](Url) -> Text
            rawQ = rawQ.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
            // Render Title with Markdown to support LaTeX
            // We need to strip block-level styling from the rendered markdown
            titlePreview.empty();
            
            // 1. Get first line of question
            let previewText = card.q.split('\n')[0]; 

            // 2. Strip standard Markdown links [text](url) -> text
            previewText = previewText.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

            // 3. Strip Obsidian/Wiki links [[target|alias]] or [[target]] -> alias/target
            // We do this so that LaTeX inside the alias is rendered as plain LaTeX, not inside an <a> tag
            // which can break MathJax rendering in some contexts.
            previewText = previewText.replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1');

            // 4. Render (DO NOT TRUNCATE MANUALLY - Let CSS handle it)
            await MarkdownRenderer.render(plugin.app, previewText, titlePreview, sourcePath, plugin);
            
            // Force inline styling for the rendered paragraph
            const p = titlePreview.querySelector('p');
            if (p) {
                p.style.margin = '0';
                p.style.display = 'inline-block';
            }

            // TOGGLE CLICK
            header.onclick = (e) => {
                // Ignore clicks on internal links within the header to prevent unwanted navigation/expansion conflict?
                // Actually header toggle is fine, but if user clicks a link in header, maybe they want to navigate?
                // For now, let's keep simple toggle.
                
                // Prevent toggle if clicking a link?
                if ((e.target as HTMLElement).tagName === 'A' || (e.target as HTMLElement).hasClass('internal-link')) {
                    return; 
                }
                
                if (state.expandedIndices.has(originalIndex)) {
            // ... (Rest of logic is same, implied by tool)
                    state.expandedIndices.delete(originalIndex);
                    arrow.style.transform = 'rotate(-90deg)';
                    body.style.display = 'none';
                    cardEl.addClass('anki-collapsed');
                } else {
                    state.expandedIndices.add(originalIndex);
                    arrow.style.transform = 'rotate(0deg)';
                    body.style.display = 'block';
                    cardEl.removeClass('anki-collapsed');
                }
            };

            // BODY
            const body = cardEl.createDiv({ cls: 'anki-sidebar-card-body' });
            if (!isExpanded) body.style.display = 'none';

            // Full Q & A
            const qDiv = body.createDiv({ cls: 'anki-sidebar-q' });
             await MarkdownRenderer.render(plugin.app, card.q, qDiv, sourcePath, plugin);

            const aDiv = body.createDiv({ cls: 'anki-sidebar-a' });
            await MarkdownRenderer.render(plugin.app, card.a, aDiv, sourcePath, plugin);
            
            // ACTIONS
            const actionsDiv = body.createDiv({ cls: 'anki-card-actions' });
            
            const editBtn = new ButtonComponent(actionsDiv);
            editBtn.setIcon('pencil');
            editBtn.setTooltip("Bearbeiten");
            editBtn.onClick(async (e) => {
                e.stopPropagation(); // Avoid Collapse? It's in body, so no collapse.
                new CardEditModal(plugin.app, card, sourcePath, async (updatedCard) => {
                     // Save Logic:
                     // 1. Get current cards (re-parse to be safe or use local list?)
                     // Better re-read file to avoid race conditions but for sidebar manual edit re-using list is OK if we update file immediately.
                     // Helper: Replace card at originalIndex.
                     const newCards = [...cards];
                     newCards[originalIndex] = updatedCard;
                     
                     await saveAnkiBlockChanges(plugin, blockContent, newCards, [], undefined); // deckName undefined = keep exists
                }).open();
            });

            const deleteBtn = new ButtonComponent(actionsDiv);
            deleteBtn.setIcon('trash');
            deleteBtn.setTooltip("Löschen");
            deleteBtn.setClass('delete-btn'); // Style for red color?
            deleteBtn.buttonEl.style.color = 'var(--text-error)';
            deleteBtn.onClick(async (e) => {
                e.stopPropagation();
                if (confirm("Karte wirklich löschen?")) {
                    const deletedId = card.id ? [card.id] : [];
                    const newCards = [...cards];
                    newCards.splice(originalIndex, 1);
                    await saveAnkiBlockChanges(plugin, blockContent, newCards, deletedId, undefined);
                }
            });

        } // End Card Loop

        // --- NAVIGATION CLICK HANDLER ---
        cardsDiv.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const link = target.closest('.internal-link');
            if (link) {
                const href = (link as HTMLElement).dataset.href || (link as HTMLElement).getAttribute('href');
                if (href) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log("AnkiSidebar: Navigating to", href);
                    plugin.app.workspace.openLinkText(href, sourcePath, false);
                }
            }
        });

    } catch (e) {
        console.error("Error rendering sidebar preview:", e);
    }
}
