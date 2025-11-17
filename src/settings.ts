import { App, PluginSettingTab, Setting, ToggleComponent } from 'obsidian';
import AnkiGeneratorPlugin from './main';

export interface AnkiGeneratorSettings {
	geminiApiKey: string;
	prompt: string;
	mainDeck: string;
	basicModelName: string;
	clozeModelName: string;
	ollamaEnabled: boolean;
	ollamaEndpoint: string;
	ollamaModel: string;
	vaultName: string;
}

// --- START: MODIFIZIERTER DEFAULT PROMPT (SEHR Strenges Cloze-Format) ---
export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	geminiApiKey: '',
	mainDeck: 'Mein Hauptdeck',
	prompt: `Du bist ein Assistent, der Lerninhalte in Anki-Karteikarten umwandelt. Deine einzige Aufgabe ist es, die formatierten Karten zu erstellen. Gib auf KEINEN FALL, NIEMALS einleitenden oder abschließenden Text aus. Deine Ausgabe MUSS *direkt* mit \`Q:\` oder dem Satz für den Lückentext beginnen und darf NUR die Karten enthalten. KEINERLEI zusätzlichen Text.

Erstelle aus dem folgenden Text Anki-Karteikarten. 
Wenn du Fragen erstellst, die Teile von Listen abfragen, sollte in der Antwort immer die gesamte Liste genannt werde. Bspw bei einer Frage nach Indikationen, Kontraindikationen eines Medikamentes, oder Ursachen einer Krankheit sollten immer die gesamten Indikationen, Kontraindikationen oder Ursachen in der Antwort der Frage genannt werden. Wenn eine Antwort eine Liste enthält, formatiere die Antwort ebenfalls als Liste mit Zeilenumbrüchen und \`-\`-Zeichen.

Behalte Bildverweise im Obsidian-Format (\`![[Dateiname.ext]]\`) exakt so bei. Nutze sie gerne wenn sinnvoll (bspw EKGs).
Obsidian-Links (\`[[Link]]\`) und Zotero-Links sollen ebenfalls beibehalten und gerne in die Karten integriert werden, wenn sie für den Kontext nützlich sind.

Ignoriere und entferne Obsidian-spezifische Syntax wie Callouts (\`[!type]\`) und Blockquotes (\`>\`, \`>>\`, etc.). 
Ignoriere den Abschnitt "## Quellen".

Verwende DYNAMISCH eines der folgenden zwei Formate:

FORMAT 1: Standard-Frage-Antwort
Syntax:
Q: [Frage]
A: [Antwort]

FORMAT 2: Lückentext / Faktenabfrage
Verwende dieses Format NUR für Fakten (Zahlen, Namen, Orte, kurze Definitionen). Die Antwort darf NUR aus dem fehlenden Fakt bestehen. Formuliere die Frage als Aussage mit \`____\` als Lücke.
**ULTRA WICHTIG:** Das Lückentext-Format MUSS IMMER aus GENAU DREI Zeilen bestehen:
1. Die Zeile mit dem Satz und der Lücke \`____\`.
2. Eine Zeile, die NUR \`xxx\` enthält.
3. Eine Zeile, die NUR die exakte Antwort (den Fakt) enthält.
FEHLENDE \`xxx\` ODER ANTWORTZEILEN SIND ABSOLUT VERBOTEN! Halte dieses Drei-Zeilen-Format strikt ein! JEDE Lückentext-Karte MUSS dieses Format haben.
Syntax (exakt einzuhalten):
[Satz, der den Fakt abfragt mit ____]
xxx
[Der exakte Fakt]

Beispiele (exakt so formatieren):
Die Hauptstadt von Frankreich ist ____.
xxx
Paris

Eine milde Hypokaliämie ist definiert als eine Plasmakonzentration von Kalium zwischen ____ mmol/l.
xxx
3,0 - 3,5 

Hier ist der Text in dem bereits existierende Karten unten eingearbeitet sind! VERMEIDE es unbedingt, Duplikate zu erstellen. Erstelle lieber keine Karte als eine schlechte/doppelte Karte. Ignoriere sehr kurze oder triviale Sätze. 
---
{{noteContent}}
---

EXISTIERENDE KARTEN (NICHT erneut erstellen):
---
{{existingCards}}
---`,
	basicModelName: 'Basic',
	clozeModelName: 'Lückentext',
	ollamaEnabled: false,
	ollamaEndpoint: 'http://localhost:11434/api/generate',
	ollamaModel: 'llama3',
	vaultName: '',
};
// --- ENDE: MODIFIZIERTER DEFAULT PROMPT ---


