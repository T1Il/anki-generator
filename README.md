# Obsidian Anki Generator Plugin

A plugin for Obsidian that generates Anki flashcards from your notes using Large Language Models (LLMs).

## Features

### Card Generation
- **LLM Support**: Anthropic Claude, Google Gemini, OpenAI (ChatGPT), and local models via Ollama.
- **Card Types**:
    - **Basic**: Question and Answer format.
    - **Cloze**: Fill-in-the-blank cards.
    - **Type-In**: Input fields for precise recall (e.g., values, formulas).
- **Duplicate Prevention**: Detects existing cards to prevent duplication during generation.

### AI Chat & Feedback
- Analyzes note content and gives feedback suited for medical/preclinical study contexts.
- **Applicable suggestions**: the model returns changes in a machine-readable
  block, and the chat renders each one as a diff with an **Übernehmen** button.
  Card changes are addressed by their card number (`CARD:`), so they apply without any
  text search; an unknown ID is caught before the click (fallback: matching question,
  or **Als neue Karte** for old `<!--ID-->` cards). Changes to note prose are located
  even when the passage contains wikilinks, bold markers or typographic quotes.
- **Full-size chat**: *Chat öffnen* (or ⤢ in the chat header) opens a modal with the
  chat on the left and, on the right, a before/after comparison of the selected
  suggestion — rendered, diagrams included — or the whole note.
- **Legacy cards stay out of the prompt**: old `TARGET DECK` blocks with `<!--ID-->`
  comments are removed from the note text sent to the model (the note is untouched).
- **Insertions** (`anki-insert`, after an anchor line) for new sections; a new card in a
  note without cards creates the `## Anki` block (deck taken from neighbouring notes).
- **Mermaid diagrams**: for processes (mechanism, kinetics, decision paths) the model
  proposes a diagram in the vault's style plus a card that asks for it. The suggestion
  shows the rendered diagram and is blocked if Mermaid reports a syntax error; common
  model mistakes (unquoted subgraph titles or labels with parentheses) are repaired first.
- **Open questions** written into a note (e.g. `(Frage: …)`) are answered with evidence;
  the suggestion replaces the question with the answer.
- Streams responses, keeps a per-note history across restarts, and can be opened
  in the sidebar or as a full tab.

### Drug sources into Zotero (desktop only)
- Command **"Medikament: Zotero-Quellen zusammenstellen"** (also a folder button in the chat):
  a Claude agent compiles the sources for the drug named like the note – summary of product
  characteristics (form used in EMS), Gelbe Liste, the chapter in "Medikamente im Rettungsdienst",
  SAA/BPR and DBRD (only if the drug appears, checked in the full text), DBRD Medikamentenbuch,
  Karow, RD-Factsheets/Notfallguru and up to three strong studies/guidelines.
- You tick the list; the Fitness-Manager backend (`/api/zotero/medikamente/anlegen`) creates
  `Medikamente/<drug>`, files existing works into it and attaches PDFs/page copies via WebDAV.
  Zotero key and WebDAV access stay on the server. Thieme chapter PDFs must be added via the
  browser connector (bot protection).
- The chat embedded in a note can be resized at its lower edge.

### Zotero cross-check (Claude agent, desktop only)
- The **library** button in the chat header opens a picker for Zotero collections
  (the collection named like the note is preselected, subcollections optional).
- A Claude agent (`claude -p`, the Claude CLI) reads the sources — Zotero's full-text
  cache first, then PDF/HTML — and compares them with the note and its cards:
  errors, contradictions between sources, gaps, badly posed cards.
- Its answer arrives in the chat with the usual **Übernehmen** suggestions; the agent
  itself only has read tools (Read/Grep/Glob) and never writes files.
- Optional **web research** (WebSearch/WebFetch); such evidence is marked
  "außerhalb Zotero".
- Needs Zotero 7 with the local API enabled (Settings → Advanced → "Allow other
  applications on this computer to communicate with Zotero") and a logged-in Claude CLI.

### Anki Synchronization
- **AnkiConnect**: Syncs cards directly to Anki. Requires the AnkiConnect add-on.
- **Global Sync**: Identification and synchronization of all unsynced cards in the vault.
- **State Tracking**: Visual indicators for sync status.
- **Drift check**: Compares your notes against what is actually stored in Anki,
  shows what differs and why, and lets you select which cards to push. Runs for
  the current note or the whole vault.

### Management
- **Preview & Edit**: Review and modify generated cards before syncing.
- **Deck Management**: Hierarchical view for selecting target decks.
- **Manual Mode**: Option to copy-paste card data if API limits are reached.

## Installation

1.  **Prerequisites**:
    - [Anki](https://apps.ankiweb.net/)
    - [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on for Anki.
2.  **Plugin Installation**:
    - Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
    - Create a folder named `t1il-anki-creator` in your `.obsidian/plugins/` directory.
    - Place the files in the folder.
    - Enable the plugin in Obsidian settings.

## Usage

1.  **Insert Block**: Add an Anki block to your note:

    ````
    ```anki-cards
    TARGET DECK: MyDeck
    ```
    ````

    If a card answer contains its own code block, open the outer block with four
    backticks (` ````anki-cards `) so the inner fence does not end it early.

2.  **Generate**: Use the generation buttons to create cards from the note content.
    One button appears per configured provider, plus **Auto**.
3.  **Sync**:
    - Click **Preview** to edit or review cards.
    - Click **Sync** to push cards to Anki.
    - Use the magnifier in the chat header for content analysis.

## Commands

Available from the command palette:

- *Generate Anki Cards from Note*
- *AI Chat öffnen (Seitenleiste)* / *AI Chat in neuem Tab öffnen*
- *Abweichungen zu Anki prüfen (aktuelle Notiz)*
- *Abweichungen zu Anki prüfen (ganzer Vault)*

## Configuration

Settings are available under **Settings > Anki Generator**:
- **AI Provider**: pick which provider is used. This setting is respected
  everywhere — generation, chat and feedback.
- **API Keys**: enter a key for Claude, Gemini or OpenAI; model lists are fetched
  from the provider.
- **Reasoning effort** (Claude): how much the model may think. *Low* is enough
  for card generation and keeps latency and cost down.
- **Ollama**: enable it and configure the endpoint for local models.
- **Prompts**: Customize system prompts for generation and feedback.
- **Anki Models**: Map plugin outputs to specific Anki Note Types.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production bundle
npm test        # fixture tests for parser, chat format and Anki comparison
```

See `CLAUDE.md` for the architecture and for invariants that must not be broken
when touching block parsing or writing.

## License

MIT
