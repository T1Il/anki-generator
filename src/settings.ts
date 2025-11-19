import { App, PluginSettingTab, Setting, ToggleComponent, requestUrl, Notice, DropdownComponent } from 'obsidian';
import AnkiGeneratorPlugin from './main';

export interface AnkiGeneratorSettings {
	geminiApiKey: string;
	geminiModel: string;
	openAiApiKey: string;
	openAiModel: string;
	prompt: string;
	mainDeck: string;
	basicModelName: string;
	basicFrontField: string; // NEU
	basicBackField: string;  // NEU
	clozeModelName: string;
	clozeTextField: string;  // NEU
	ollamaEnabled: boolean;
	ollamaEndpoint: string;
	ollamaModel: string;
	vaultName: string;
}

// --- START: MODIFIZIERTER DEFAULT PROMPT ---
export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	geminiApiKey: '',
	geminiModel: 'gemini-1.5-pro',
	openAiApiKey: '',
	openAiModel: 'gpt-4o',
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
	basicFrontField: 'Front', // Default Englisch
	basicBackField: 'Back',   // Default Englisch
	clozeModelName: 'Lückentext', // Oft deutsch: Lückentext oder Cloze
	clozeTextField: 'Text',   // Meistens 'Text'
	ollamaEnabled: false,
	ollamaEndpoint: 'http://localhost:11434/api/generate',
	ollamaModel: 'llama3',
	vaultName: '',
};


export class AnkiGeneratorSettingTab extends PluginSettingTab {
	plugin: AnkiGeneratorPlugin;
	geminiModelDropdown: DropdownComponent | null = null;
	ollamaModelDropdown: DropdownComponent | null = null;
	openAiModelDropdown: DropdownComponent | null = null;

	constructor(app: App, plugin: AnkiGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Anki Generator Einstellungen' });

		// --- GEMINI ---
		containerEl.createEl('h3', { text: 'Google Gemini' });
		new Setting(containerEl).setName('Gemini API Key').addText(text => text.setPlaceholder('Gib deinen Schlüssel ein...').setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => { this.plugin.settings.geminiApiKey = value; await this.plugin.saveSettings(); if (this.geminiModelDropdown) await this.updateGeminiModels(value, this.geminiModelDropdown); }));
		new Setting(containerEl).setName('Gemini Modell').addDropdown(async (dropdown) => { this.geminiModelDropdown = dropdown; await this.updateGeminiModels(this.plugin.settings.geminiApiKey, dropdown); dropdown.onChange(async (value) => { this.plugin.settings.geminiModel = value; await this.plugin.saveSettings(); }); });

		// --- OPENAI ---
		containerEl.createEl('h3', { text: 'OpenAI (ChatGPT)' });
		new Setting(containerEl).setName('OpenAI API Key').addText(text => text.setPlaceholder('sk-proj-...').setValue(this.plugin.settings.openAiApiKey).onChange(async (value) => { this.plugin.settings.openAiApiKey = value; await this.plugin.saveSettings(); if (this.openAiModelDropdown) await this.updateOpenAiModels(value, this.openAiModelDropdown); }));
		new Setting(containerEl).setName('OpenAI Modell').addDropdown(async (dropdown) => { this.openAiModelDropdown = dropdown; await this.updateOpenAiModels(this.plugin.settings.openAiApiKey, dropdown); dropdown.onChange(async (value) => { this.plugin.settings.openAiModel = value; await this.plugin.saveSettings(); }); });

		// --- OLLAMA ---
		containerEl.createEl('h3', { text: 'Ollama (Lokal)' });
		new Setting(containerEl).setName('Ollama aktivieren').addToggle((toggle) => { toggle.setValue(this.plugin.settings.ollamaEnabled).onChange(async (value) => { this.plugin.settings.ollamaEnabled = value; await this.plugin.saveSettings(); this.display(); }); });
		if (this.plugin.settings.ollamaEnabled) {
			new Setting(containerEl).setName('API Endpunkt').addText(text => text.setPlaceholder('http://localhost:11434/api/generate').setValue(this.plugin.settings.ollamaEndpoint).onChange(async (value) => { this.plugin.settings.ollamaEndpoint = value; await this.plugin.saveSettings(); if (this.ollamaModelDropdown) await this.updateOllamaModels(value, this.ollamaModelDropdown); }));
			new Setting(containerEl).setName('Ollama Modell').addDropdown(async (dropdown) => { this.ollamaModelDropdown = dropdown; await this.updateOllamaModels(this.plugin.settings.ollamaEndpoint, dropdown); dropdown.onChange(async (value) => { this.plugin.settings.ollamaModel = value; await this.plugin.saveSettings(); }); });
		}

		// --- ANKI ---
		containerEl.createEl('h3', { text: 'Anki Konfiguration' });
		new Setting(containerEl).setName('Hauptdeck').addText(text => text.setValue(this.plugin.settings.mainDeck).onChange(async (value) => { this.plugin.settings.mainDeck = value; await this.plugin.saveSettings(); }));

