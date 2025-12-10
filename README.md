# Obsidian Anki Generator Plugin 🧠✨

Transform your Obsidian notes into Anki flashcards automatically using the power of AI.

![Anki Generator Demo](https://github.com/user-attachments/assets/placeholder-image)

## 🚀 Features

### 🤖 AI-Powered Generation
- **Multi-Provider Support**: Use **Google Gemini**, **OpenAI (ChatGPT)**, or **Ollama** (Local LLMs).
- **Context-Aware**: Generates:
    - **Basic Cards**: Simple Q&A and Lists.
    - **Cloze Deletion**: Fill-in-the-blank for definitions.
    - **Type-In Cards**: (New!) Forces active recall for precise facts (formulas, values).
- **Smart Updates**: Detects existing cards to avoid duplicates.

### 🧠 Deep Integration
- **Smart Link Validation**: 
    - Automatically checks if Obsidian links (`[[Link]]`) exist in your vault.
    - If a link is broken, it's converted to plain text in Anki to avoid dead links.
    - Resolves `block-id` references and aliases correctly.
- **Visual Decorations**: (Optional) Adds "Anki" icons to files in the file explorer that contain cards (can be toggled).

### 🔍 AI Feedback
- Get instant, constructive feedback on your learning material directly within Obsidian.
- **Context-Specific**: Tuned for Preclinical/medical content (configurable).
- **Chat Interface**: Ask follow-up questions or request revisions to your notes.

### 🔄 Seamless Anki Integration
- **Direct Sync**: Pushes cards directly to Anki via AnkiConnect.
- **Global Sync**: Find and sync all unsynced cards across your entire vault with one click.
- **Status Tracking**: Visual indicators for synced vs. local cards.

### 🛠️ Powerful Management
- **Preview & Edit**: Review generated cards, edit them, or delete them before syncing.
- **Hierarchical Deck Selection**: 
    - Visual tree view for selecting decks.
    - Filter and search through your deck structure.
- **Manual Mode**: Fallback to manual copy-paste if the API is overloaded or fails.
- **Code Highlighting**: Preserves code blocks and formatting.

## ⚙️ Installation

1.  **Prerequisites**:
    - [Anki](https://apps.ankiweb.net/) installed.
    - [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on installed in Anki.
2.  **Install Plugin**:
    - Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
    - Place them in `.obsidian/plugins/t1il-anki-creator/`.
    - Enable the plugin in Obsidian settings.

## 📝 Usage

1.  **Add a Block**:
    Insert an Anki block in your note:
    \`\`\`anki-cards
    TARGET DECK: MyDeck
    \`\`\`
2.  **Generate**:
    Click the **✨ Gemini**, **🤖 OpenAI**, or **⚡ Auto** button to generate cards from the note content.
3.  **Review & Sync**:
    - Click **📝 Vorschau** to edit cards.
    - Click **🔄 Sync** to push them to Anki.
    - Click **🔍 Feedback** to get AI suggestions on your text.

## 🔧 Configuration

Go to **Settings > Anki Generator** to configure:
- **AI Keys**: Enter your API keys:
    - **Google Gemini**: [Get API Key](https://aistudio.google.com/app/apikey)
    - **OpenAI**: [Get API Key](https://platform.openai.com/api-keys)
    - **Ollama**: [Download & Setup](https://ollama.com)
- **Prompts**: Customize the system prompts for card generation and feedback.
- **Anki Models**: Map the plugin to your specific Anki Note Types.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT
