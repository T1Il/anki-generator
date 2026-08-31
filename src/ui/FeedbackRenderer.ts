import { MarkdownRenderer, ButtonComponent, TextAreaComponent, Notice, setIcon, MarkdownView, App, TFile, Setting } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { ChatMessage, CardPreviewState, Card } from '../types';
import { generateChatResponse, generateFeedbackOnly } from '../aiGenerator';
import { parseCardsFromBlockSource, ANKI_BLOCK_REGEX, getAnkiBlockMatches } from '../anki/ankiParser';
import { CardEditModal } from './CardEditModal';
import { saveAnkiBlockChanges, syncAnkiBlock } from '../anki/syncManager';
// constructPrompt is likely not exported or named differently in generationManager. Checking that file first would be wise, but I will assume it's there or I need to import it properly.
// Assuming constructPrompt IS exported based on previous usage in ankiBlockProcessor.
import { runGenerationProcess, extractImagesAndPrepareContent, cleanAiGeneratedText } from '../generationManager';
import { constructPrompt } from '../aiGenerator';
import { ManualGenerationModal } from './ManualGenerationModal';
import { CardPreviewModal } from './CardPreviewModal';
// Fixing missing imports - assuming they are in same folder
import { startRevisionProcess, updateFirstBlockDeck } from '../ankiBlockProcessor';
import { DeckSelectionModal } from './DeckSelectionModal';
import { RevisionInputModal } from './RevisionInputModal';
import { getDeckNames, moveAnkiNotesToDeck, getCardCountForDeck, deleteAnkiDeck } from '../anki/AnkiConnect';
import { stripHybridObsidianLinks } from '../utils';
import { resolveProvider } from '../providers';
import { ChatPanel } from './chat/ChatPanel';

export async function renderFeedback(
    container: HTMLElement,
    history: ChatMessage[],
    plugin: AnkiGeneratorPlugin,
    sourcePath: string | undefined,
    onOpenInAction?: () => void,
    state?: CardPreviewState,
    cards?: Card[],
    deckName: string | null = null,
    showControls: boolean = true,
    scrollBehavior: 'preserve' | 'new-message' | 'default' = 'default',
    initialScrollTop?: number
) {
    // scrollBehavior/initialScrollTop bleiben nur der Signatur wegen erhalten:
    // der ChatPanel haelt seine Scrollposition jetzt selbst.

    // Stabile Wrapper: nur so kann der Chat zwischen Renders ueberleben.
    // Frueher wurde bei jeder Nachricht der gesamte Chat-DOM neu gebaut -
    // daher Flackern, Scroll-Spruenge und verlorener Eingabetext.
    // NICHT container.empty(): im Notiz-Block stehen oberhalb die Kopfzeile und
    // die Generieren-Buttons des Block-Prozessors, die sonst mit verschwinden.
    const stale = container.querySelector('.anki-feedback-box');
    if (stale) stale.remove();
    const staleChat = container.querySelector('.anki-chat-section');
    if (staleChat) staleChat.remove();

    let actionsHost = container.querySelector('.anki-actions-host') as HTMLElement | null;
    if (!actionsHost) actionsHost = container.createDiv({ cls: 'anki-actions-host' });

    let chatHost = container.querySelector('.anki-chat-host') as HTMLElement | null;
    if (!chatHost) chatHost = container.createDiv({ cls: 'anki-chat-host' });

    let previewHost = container.querySelector('.anki-preview-host') as HTMLElement | null;
    if (!previewHost) previewHost = container.createDiv({ cls: 'anki-preview-host' });

    // --- SIDEBAR ACTIONS ---
    actionsHost.empty();
    renderSidebarControls(actionsHost, plugin, sourcePath, onOpenInAction, deckName, cards, showControls);

    // --- CHAT ---
    const store = container as unknown as { __ankiChatPanel?: ChatPanel };
    let panel = store.__ankiChatPanel;

    if (panel && panel.path === sourcePath && chatHost.contains(panel.rootEl)) {
        // Gleiche Notiz: nur neue Nachrichten anhaengen.
        panel.syncHistoryRef(history);
    } else {
        // Bewusst nicht plugin.addChild(): der Notiz-Block wird beim Tippen oft
        // neu gerendert, jede Instanz bliebe sonst dauerhaft am Plugin haengen.
        if (panel) panel.unload();
        chatHost.empty();
        panel = new ChatPanel(plugin, chatHost, history, sourcePath, {
            embedded: !showControls,
            onPopOut: onOpenInAction,
            collapsible: true
        });
        panel.load();
        panel.build();
        store.__ankiChatPanel = panel;
    }

    // --- CARD PREVIEW SECTION ---
    previewHost.empty();
    if (sourcePath && state) {
        const previewWrapper = previewHost.createDiv({ cls: 'anki-preview-wrapper' });
        await renderCardPreviewSection(previewWrapper, sourcePath, plugin, state, cards, deckName);
    }
}

async function renderCardPreviewSection(
    container: HTMLElement,
    sourcePath: string,
    plugin: AnkiGeneratorPlugin,
    state: CardPreviewState,
    preloadedCards?: Card[],
    deckName: string | null = null
) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    try {
        const content = await plugin.app.vault.read(file);

        // Use imported regex (needs import) or just match locally for now to avoid circular deps if possible,
        // but we should reuse parser.

        const matches = getAnkiBlockMatches(content);
        if (matches.length === 0) return;

        let cards: Card[] = [];

        if (preloadedCards) {
            cards = preloadedCards;
        } else {
            try {
                const content = await plugin.app.vault.read(file);
                // Use imported regex (needs import) or just match locally for now to avoid circular deps if possible,
                // but we should reuse parser.
                const matches = getAnkiBlockMatches(content);
                if (matches.length > 0) {
                    // Aggregating all cards logic similar to getAllCardsForFile if we want full file preview?
                    // Original logic only took LAST match. 
                    // If we want consistency with getAllCardsForFile, we should probably loop all matches.
                    // However, "renderCardPreviewSection" originally only took last match?
                    // Let's look at original code:
                    // "const lastMatch = matches[matches.length - 1]; ... const cards = parseCardsFromBlockSource(blockContent);"
                    // If the new external logic provides ALL cards, and this old logic provided LAST block, checking strictly might be issue.
                    // But for "Sidebar" we likely want ALL cards in file.
                    // Let's stick to using preloadedCards if available.
                    // If not, we fall back to existing behavior (Last Block) for safety, OR upgrade to all blocks.
                    // Let's upgrade to all blocks to match "Auto-Update" goal which likely implies full file context.

                    // Fallback to original behavior if no preloaded:
                    const lastMatch = matches[matches.length - 1];
                    const blockContent = lastMatch[1];
                    cards = parseCardsFromBlockSource(blockContent);
                }
            } catch (e) {
                console.error("Error reading file for preview:", e);
            }
        }

        if (cards.length === 0) return;

        if (cards.length === 0) return;

        // Ensure state defaults
        if (state.isQuestionsOpen === undefined) state.isQuestionsOpen = true;

        let previewContainer = container.querySelector('.anki-sidebar-preview') as HTMLElement;
        let cardsDiv: HTMLElement;

        if (!previewContainer) {
            container.empty();
            previewContainer = container.createDiv({ cls: 'anki-sidebar-preview' });
            previewContainer.style.marginTop = '20px';
            previewContainer.style.paddingTop = '10px';
            previewContainer.style.borderTop = '1px solid var(--background-modifier-border)';

            // --- STYLES (Scoped to sidebar preview) ---
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
                    margin-bottom: 12px;
                    background-color: var(--background-primary);
                    overflow: hidden;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }
                .anki-sidebar-card-header {
                    padding: 10px 12px;
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
                /* Removing sidebar-styles injection here to avoid duplication if we move it up, 
                   but for safety let's leave card-specific styles. */
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
                    flex-shrink: 0;
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
                .anki-sidebar-section-arrow {
                     transition: transform 0.2s;
                     margin-right: 5px;
                     cursor: pointer;
                }
                .anki-sidebar-section-collapsed .anki-sidebar-section-arrow {
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
            `;

            // TITLE & COUNT
            const headerRow = previewContainer.createDiv({ cls: 'anki-sidebar-header-row' });
            headerRow.style.display = 'flex';
            headerRow.style.alignItems = 'center';
            headerRow.style.cursor = 'pointer';
            headerRow.style.marginBottom = '10px';

            if (!state.isQuestionsOpen) {
                headerRow.addClass('anki-sidebar-section-collapsed');
            }

            const sectionArrow = headerRow.createSpan({ cls: 'anki-sidebar-section-arrow', text: '🔽' });
            const h4 = headerRow.createEl('h4', { text: `📝 Fragen (${cards.length})` });
            h4.style.margin = '0';

            // Toggle Logic
            headerRow.onclick = () => {
                state.isQuestionsOpen = !state.isQuestionsOpen;
                // Re-render
                renderCardPreviewSection(container, sourcePath, plugin, state, cards, deckName);
            };

            // CONTROLS
            const controlsDiv = previewContainer.createDiv({ cls: 'anki-sidebar-controls' });
            if (!state.isQuestionsOpen) controlsDiv.style.display = 'none';

            // Row 1: Search
            const searchRow = controlsDiv.createDiv({ cls: 'anki-control-row' });
            const searchEl = searchRow.createEl('input', { type: 'text', placeholder: '🔍 Suchen...' });
            searchEl.value = state.searchQuery;
            searchEl.style.width = '100%';
            searchEl.oninput = () => {
                state.searchQuery = searchEl.value.toLowerCase();
                // Re-render only cards (full re-render for simplicity to ensure handlers attached)
                renderCardPreviewSection(container, sourcePath, plugin, state, cards);
            };

            // Row 2: Sort + Expand/Collapse
            const actionRow = controlsDiv.createDiv({ cls: 'anki-control-row' });
            actionRow.style.justifyContent = 'space-between';

            // Sort
            const sortSelect = actionRow.createEl('select');
            sortSelect.style.maxWidth = '130px';
            sortSelect.style.backgroundColor = 'var(--background-primary)';
            sortSelect.style.border = '1px solid var(--background-modifier-border)';
            sortSelect.style.color = 'var(--text-normal)';
            sortSelect.style.padding = '4px 8px';
            sortSelect.style.borderRadius = '4px';
            sortSelect.style.cursor = 'pointer';
            sortSelect.style.fontSize = '0.9em';

            const sortOpts = [
                { val: 'default', text: 'Standard' },
                { val: 'type', text: 'Nach Typ' },
                { val: 'question', text: 'A-Z' }
            ];
            sortOpts.forEach(o => {
                const opt = sortSelect.createEl('option', { text: o.text, value: o.val });
                if (state.sortOrder === o.val) opt.selected = true;
            });
            sortSelect.onchange = () => {
                state.sortOrder = sortSelect.value as any;
                renderCardPreviewSection(container, sourcePath, plugin, state, cards, deckName);
            };

            // Expand/Collapse All
            const toggleAllBtn = new ButtonComponent(actionRow);
            toggleAllBtn.setButtonText(state.isAllExpanded ? "🔼 Alle einklappen" : "🔽 Alle ausklappen");
            toggleAllBtn.buttonEl.style.flex = '1';
            toggleAllBtn.onClick(() => {
                state.isAllExpanded = !state.isAllExpanded;
                if (state.isAllExpanded) {
                    cards.forEach((_, i) => state.expandedIndices.add(i));
                } else {
                    state.expandedIndices.clear();
                }
                // Update button text manually since we don't always re-render shell if reusing elements?
                // Actually we just re-render properly.
                renderCardPreviewSection(container, sourcePath, plugin, state, cards, deckName);
            });

            cardsDiv = previewContainer.createDiv({ cls: 'anki-sidebar-cards' });
            cardsDiv.style.maxHeight = '500px';
            cardsDiv.style.overflowY = 'auto';
            if (!state.isQuestionsOpen) cardsDiv.style.display = 'none';

            // Scroll Persistence
            cardsDiv.onscroll = () => {
                state.questionsScrollTop = cardsDiv.scrollTop;
            };

        } else {
            // Re-using container logic - need to update header and visibility
            // For simplicity in this function design, we often recreated internal parts if not carefully separated.
            // The logic above tries to create the SHELL (controls + card container) only once.
            // But if we toggle "Questions Open", we need to update the arrow and visibility.

            // Update Header Arrow
            const headerRow = previewContainer.querySelector('.anki-sidebar-header-row') as HTMLElement;
            if (headerRow) {
                if (state.isQuestionsOpen) headerRow.removeClass('anki-sidebar-section-collapsed');
                else headerRow.addClass('anki-sidebar-section-collapsed');
            }

            // Update Visibility
            const controlsDiv = previewContainer.querySelector('.anki-sidebar-controls') as HTMLElement;
            if (controlsDiv) controlsDiv.style.display = state.isQuestionsOpen ? 'flex' : 'none';

            cardsDiv = previewContainer.querySelector('.anki-sidebar-cards') as HTMLElement;
            if (cardsDiv) {
                cardsDiv.style.display = state.isQuestionsOpen ? 'block' : 'none';
                cardsDiv.empty(); // Clear cards to re-render them
            } else {
                cardsDiv = previewContainer.createDiv({ cls: 'anki-sidebar-cards' }); // Fallback
            }
        }


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
            let previewText = stripHybridObsidianLinks(card.q.split('\n')[0]);

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

            // Synced Indicator Badge
            if (card.id) {
                const syncedBadge = header.createSpan({ cls: 'anki-card-synced-badge' });
                syncedBadge.innerHTML = '&#10003;'; // Checkmark
                syncedBadge.title = 'Synchronisiert (ID: ' + card.id + ')';
                syncedBadge.style.color = '#2ecc71';
                syncedBadge.style.marginLeft = '8px';
                syncedBadge.style.fontSize = '1.1em';
                syncedBadge.style.fontWeight = 'bold';
            }

            // TOGGLE CLICK
            header.onclick = (e) => {
                // Prevent toggle if clicking a link?
                if ((e.target as HTMLElement).tagName === 'A' || (e.target as HTMLElement).hasClass('internal-link')) {
                    return;
                }

                // Allow clicking badge too
                if ((e.target as HTMLElement).hasClass('anki-card-synced-badge')) {
                    // Maybe show toast info? 
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
            const actionsDiv = cardEl.createDiv({ cls: 'anki-card-actions' });

            if (card.id) {
                // UNSYNC BUTTON (Destructive)
                const unsyncBtn = new ButtonComponent(actionsDiv)
                    .setIcon("trash-2")
                    .setTooltip("Aus Anki entfernen & ID löschen");
                unsyncBtn.buttonEl.addClass("anki-unsync-btn");
                unsyncBtn.buttonEl.style.color = "var(--text-error)";

                unsyncBtn.onClick(async (e) => {
                    e.stopPropagation();
                    if (confirm(`Möchtest du diese Karte (ID: ${card.id}) wirklich aus Anki löschen? Die Karte bleibt in deiner Notiz erhalten, aber die Synchronisation wird aufgehoben.`)) {
                        new Notice("Lösche aus Anki...");
                        // 1. Delete from Anki
                        const { deleteAnkiNotes } = await import('../anki/AnkiConnect');
                        if (card.id) await deleteAnkiNotes([card.id]);

                        // 2. Remove ID from file (via saveAnkiBlockChanges logic roughly)
                        // We need to find the block, parse cards, find THIS card, remove ID, save block.
                        const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
                        if (file instanceof TFile) {
                            const content = await plugin.app.vault.read(file);
                            // Need regex and parser
                            const { getAnkiBlockMatches, parseCardsFromBlockSource, formatCardsToString } = await import('../anki/ankiParser');
                            const { findSpecificAnkiBlock } = await import('../anki/ankiParser');

                            const matches = getAnkiBlockMatches(content);
                            let foundBlockMatch = null;
                            let foundCardIndex = -1;

                            for (const m of matches) {
                                const blockContent = m[1];
                                const blockCards = parseCardsFromBlockSource(blockContent);
                                // Match by ID if possible, otherwise content
                                const idx = blockCards.findIndex(c => c.id === card.id);
                                if (idx !== -1) {
                                    foundBlockMatch = m;
                                    foundCardIndex = idx;
                                    break;
                                }
                            }

                            if (foundBlockMatch && foundCardIndex !== -1) {
                                const blockContent = foundBlockMatch[1];
                                const blockCards = parseCardsFromBlockSource(blockContent);

                                // Update the specific card: Remove ID
                                blockCards[foundCardIndex].id = null;

                                // Reconstruct Block
                                let currentDeck = deckName || plugin.settings.mainDeck;
                                const deckMatch = blockContent.match(/^TARGET DECK: (.*)$/m);
                                if (deckMatch) currentDeck = deckMatch[1];

                                // We need simple reconstruction
                                // Or utilize saveAnkiBlockChanges? 
                                // saveAnkiBlockChanges requires us to pass ALL updated cards for the block.
                                // We have blockCards (modified).
                                const { saveAnkiBlockChanges } = await import('../anki/syncManager');

                                // saveAnkiBlockChanges handles deck line, instruction etc automatically if we pass them? 
                                // Actually saveAnkiBlockChanges RE-READS the file content and finds block again. 
                                // We can use it.
                                // But saveAnkiBlockChanges takes "updatedCards". 
                                // We modify the card in the array and pass it.

                                // We do NOT pass the ID in deletedCardIds for saveAnkiBlockChanges because 
                                // that function CALLS deleteAnkiNotes itself if passed!
                                // But we already called deleteAnkiNotes manually to accept partial failure? 
                                // Or better: Let saveAnkiBlockChanges do it all.

                                // Better path: Use saveAnkiBlockChanges.
                                // 1. Identify block and cards. (Done: blockCards)
                                // 2. Modify target card in list: remove ID.
                                // 3. Pass deleted ID separately.

                                const cardIdToDelete = card.id!;
                                blockCards[foundCardIndex].id = null;

                                await saveAnkiBlockChanges(plugin, blockContent, blockCards, [cardIdToDelete]);
                                new Notice("Karte erfolgreich entsynchronisiert!");
                            }
                        }
                    }
                });

            } else {
                // SYNC BUTTON (Normal)
                const syncBtn = new ButtonComponent(actionsDiv)
                    .setIcon("refresh-cw")
                    .setTooltip("Karte synchronisieren");
                syncBtn.onClick(async (e) => {
                    e.stopPropagation();

                    // Find and Sync Logic
                    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
                    if (file instanceof TFile) {
                        const content = await plugin.app.vault.read(file);
                        // We need to find the block this card belongs to.
                        // Card has originalText? Yes.
                        // We can match the originalText in the content? 
                        // Or we can parse blocks and find which one contains this card.

                        // Simple approach: Iterate blocks, parse matching block, find card.
                        // IMPORTANT: We need correct index logic.
                        const matches = getAnkiBlockMatches(content);
                        let foundBlockMatch = null;
                        let foundCardIndex = -1;

                        for (const m of matches) {
                            // Check if this block contains our card
                            // We can parse the block and try to find matching Q/A
                            const blockContent = m[1];
                            const blockCards = parseCardsFromBlockSource(blockContent);
                            const idx = blockCards.findIndex(c => c.q.trim() === card.q.trim() && c.a.trim() === card.a.trim());

                            if (idx !== -1) {
                                foundBlockMatch = m;
                                foundCardIndex = idx; // This is the index WITHIN the block
                                break;
                            }
                        }

                        if (foundBlockMatch && foundCardIndex !== -1) {
                            const blockContent = foundBlockMatch[1];
                            const blockCards = parseCardsFromBlockSource(blockContent);
                            let currentDeck = deckName || plugin.settings.mainDeck;
                            const deckMatch = blockContent.match(/^TARGET DECK: (.*)$/m);
                            if (deckMatch) currentDeck = deckMatch[1];

                            // Sync JUST this block, targeting ONLY the specific card index
                            new Notice(`Synchronisiere einzelne Karte...`);
                            await syncAnkiBlock(plugin, blockContent, currentDeck, blockCards, file, foundCardIndex);
                        } else {
                            new Notice("Konnte den Anki-Block für diese Karte nicht finden.");
                        }
                    }
                });
            }

            const editBtn = new ButtonComponent(actionsDiv);
            editBtn.setIcon('pencil');
            editBtn.setTooltip("Bearbeiten");
            editBtn.onClick(async (e) => {
                e.stopPropagation(); // Avoid Collapse? It's in body, so no collapse.
                // Edit Logic
                state.questionsScrollTop = cardsDiv.scrollTop; // Save scroll position before opening modal (just in case)

                new CardEditModal(plugin.app, card, sourcePath, async (updatedCard, shouldSync) => {
                    if (isSameCard(card, updatedCard) && !shouldSync) return;

                    // Update in file
                    await updateCardInFile(plugin, sourcePath, card, updatedCard);

                    if (shouldSync) {
                        // Trigger Sync Logic for THIS card's block
                        // Reuse logic from Sync Button
                        const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
                        if (file instanceof TFile) {
                            setTimeout(async () => { // Wait for file update to propagate?
                                const content = await plugin.app.vault.read(file);
                                const matches = getAnkiBlockMatches(content);
                                let foundBlockMatch = null;
                                let foundCardIndex = -1;

                                for (const m of matches) {
                                    // Check for UPDATED card content
                                    const blockContent = m[1];
                                    const blockCards = parseCardsFromBlockSource(blockContent);
                                    const idx = blockCards.findIndex(c => c.q.trim() === updatedCard.q?.trim() && c.a.trim() === updatedCard.a?.trim());

                                    if (idx !== -1) {
                                        foundBlockMatch = m;
                                        foundCardIndex = idx;
                                        break;
                                    }
                                }
                                if (foundBlockMatch && foundCardIndex !== -1) {
                                    const blockContent = foundBlockMatch[1];
                                    const blockCards = parseCardsFromBlockSource(blockContent);
                                    let currentDeck = deckName || plugin.settings.mainDeck;
                                    const deckMatch = blockContent.match(/^TARGET DECK: (.*)$/m);
                                    if (deckMatch) currentDeck = deckMatch[1];

                                    new Notice(`Synchronisiere Karte...`);
                                    await syncAnkiBlock(plugin, blockContent, currentDeck, blockCards, file, foundCardIndex);
                                }
                            }, 500); // 500ms delay to ensure file write
                        }
                    }
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
                    await updateCardInFile(plugin, sourcePath, card, null);
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

        // RESTORE SCROLL POSITION
        if (state.questionsScrollTop) {
            cardsDiv.scrollTop = state.questionsScrollTop;
        }
    } catch (e) {
        console.error("Error generating card preview:", e);
    }
}



function renderSidebarControls(container: HTMLElement, plugin: AnkiGeneratorPlugin, sourcePath: string | undefined, onOpenInAction: (() => void) | undefined, deckName: string | null, cards: Card[] | undefined, showControls: boolean = true) {
    if (!sourcePath || !showControls) return;

    const actionContainer = container.createDiv({ cls: 'anki-sidebar-actions' });
    actionContainer.style.marginBottom = '10px';
    actionContainer.style.background = 'var(--background-secondary)';
    actionContainer.style.padding = '8px';
    actionContainer.style.borderRadius = '5px';

    // Header Row with Title and Deck
    const headerRow = actionContainer.createDiv({ cls: 'anki-actions-header' });
    headerRow.style.display = 'flex';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.alignItems = 'center';
    headerRow.style.marginBottom = '8px';

    headerRow.createEl('h4', { text: '⚡ Aktionen' }).style.margin = '0';

    // Deck Info (if available)
    if (deckName) {
        const deckDiv = headerRow.createDiv({ cls: 'anki-sidebar-deck' });
        deckDiv.style.fontSize = '0.85em';
        deckDiv.style.color = 'var(--text-muted)';
        deckDiv.style.display = 'flex';
        deckDiv.style.alignItems = 'center';
        deckDiv.style.gap = '4px';

        // Shorten deck name if too long
        let displayDeck = deckName;
        if (displayDeck.startsWith(plugin.settings.mainDeck + '::')) {
            displayDeck = displayDeck.substring(plugin.settings.mainDeck.length + 2);
        }
        if (displayDeck.length > 20) displayDeck = displayDeck.substring(0, 18) + '..';

        deckDiv.createSpan({ text: displayDeck, title: deckName });

        // Edit Deck Button
        const editDeckBtn = deckDiv.createEl('button', { cls: 'clickable-icon' });
        editDeckBtn.style.padding = '2px';
        editDeckBtn.style.background = 'transparent';
        editDeckBtn.style.height = 'auto';
        editDeckBtn.style.boxShadow = 'none';
        setIcon(editDeckBtn, 'pencil');
        editDeckBtn.title = "Deck ändern";
        editDeckBtn.onclick = async () => {
            // Open Deck Selection
            let deckNames: string[] = [];
            try { deckNames = await getDeckNames(); } catch (e) { }

            new DeckSelectionModal(plugin.app, deckName || plugin.settings.mainDeck, deckNames, async (newDeckName) => {
                if (newDeckName && newDeckName !== deckName) {
                    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
                    if (file instanceof TFile) {
                        await updateFirstBlockDeck(plugin.app, file, newDeckName);
                    }
                }
            }).open();
        };
    }

    const btnRow = actionContainer.createDiv({ cls: 'anki-btn-row' });
    btnRow.style.display = 'flex';
    btnRow.style.flexWrap = 'wrap';
    btnRow.style.gap = '6px';

    // 1. Auto Generate (Smart button)
    const quickGenButton = btnRow.createEl('button', { text: '⚡ Auto' });
    quickGenButton.style.flex = '1';
    quickGenButton.title = "Generiert Karten für die aktuelle Datei";
    quickGenButton.onclick = async () => {
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== sourcePath) { new Notice("Bitte die entsprechende Datei öffnen."); return; }

        const provider = resolveProvider(plugin.settings);

        if (!provider) { new Notice("Kein KI-Modell konfiguriert."); return; }
        await runGenerationProcess(plugin, view.editor, provider, "", "");
    };

    // 2. Sync
    const syncButton = btnRow.createEl('button', { text: '🔄 Sync' });
    syncButton.style.flex = '1';
    syncButton.onclick = async () => {
        const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) return;

        const content = await plugin.app.vault.read(file);
        const matches = getAnkiBlockMatches(content);
        if (matches.length > 0) {
            let syncedCount = 0;
            for (const m of matches) {
                const blockContent = m[1];
                const blockCards = parseCardsFromBlockSource(blockContent);
                let currentDeck = deckName || plugin.settings.mainDeck;
                const deckMatch = blockContent.match(/^TARGET DECK: (.*)$/m);
                if (deckMatch) currentDeck = deckMatch[1];

                await syncAnkiBlock(plugin, blockContent, currentDeck, blockCards, file);
                syncedCount++;
            }
            if (syncedCount > 0) new Notice(`${syncedCount} Anki-Blöcke synchronisiert.`);
        } else {
            new Notice("Keine Anki-Blöcke gefunden.");
        }
    };

    // 3. Revise
    const reviseButton = btnRow.createEl('button', { text: '✏️ Revise' });
    reviseButton.style.flex = '1';
    reviseButton.title = "Karten überarbeiten";
    reviseButton.onclick = async () => {
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== sourcePath) { new Notice("Bitte die entsprechende Datei öffnen."); return; }

        startRevisionProcess(plugin, view.editor, deckName, sourcePath, (history) => {
            plugin.activateFeedbackView(history, sourcePath);
        });
    };

    // 4. Manual
    if (plugin.settings.enableManualMode) {
        const manualBtn = btnRow.createEl('button', { text: '🛠️ Manual' });
        manualBtn.style.flex = '1';
        manualBtn.onclick = async () => {
            const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
            if (file instanceof TFile) {
                const content = await plugin.app.vault.read(file);
                const { preparedContent, files } = await extractImagesAndPrepareContent(plugin, content, file.path);
                const existingCardsText = cards ? cards.map(c => c.originalText).join('\n') : "";
                const prompt = constructPrompt(preparedContent, existingCardsText, plugin.settings, "", false, file.basename);

                new ManualGenerationModal(plugin.app, prompt, async (response) => {
                    if (!response) return;
                    const cleaned = cleanAiGeneratedText(response);
                    const matches = getAnkiBlockMatches(content);

                    if (matches.length > 0) {
                        const lastMatch = matches[matches.length - 1];
                        const blockContent = lastMatch[1];
                        const newContent = `\`\`\`anki-cards\n${blockContent}\n${cleaned}\n\`\`\``;
                        const newFileContent = content.replace(lastMatch[0], newContent);
                        await plugin.app.vault.modify(file, newFileContent);
                        new Notice("Karten hinzugefügt.");
                    } else {
                        const newBlock = `\`\`\`anki-cards\nTARGET DECK: ${plugin.settings.mainDeck}\n\n${cleaned}\n\`\`\``;
                        await plugin.app.vault.append(file, "\n" + newBlock);
                        new Notice("Neuer Anki-Block erstellt.");
                    }

                }, undefined, files).open();
            }
        };
    }
}

async function updateCardInFile(plugin: AnkiGeneratorPlugin, sourcePath: string, originalCard: Card, updatedCard: Card | null) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;
    const content = await plugin.app.vault.read(file);

    // Use imported regex (matches all) or local ref if needed. 
    // ANKI_BLOCK_REGEX is imported from parser.
    const matches = getAnkiBlockMatches(content);

    for (const match of matches) {
        const fullBlock = match[0];
        const blockContent = match[1];
        const cards = parseCardsFromBlockSource(blockContent);

        // Find card in this block
        const idx = cards.findIndex(c => isSameCard(c, originalCard));
        if (idx !== -1) {
            // Found the block!
            const newCards = [...cards];
            if (updatedCard) {
                newCards[idx] = updatedCard;
                await saveAnkiBlockChanges(plugin, blockContent, newCards, [], undefined); // deckName undefined
            } else {
                // Delete
                const deletedId = originalCard.id ? [originalCard.id] : [];
                newCards.splice(idx, 1);
                await saveAnkiBlockChanges(plugin, blockContent, newCards, deletedId, undefined);
            }
            return;
        }
    }
    new Notice("Konnte die Karte im Dokument nicht finden (vielleicht wurde sie verschoben?).");
}

function isSameCard(c1: Card, c2: Card): boolean {
    if (c1.id && c2.id) return c1.id === c2.id;
    // Fallback: compare content
    return c1.q === c2.q && c1.a === c2.a;
}
