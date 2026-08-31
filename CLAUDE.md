# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Obsidian plugin that generates Anki flashcards from note content using LLMs (Anthropic Claude, Google Gemini, OpenAI, Ollama). Cards are defined in `anki-cards` code blocks, synced to Anki via the AnkiConnect addon (localhost:8765).

## Build Commands

```bash
npm install          # Install dependencies
npm run dev          # esbuild watch mode (rebuilds on changes)
npm run build        # TypeScript type-check + production bundle
npm test             # Fixture tests (parser, chat, Anki comparison)
npm run version      # Bump version in manifest.json & versions.json
eslint ./src/        # Lint (requires global eslint: npm install -g eslint)
```

`npm test` runs three standalone scripts under `scripts/`. They bundle the
relevant module with esbuild (stubbing `obsidian`, whose imports are types
only) and run fixtures against it — no test framework needed. Run them after
any change to the parser, the chat suggestion format, or the Anki comparison.

Beyond that, testing is manual: `npm run build` writes `main.js` next to
`manifest.json`, so if the repo lives inside a vault's plugin folder, just
reload Obsidian.

## Architecture

**Entry point**: `src/main.ts` → bundled to `main.js` by esbuild (`esbuild.config.mjs`). Output format is CommonJS. External deps (`obsidian`, `electron`, `@codemirror/*`, `@lezer/*`) are excluded from the bundle.

**Core flow**: `anki-cards` code block → `ankiBlockProcessor.ts` (renders UI) → `generationManager.ts` (orchestrates) → `aiGenerator.ts` (LLM calls via `providers.ts`) → `CardPreviewModal` (edit/review) → `syncManager.ts` (sync to Anki via AnkiConnect)

**Key modules**:
- `src/main.ts` — Plugin lifecycle, command/ribbon registration, file decorations
- `src/providers.ts` — Provider registry (Claude/Gemini/OpenAI/Ollama): request building, response parsing, streaming format, retry classification, model lists
- `src/aiGenerator.ts` — Prompt construction, the shared request/retry loop, streaming
- `src/settings.ts` — Settings tab UI and `AnkiGeneratorSettings` interface
- `src/generationManager.ts` — Generation and revision workflow
- `src/ankiBlockProcessor.ts` — Markdown code block processor, renders in-note UI
- `src/anki/AnkiConnect.ts` — HTTP client for AnkiConnect
- `src/anki/ankiParser.ts` — Block location, card parsing, serialization
- `src/anki/syncManager.ts` — Card sync with image handling and duplicate detection
- `src/anki/driftCheck.ts` — Compares notes against Anki, classifies the difference
- `src/chat/` — Suggestion format/parsing, applying suggestions, text location, chat history
- `src/ui/chat/ChatPanel.ts` — The AI chat (incremental rendering, streaming)
- `src/ui/` — Modal/view components (preview, edit, deck selection, drift review, decorations)
- `src/lang/` — i18n (German `de.ts`, English `en.ts`)
- `src/types.ts` — `Card`, `ChatMessage`, `ChatTurn`, `ImageInput`, `AiProvider`

**Plugin state** (on the plugin instance):
- `settings` — User configuration
- `feedbackCache` — Chat history keyed by file path, persisted to `chat-history.json`
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

## Invariants — these have caused data loss before

**Locate blocks only via `getAnkiBlocks()`** (`src/anki/ankiParser.ts`). It is
line-based on purpose: it tolerates CRLF, blocks nested in callouts (`> `),
trailing whitespace after the fence, and ```` fences that wrap inner ``` code
blocks. Do not add another `anki-cards` regex — there used to be three
incompatible ones.

**Never write a block with `String.replace(fullBlock, newBlock)`.** The
replacement string interprets `$$`, `$&`, `` $` `` and `$'`, which destroys
display math inside cards, and it hits the *first* occurrence rather than the
intended block. Use `spliceBlock()` with the block's index range, inside
`vault.process()` so read and write cannot drift apart.

**Rebuild blocks with `buildFullBlock()`**, never a hand-written
`` ```anki-cards `` fence. It preserves the block's own prefix (the `> ` of a
callout) and its backtick count.

**`cleanBlockInner(inner, prefix)` strips only as many blockquote levels as the
block itself carries.** Stripping every `>` removes quotes that are legitimate
*content* of a card answer, and the next write makes that permanent.

**After an async modal, re-find the block** instead of reusing indices captured
before it opened — the file may have changed meanwhile.

**Prefer batched AnkiConnect calls.** `updateNoteFieldsBatch()` sends many
field updates in one `multi` request; `addAnkiNotes` and `storeAnkiMediaFiles`
batch as well. `syncAnkiBlock` accepts a list of card indices so a selection can
be synced in a single pass.

## Key Conventions

- TypeScript strict mode enabled (`tsconfig.json`)
- Keep `main.ts` minimal — lifecycle only, delegate to modules
- Use `this.register*` helpers for all listeners/intervals (cleanup on unload)
- Command IDs are stable — never rename after release
- `manifest.json` `id` field must never change
- Release artifacts: `main.js`, `manifest.json`, `styles.css` at plugin root; a
  tag push triggers `.github/workflows/release.yml`, which builds them
- Styling belongs in `styles.css` using Obsidian theme variables. Hardcoded
  colors like `rgba(255,255,255,.1)` are invisible in light themes.
- i18n: use the helper from `src/lang/helpers.ts` for user-facing strings.
  Keys are type-checked against `de.ts`.