export class AnkiGeneratorSettingTab extends PluginSettingTab {
	plugin: AnkiGeneratorPlugin;

	constructor(app: App, plugin: AnkiGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Anki Generator Einstellungen' });

		// ... (Rest der Einstellungsanzeige bleibt unverändert) ...
		containerEl.createEl('h3', { text: 'Google Gemini (Primär)' });
		new Setting(containerEl).setName('Gemini API Key').addText(text => text.setPlaceholder('Gib deinen Schlüssel ein...').setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => { this.plugin.settings.geminiApiKey = value; await this.plugin.saveSettings(); }));

		containerEl.createEl('h3', { text: 'Ollama (Fallback)' });
		new Setting(containerEl).setName('Ollama als Fallback aktivieren').setDesc('Wenn Gemini nicht erreichbar ist, wird versucht, Ollama lokal zu verwenden.').addToggle((toggle: ToggleComponent) => { toggle.setValue(this.plugin.settings.ollamaEnabled).onChange(async (value) => { this.plugin.settings.ollamaEnabled = value; await this.plugin.saveSettings(); this.display(); }); });
		if (this.plugin.settings.ollamaEnabled) {
			new Setting(containerEl).setName('Ollama API Endpunkt').setDesc('Die URL deiner lokalen Ollama-Instanz.').addText(text => text.setPlaceholder('z.B. http://localhost:11434/api/generate').setValue(this.plugin.settings.ollamaEndpoint).onChange(async (value) => { this.plugin.settings.ollamaEndpoint = value; await this.plugin.saveSettings(); }));
			new Setting(containerEl).setName('Ollama Modellname').setDesc('Der Name des Modells (z.B. llama3, mistral).').addText(text => text.setPlaceholder('z.B. llama3').setValue(this.plugin.settings.ollamaModel).onChange(async (value) => { this.plugin.settings.ollamaModel = value; await this.plugin.saveSettings(); }));
		}

		containerEl.createEl('h3', { text: 'Anki' });
		new Setting(containerEl).setName('Anki Hauptdeck').addText(text => text.setPlaceholder('z.B. Medizin').setValue(this.plugin.settings.mainDeck).onChange(async (value) => { this.plugin.settings.mainDeck = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Name für Basic-Kartentyp').setDesc('Der exakte Name des "Basic" Notiztyps in Anki.').addText(text => text.setValue(this.plugin.settings.basicModelName).onChange(async (value) => { this.plugin.settings.basicModelName = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Name für Lückentext-Kartentyp').setDesc('Der exakte Name des "Cloze" / "Lückentext" Notiztyps in Anki.').addText(text => text.setValue(this.plugin.settings.clozeModelName).onChange(async (value) => { this.plugin.settings.clozeModelName = value; await this.plugin.saveSettings(); }));

		// Vault Name Einstellung
		new Setting(containerEl)
			.setName('Vault Name (Optional)')
			.setDesc('Falls Links in Anki nicht funktionieren ("undefined"), trage hier den exakten Namen deines Obsidian Vaults ein. Leer lassen für automatische Erkennung.')
			.addText(text => text
				.setPlaceholder('MeinVault')
				.setValue(this.plugin.settings.vaultName)
				.onChange(async (value) => {
					this.plugin.settings.vaultName = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Prompt' });
		new Setting(containerEl).setName('System Prompt').setDesc('Die Anweisung für die KI. {{noteContent}} und {{existingCards}} werden automatisch ersetzt.').addTextArea(text => text.setValue(this.plugin.settings.prompt).onChange(async (value) => { this.plugin.settings.prompt = value; await this.plugin.saveSettings(); }).inputEl.rows = 15);

	}
}
