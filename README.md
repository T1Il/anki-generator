# Obsidian Anki Generator Plugin

A plugin for Obsidian that generates Anki flashcards from your notes using Large Language Models (LLMs).

![Anki Generator Demo](https://github.com/user-attachments/assets/placeholder-image)

## Features

### Card Generation
- **LLM Support**: Compatible with Google Gemini, OpenAI (ChatGPT), and local models via Ollama.
- **Card Types**:
    - **Basic**: Question and Answer format.
    - **Cloze**: Fill-in-the-blank cards.
    - **Type-In**: Input fields for precise recall (e.g., values, formulas).
- **Duplicate Prevention**: Detects existing cards to prevent duplication during generation.

### Integration
- **Link Validation**: Checks internal links (`[[Link]]`) during generation. Broken links are converted to plain text to ensure Anki compatibility.
- **File Explorer**: Optionally marks files containing generated cards with an icon.

### Feedback System
- Analyzes note content to provide constructive feedback suited for medical/preclinical study contexts.
- Includes a chat interface for refining prompts or asking follow-up questions.

### Anki Synchronization
- **AnkiConnect**: Syncs cards directly to Anki. Requires the AnkiConnect add-on.
- **Global Sync**: Identification and synchronization of all unsynced cards in the vault.
- **State Tracking**: Visual indicators for sync status.

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
    ```
    ```anki-cards
    TARGET DECK: MyDeck
    ```
    ```
2.  **Generate**: Use the generation buttons (Gemini, OpenAI, Auto) to create cards from the note content.
3.  **Sync**:
    - Click **Preview** to edit or review cards.
    - Click **Sync** to push cards to Anki.
    - Click **Feedback** for content analysis.

## Configuration

Settings are available under **Settings > Anki Generator**:
- **API Keys**: enter keys for Google Gemini or OpenAI.
- **Ollama**: Configure the endpoint for local models.
- **Prompts**: Customize system prompts for generation and feedback.
- **Anki Models**: Map plugin outputs to specific Anki Note Types.

## License

MIT