		// Basic Settings
		new Setting(containerEl).setName('Basic Notiztyp Name').setDesc('Name des Typs in Anki (z.B. "Basic" oder "Einfach").').addText(text => text.setValue(this.plugin.settings.basicModelName).onChange(async (value) => { this.plugin.settings.basicModelName = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Basic Feldname: Frage').setDesc('Name des ersten Feldes (z.B. "Front" oder "Vorderseite").').addText(text => text.setValue(this.plugin.settings.basicFrontField).onChange(async (value) => { this.plugin.settings.basicFrontField = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Basic Feldname: Antwort').setDesc('Name des zweiten Feldes (z.B. "Back" oder "Rückseite").').addText(text => text.setValue(this.plugin.settings.basicBackField).onChange(async (value) => { this.plugin.settings.basicBackField = value; await this.plugin.saveSettings(); }));

		// Cloze Settings
		new Setting(containerEl).setName('Lückentext Notiztyp Name').setDesc('Name des Typs in Anki (z.B. "Cloze" oder "Lückentext").').addText(text => text.setValue(this.plugin.settings.clozeModelName).onChange(async (value) => { this.plugin.settings.clozeModelName = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Lückentext Feldname').setDesc('Name des Textfeldes (z.B. "Text").').addText(text => text.setValue(this.plugin.settings.clozeTextField).onChange(async (value) => { this.plugin.settings.clozeTextField = value; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName('Vault Name').addText(text => text.setValue(this.plugin.settings.vaultName).onChange(async (value) => { this.plugin.settings.vaultName = value; await this.plugin.saveSettings(); }));
		containerEl.createEl('h3', { text: 'Prompt' });
		new Setting(containerEl).addTextArea(text => text.setValue(this.plugin.settings.prompt).onChange(async (value) => { this.plugin.settings.prompt = value; await this.plugin.saveSettings(); }).inputEl.rows = 15);
	}

	async updateGeminiModels(apiKey: string, dropdown: DropdownComponent) { /* ... wie gehabt ... */
		if (!apiKey) { dropdown.addOption("", "Kein API Key"); dropdown.setDisabled(true); return; }
		try { const r = await requestUrl({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, method: 'GET' }); const o: any = {}; r.json.models?.forEach((m: any) => { if (m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent')) o[m.name.replace('models/', '')] = m.displayName || m.name; }); dropdown.selectEl.innerHTML = ''; dropdown.addOptions(o); dropdown.setDisabled(false); const c = this.plugin.settings.geminiModel; if (c && o[c]) dropdown.setValue(c); else { const f = Object.keys(o)[0]; if (f) { this.plugin.settings.geminiModel = f; dropdown.setValue(f); await this.plugin.saveSettings(); } } } catch (e) { dropdown.selectEl.innerHTML = ''; dropdown.addOption(this.plugin.settings.geminiModel, "Fehler"); }
	}
	async updateOllamaModels(endpoint: string, dropdown: DropdownComponent) { /* ... wie gehabt ... */
		if (!endpoint) { dropdown.addOption("", "Kein Endpunkt"); dropdown.setDisabled(true); return; }
		try { let u = endpoint.endsWith("/api/generate") ? endpoint.replace("/api/generate", "/api/tags") : endpoint.replace(/\/$/, "") + "/api/tags"; const r = await requestUrl({ url: u, method: 'GET' }); const o: any = {}; r.json.models?.forEach((m: any) => o[m.name] = m.name); dropdown.selectEl.innerHTML = ''; dropdown.addOptions(o); dropdown.setDisabled(false); const c = this.plugin.settings.ollamaModel; if (c && o[c]) dropdown.setValue(c); else { const f = Object.keys(o)[0]; if (f) { this.plugin.settings.ollamaModel = f; dropdown.setValue(f); await this.plugin.saveSettings(); } } } catch (e) { dropdown.selectEl.innerHTML = ''; dropdown.addOption(this.plugin.settings.ollamaModel, "Fehler"); }
	}
	async updateOpenAiModels(apiKey: string, dropdown: DropdownComponent) { /* ... wie gehabt ... */
		if (!apiKey) { dropdown.addOption("", "Kein API Key"); dropdown.setDisabled(true); return; }
		try { const r = await requestUrl({ url: 'https://api.openai.com/v1/models', method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } }); const o: any = {}; r.json.data?.filter((m: any) => m.id.startsWith('gpt')).sort((a: any, b: any) => b.created - a.created).forEach((m: any) => o[m.id] = m.id); dropdown.selectEl.innerHTML = ''; dropdown.addOptions(o); dropdown.setDisabled(false); const c = this.plugin.settings.openAiModel; if (c && o[c]) dropdown.setValue(c); else { const d = 'gpt-4o'; if (o[d]) { this.plugin.settings.openAiModel = d; dropdown.setValue(d); } else { const f = Object.keys(o)[0]; if (f) { this.plugin.settings.openAiModel = f; dropdown.setValue(f); } } await this.plugin.saveSettings(); } } catch (e) { dropdown.selectEl.innerHTML = ''; dropdown.addOption(this.plugin.settings.openAiModel || 'gpt-4o', "Fehler"); }
	}
}
