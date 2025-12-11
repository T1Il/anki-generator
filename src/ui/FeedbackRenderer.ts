import { MarkdownRenderer, ButtonComponent, TextAreaComponent, Notice, setIcon, MarkdownView, App } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ChatMessage } from '../types';
import { generateChatResponse, generateFeedbackOnly } from '../aiGenerator';

export async function renderFeedback(
    container: HTMLElement, 
    history: ChatMessage[], 
    plugin: AnkiGeneratorPlugin, 
    sourcePath: string | undefined, 
    onOpenInAction?: () => void
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
}
