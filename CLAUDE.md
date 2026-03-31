# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Obsidian plugin that generates Anki flashcards from note content using LLMs (Google Gemini, OpenAI, Ollama). Cards are defined in `anki-cards` code blocks, synced to Anki via the AnkiConnect addon (localhost:8765).

## Build Commands

```bash
npm install          # Install dependencies
npm run dev          # esbuild watch mode (rebuilds on changes)
npm run build        # TypeScript type-check + production bundle
npm run version      # Bump version in manifest.json & versions.json
eslint ./src/        # Lint (requires global eslint: npm install -g eslint)
```

No test framework is configured. Testing is manual: copy `main.js`, `manifest.json`, `styles.css` into the vault plugin folder and reload Obsidian.

## Architecture

**Entry point**: `src/main.ts` → bundled to `main.js` by esbuild (`esbuild.config.mjs`). Output format is CommonJS. External deps (`obsidian`, `electron`, `@codemirror/*`, `@lezer/*`) are excluded from the bundle.

**Core flow**: `anki-cards` code block → `ankiBlockProcessor.ts` (renders UI) → `generationManager.ts` (orchestrates) → `aiGenerator.ts` (LLM calls) → `CardPreviewModal` (edit/review) → `syncManager.ts` (sync to Anki via AnkiConnect)

**Key modules**:
- `src/main.ts` — Plugin lifecycle, command/ribbon registration, file decorations
- `src/settings.ts` — Settings tab UI and `AnkiGeneratorSettings` interface (30+ options)
- `src/aiGenerator.ts` — Prompt construction, multi-provider LLM calls (Gemini/OpenAI/Ollama)
- `src/generationManager.ts` — Generation workflow orchestration
- `src/ankiBlockProcessor.ts` — Markdown code block processor, renders in-note UI
- `src/anki/AnkiConnect.ts` — HTTP client for AnkiConnect API
- `src/anki/ankiParser.ts` — Parses/formats `anki-cards` block content
- `src/anki/syncManager.ts` — Card sync logic with image handling and duplicate detection
- `src/ui/` — 25+ modal/view components (preview, edit, deck selection, feedback, decorations)
- `src/lang/` — i18n (German `de.ts`, English `en.ts`)
- `src/types.ts` — Card, ChatMessage, ImageInput interfaces

**Plugin state** (on the plugin instance):
- `settings` — User configuration
- `feedbackCache` — Chat history keyed by file path
- `activeGenerations` — Map of running generation tasks with AbortControllers

## anki-cards Block Format

```
TARGET DECK: DeckName::Subdeck
INSTRUCTION: Custom instruction for AI
STATUS: OVERLOADED (optional)

Q: Question text
A: Answer text
ID: 12345

Q: Cloze question with {{c1::cloze}}
ID: 12346

Q: Type-in question
A (type): Expected typed answer
ID: 12347
```

Card types: Basic (Q:/A:), Cloze ({{c1::...}}), Type-In (A (type):).

## Key Conventions

- TypeScript strict mode enabled (`tsconfig.json`)
- Keep `main.ts` minimal — lifecycle only, delegate to modules
- Use `this.register*` helpers for all listeners/intervals (cleanup on unload)
- Command IDs are stable — never rename after release
- `manifest.json` `id` field must never change
- Release artifacts: `main.js`, `manifest.json`, `styles.css` at plugin root
- i18n: use the helper from `src/lang/helpers.ts` for user-facing strings
