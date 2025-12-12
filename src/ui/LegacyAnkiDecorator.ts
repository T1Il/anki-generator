import {
    Decoration,
    DecorationSet,
    EditorView,
    WidgetType
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, Transaction, Text } from "@codemirror/state";

// -- State Effects --
export const toggleLegacyBlockEffect = StateEffect.define<{ from: number }>();

// -- Data Structure --
interface LegacyAnkiState {
    expanded: Set<number>; // Start positions of expanded blocks
    decorations: DecorationSet;
}

// -- Widget --
class LegacyBlockWidget extends WidgetType {
    constructor(private readonly from: number, private readonly to: number) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const div = document.createElement("div");
        div.className = "legacy-anki-widget";
        div.style.backgroundColor = "var(--background-secondary)";
        div.style.border = "1px solid var(--background-modifier-border)";
        div.style.borderRadius = "4px";
        div.style.padding = "4px 8px";
        div.style.cursor = "pointer";
        div.style.display = "inline-block";
        div.style.fontSize = "0.8em";
        div.style.opacity = "0.8";
        div.innerText = "📦 Legacy Anki Deck (Click to show)";

        div.onclick = (e) => {
            e.preventDefault();
            view.dispatch({
                effects: toggleLegacyBlockEffect.of({ from: this.from })
            });
        };

        return div;
    }
}

// -- Collapse Widget --
class LegacyCollapseWidget extends WidgetType {
    constructor(private readonly from: number) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const div = document.createElement("div");
        div.className = "legacy-anki-collapse-widget";
        div.style.backgroundColor = "transparent";
        div.style.color = "var(--text-muted)";
        div.style.cursor = "pointer";
        div.style.fontSize = "0.7em";
        div.style.marginBottom = "4px";
        div.style.userSelect = "none";
        div.innerText = "🔼 Hide Legacy Anki Deck";

        div.onclick = (e) => {
            e.preventDefault();
            view.dispatch({
                effects: toggleLegacyBlockEffect.of({ from: this.from })
            });
        };

        return div;
    }
}

// -- Decoration Builder --
function buildDecorations(doc: Text, expanded: Set<number>): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    let i = 1;
    const lines = doc.lines;
    let inGlobalCodeBlock = false;

    while (i <= lines) {
        const line = doc.line(i);
        
        if (line.text.trim().startsWith('```')) {
            inGlobalCodeBlock = !inGlobalCodeBlock;
        }

        if (!inGlobalCodeBlock && line.text.match(/^#{1,6}\s+Anki/i)) {
            const startPos = line.from;
            let endPos = line.to;
            let hasTargetDeck = false;
            let blockEndLine = i;
            let innerCodeBlock = false;

            for (let j = i + 1; j <= lines; j++) {
                const subLine = doc.line(j);
                const subText = subLine.text.trim();

                if (subText.startsWith('```')) {
                    innerCodeBlock = !innerCodeBlock;
                }

                if (!innerCodeBlock && subLine.text.match(/^#{1,6}\s/)) {
                    break;
                }
                
                if (!innerCodeBlock && subLine.text.includes("TARGET DECK")) {
                    hasTargetDeck = true;
                }
                
                endPos = subLine.to;
                blockEndLine = j;
            }

            if (hasTargetDeck) {
                if (!expanded.has(startPos)) {
                    // Hidden: Show "Show" widget (replacing content)
                    builder.add(
                        startPos,
                        endPos,
                        Decoration.replace({
                            widget: new LegacyBlockWidget(startPos, endPos)
                        })
                    );
                } else {
                    // Expanded: Show "Collapse" widget (inserted above)
                    builder.add(
                        startPos,
                        startPos,
                        Decoration.widget({
                            widget: new LegacyCollapseWidget(startPos),
                            side: -1
                        })
                    );
                }
            }
            
            i = blockEndLine;
        }
        i++;
    }
    return builder.finish();
}


// -- State Field --
export const legacyAnkiStateField = StateField.define<LegacyAnkiState>({
    create(state) {
        const expanded = new Set<number>();
        const decorations = buildDecorations(state.doc, expanded);
        return { expanded, decorations };
    },
    update(value, transaction) {
        let expanded = value.expanded;
        let shouldRebuild = false;

        // 1. Map expanded positions if doc changed
        if (transaction.docChanged) {
            const newExpanded = new Set<number>();
            for (const pos of expanded) {
                // simple mapping
                const newPos = transaction.changes.mapPos(pos);
                newExpanded.add(newPos);
            }
            expanded = newExpanded;
            shouldRebuild = true;
        }

        // 2. Handle interactions
        for (const effect of transaction.effects) {
            if (effect.is(toggleLegacyBlockEffect)) {
                // Toggle
                const newExpanded = new Set(expanded);
                if (newExpanded.has(effect.value.from)) {
                    newExpanded.delete(effect.value.from);
                } else {
                    newExpanded.add(effect.value.from);
                }
                expanded = newExpanded;
                shouldRebuild = true;
            }
        }

        if (shouldRebuild) {
            return {
                expanded,
                decorations: buildDecorations(transaction.newDoc, expanded)
            };
        }

        return value;
    },
    provide: (field) => EditorView.decorations.from(field, v => v.decorations)
});
