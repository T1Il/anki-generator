# Obsidian Anki Generator Plugin 🧠✨

Transform your Obsidian notes into Anki flashcards automatically using the power of AI.

![Anki Generator Demo](https://github.com/user-attachments/assets/placeholder-image)

## 🚀 Features

### 🤖 AI-Powered Generation
- **Multi-Provider Support**: Use **Google Gemini**, **OpenAI (ChatGPT)**, or **Ollama** (Local LLMs).
- **Context-Aware**: Generates Basic (Q&A) and Cloze (Fill-in-the-blank) cards based on your note content.
- **Smart Updates**: Detects existing cards to avoid duplicates.

### 🔍 AI Feedback (New!)
- Get instant, constructive feedback on your learning material directly within Obsidian.
- The AI analyzes your notes and suggests improvements for clarity and structure.
- **Configurable**: Customize the feedback prompt (default is German).

### 🔄 Seamless Anki Integration
- **Direct Sync**: Pushes cards directly to Anki via AnkiConnect.
- **Global Sync**: Find and sync all unsynced cards across your entire vault with one click.
- **Status Tracking**: Visual indicators for synced vs. local cards.

### 🛠️ Powerful Management
- **Preview & Edit**: Review generated cards, edit them, or delete them before syncing.
- **Search**: Quickly find all notes containing Anki cards.
- **Deck Management**: Rename target decks directly from the plugin.

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
- **AI Keys**: Enter your API keys for Gemini or OpenAI.
- **Prompts**: Customize the system prompts for card generation and feedback.
- **Anki Models**: Map the plugin to your specific Anki Note Types.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT
