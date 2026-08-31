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
  Card changes are addressed by note ID, so they apply without any text search;
  changes to note prose are located even when the passage contains wikilinks,
  bold markers or typographic quotes.
- Streams responses, keeps a per-note history across restarts, and can be opened
  in the sidebar or as a full tab.

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
