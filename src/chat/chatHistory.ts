import AnkiGeneratorPlugin from '../main';
import { ChatMessage } from '../types';

/**
 * Chat-Verlauf pro Notiz.
 *
 * Vorher lag der Verlauf nur im RAM und wurde von jeder Kartengenerierung
 * überschrieben (feedbackCache.set(path, [feedback])) - die laufende
 * Unterhaltung war damit weg. Jetzt wird angehängt und auf Platte gesichert.
 */

const MAX_MESSAGES_PER_NOTE = 50;
const MAX_NOTES = 30;
const SAVE_DEBOUNCE_MS = 1000;

let saveTimer: number | null = null;

function historyFile(plugin: AnkiGeneratorPlugin): string {
	const dir = plugin.manifest.dir || `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
	return `${dir}/chat-history.json`;
}

export function getHistory(plugin: AnkiGeneratorPlugin, path: string | undefined): ChatMessage[] {
	if (!path) return [];
	return plugin.feedbackCache.get(path) || [];
}

/** Historie auf die Obergrenze kürzen (die ältesten Nachrichten fliegen raus). */
function trim(history: ChatMessage[]): ChatMessage[] {
	if (history.length <= MAX_MESSAGES_PER_NOTE) return history;
	return history.slice(history.length - MAX_MESSAGES_PER_NOTE);
}

export function setHistory(plugin: AnkiGeneratorPlugin, path: string | undefined, history: ChatMessage[]) {
	if (!path) return;
	plugin.feedbackCache.set(path, trim(history));
	scheduleSave(plugin);
}

/**
 * Hängt eine KI-Nachricht an den bestehenden Verlauf an, statt ihn zu ersetzen.
 * Gibt das (mutierte) Array zurück, weil die Renderer damit weiterarbeiten.
 */
export function appendFeedbackToCache(
	plugin: AnkiGeneratorPlugin,
	path: string | undefined,
	feedback: string
): ChatMessage[] {
	const message: ChatMessage = { role: 'ai', content: feedback };
	if (!path) return [message];

	const existing = plugin.feedbackCache.get(path);
	if (existing) {
		existing.push(message);
		// In-place kürzen, damit bestehende Referenzen gültig bleiben.
		while (existing.length > MAX_MESSAGES_PER_NOTE) existing.shift();
		scheduleSave(plugin);
		return existing;
	}

	const history = [message];
	plugin.feedbackCache.set(path, history);
	scheduleSave(plugin);
	return history;
}

export function clearHistory(plugin: AnkiGeneratorPlugin, path: string | undefined) {
	if (!path) return;
	plugin.feedbackCache.delete(path);
	scheduleSave(plugin);
}

export function scheduleSave(plugin: AnkiGeneratorPlugin) {
	if (saveTimer !== null) window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => {
		saveTimer = null;
		void saveHistory(plugin);
	}, SAVE_DEBOUNCE_MS);
}

export async function saveHistory(plugin: AnkiGeneratorPlugin) {
	try {
		// Nur die zuletzt benutzten Notizen behalten - Map bewahrt die Einfügereihenfolge.
		const entries = Array.from(plugin.feedbackCache.entries()).slice(-MAX_NOTES);
		const payload: Record<string, ChatMessage[]> = {};
		entries.forEach(([path, history]) => {
			if (history.length > 0) payload[path] = trim(history);
		});
		await plugin.app.vault.adapter.write(historyFile(plugin), JSON.stringify(payload));
	} catch (e) {
		console.warn('Chat-Verlauf konnte nicht gespeichert werden:', e);
	}
}

export async function loadHistory(plugin: AnkiGeneratorPlugin) {
	try {
		const file = historyFile(plugin);
		if (!(await plugin.app.vault.adapter.exists(file))) return;

		const raw = await plugin.app.vault.adapter.read(file);
		const parsed = JSON.parse(raw) as Record<string, ChatMessage[]>;

		Object.keys(parsed).forEach((path) => {
			const history = parsed[path];
			if (Array.isArray(history)) plugin.feedbackCache.set(path, trim(history));
		});
	} catch (e) {
		console.warn('Chat-Verlauf konnte nicht geladen werden:', e);
	}
}
