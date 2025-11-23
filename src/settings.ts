import { App, PluginSettingTab, Setting, ToggleComponent, requestUrl, Notice, DropdownComponent, TextAreaComponent } from 'obsidian';
import AnkiGeneratorPlugin from './main';

export interface AnkiGeneratorSettings {
	geminiApiKey: string;
	geminiModel: string;
	openAiApiKey: string;
	openAiModel: string;
	prompt: string;
	feedbackPrompt: string;
	mainDeck: string;
	basicModelName: string;
	basicFrontField: string;
	basicBackField: string;
	clozeModelName: string;
	clozeTextField: string;
	ollamaEnabled: boolean;
	ollamaEndpoint: string;
	ollamaModel: string;
	vaultName: string;
	enableFeedback: boolean;
}

export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	geminiApiKey: '',
	geminiModel: 'gemini-1.5-pro',
	openAiApiKey: '',
	openAiModel: 'gpt-4o',
	mainDeck: 'Obsidian',
	prompt: `Du bist ein Assistent, der Lerninhalte in Anki-Karteikarten umwandelt. Deine einzige Aufgabe ist es, die formatierten Karten zu erstellen. Gib auf KEINEN FALL, NIEMALS einleitenden oder abschließenden Text aus. Deine Ausgabe MUSS *direkt* mit \`Q:\` oder dem Satz für den Lückentext beginnen und darf NUR die Karten enthalten. KEINERLEI zusätzlichen Text.

Erstelle aus dem folgenden Text Anki-Karteikarten. 
Wenn du Fragen erstellst, die Teile von Listen abfragen, nutze Lückentexte (Cloze Deletions), um den Kontext zu bewahren.
Nutze Basic-Karten (Frage/Antwort) für Definitionen oder klare Konzepte.
Halte die Fragen und Antworten präzise und kurz.

Formatierung:
Für Basic-Karten:
Q: [Frage]
A: [Antwort]

Für Lückentext-Karten:
[Satz mit {{c1::Lücke}}]

Beispiel Output:
Q: Was ist die Hauptstadt von Deutschland?
A: Berlin

Der Mensch hat {{c1::46}} Chromosomen.

Hier ist der Text:
{{noteContent}}

Berücksichtige auch diese bestehenden Karten, um Duplikate zu vermeiden:
{{existingCards}}`,
	feedbackPrompt: `Du bist ein erfahrener Tutor. Analysiere den folgenden Lerninhalt und gib kurzes, konstruktives Feedback basierend auf wissenschaftlichen Lernprinzipien (z.B. Klarheit, Struktur, fehlende Schlüsselkonzepte).
WICHTIG: Das Feedback MUSS auf DEUTSCH sein.
Halte das Feedback präzise (2-3 Sätze).
Erstelle KEINE Karteikarten hier, nur den Feedback-Text.

Notiz Inhalt:
"""
{{noteContent}}
"""`,
	basicModelName: 'Basic',
	basicFrontField: 'Front',
	basicBackField: 'Back',
	clozeModelName: 'Lückentext',
	clozeTextField: 'Text',
	ollamaEnabled: false,
	ollamaEndpoint: 'http://localhost:11434/api/generate',
	ollamaModel: 'llama3',
	vaultName: '',
	enableFeedback: true
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

		// --- 1. GENERAL SETTINGS ---
		containerEl.createEl('h3', { text: 'Allgemein' });
		new Setting(containerEl).setName('Vault Name').addText(text => text.setValue(this.plugin.settings.vaultName).onChange(async (value) => { this.plugin.settings.vaultName = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName('AI Feedback aktivieren')
			.setDesc('Wenn aktiviert, gibt die AI nach der Kartengenerierung kurzes Feedback zum Lerninhalt.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableFeedback)
				.onChange(async (value) => {
					this.plugin.settings.enableFeedback = value;
					await this.plugin.saveSettings();
				}));

		// --- 2. AI PROVIDER SETTINGS ---
		const aiDetails = containerEl.createEl('details');
		aiDetails.style.marginBottom = '1em';
		aiDetails.createEl('summary', { text: 'AI Provider', cls: 'settings-summary' }).style.cursor = 'pointer';
		const aiContainer = aiDetails.createDiv();

		// Gemini
		aiContainer.createEl('h4', { text: 'Google Gemini' });
		new Setting(aiContainer).setName('Gemini API Key').addText(text => text.setPlaceholder('Gib deinen Schlüssel ein...').setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => { this.plugin.settings.geminiApiKey = value; await this.plugin.saveSettings(); if (this.geminiModelDropdown) await this.updateGeminiModels(value, this.geminiModelDropdown); }));
		new Setting(aiContainer).setName('Gemini Modell').addDropdown(async (dropdown) => { this.geminiModelDropdown = dropdown; await this.updateGeminiModels(this.plugin.settings.geminiApiKey, dropdown); dropdown.onChange(async (value) => { this.plugin.settings.geminiModel = value; await this.plugin.saveSettings(); }); });

		// OpenAI
		aiContainer.createEl('h4', { text: 'OpenAI (ChatGPT)' });
		new Setting(aiContainer).setName('OpenAI API Key').addText(text => text.setPlaceholder('sk-proj-...').setValue(this.plugin.settings.openAiApiKey).onChange(async (value) => { this.plugin.settings.openAiApiKey = value; await this.plugin.saveSettings(); if (this.openAiModelDropdown) await this.updateOpenAiModels(value, this.openAiModelDropdown); }));
		new Setting(aiContainer).setName('OpenAI Modell').addDropdown(async (dropdown) => { this.openAiModelDropdown = dropdown; await this.updateOpenAiModels(this.plugin.settings.openAiApiKey, dropdown); dropdown.onChange(async (value) => { this.plugin.settings.openAiModel = value; await this.plugin.saveSettings(); }); });

		// Ollama
		aiContainer.createEl('h4', { text: 'Ollama (Lokal)' });
		new Setting(aiContainer).setName('Ollama aktivieren').addToggle((toggle) => { toggle.setValue(this.plugin.settings.ollamaEnabled).onChange(async (value) => { this.plugin.settings.ollamaEnabled = value; await this.plugin.saveSettings(); this.display(); }); });
		if (this.plugin.settings.ollamaEnabled) {
			new Setting(aiContainer).setName('API Endpunkt').addText(text => text.setPlaceholder('http://localhost:11434/api/generate').setValue(this.plugin.settings.ollamaEndpoint).onChange(async (value) => { this.plugin.settings.ollamaEndpoint = value; await this.plugin.saveSettings(); if (this.ollamaModelDropdown) await this.updateOllamaModels(value, this.ollamaModelDropdown); }));
			new Setting(aiContainer).setName('Ollama Modell').addDropdown(async (dropdown) => { this.ollamaModelDropdown = dropdown; await this.updateOllamaModels(this.plugin.settings.ollamaEndpoint, dropdown); dropdown.onChange(async (value) => { this.plugin.settings.ollamaModel = value; await this.plugin.saveSettings(); }); });
		}

		// --- 3. ANKI CONFIGURATION ---
		const ankiDetails = containerEl.createEl('details');
		ankiDetails.style.marginBottom = '1em';
		ankiDetails.createEl('summary', { text: 'Anki Konfiguration', cls: 'settings-summary' }).style.cursor = 'pointer';
		const ankiContainer = ankiDetails.createDiv();

		new Setting(ankiContainer).setName('Hauptdeck').addText(text => text.setValue(this.plugin.settings.mainDeck).onChange(async (value) => { this.plugin.settings.mainDeck = value; await this.plugin.saveSettings(); }));

		// Basic Settings
		new Setting(ankiContainer).setName('Basic Notiztyp Name').setDesc('Name des Typs in Anki (z.B. "Basic" oder "Einfach").').addText(text => text.setValue(this.plugin.settings.basicModelName).onChange(async (value) => { this.plugin.settings.basicModelName = value; await this.plugin.saveSettings(); }));
		new Setting(ankiContainer).setName('Basic Feldname: Frage').setDesc('Name des ersten Feldes (z.B. "Front" oder "Vorderseite").').addText(text => text.setValue(this.plugin.settings.basicFrontField).onChange(async (value) => { this.plugin.settings.basicFrontField = value; await this.plugin.saveSettings(); }));
		new Setting(ankiContainer).setName('Basic Feldname: Antwort').setDesc('Name des zweiten Feldes (z.B. "Back" oder "Rückseite").').addText(text => text.setValue(this.plugin.settings.basicBackField).onChange(async (value) => { this.plugin.settings.basicBackField = value; await this.plugin.saveSettings(); }));

		// Cloze Settings
		new Setting(ankiContainer).setName('Lückentext Notiztyp Name').setDesc('Name des Typs in Anki (z.B. "Cloze" oder "Lückentext").').addText(text => text.setValue(this.plugin.settings.clozeModelName).onChange(async (value) => { this.plugin.settings.clozeModelName = value; await this.plugin.saveSettings(); }));
		new Setting(ankiContainer).setName('Lückentext Feldname').setDesc('Name des Textfeldes (z.B. "Text").').addText(text => text.setValue(this.plugin.settings.clozeTextField).onChange(async (value) => { this.plugin.settings.clozeTextField = value; await this.plugin.saveSettings(); }));

		// --- 4. PROMPTS ---
		const promptDetails = containerEl.createEl('details');
		promptDetails.style.marginBottom = '1em';
		promptDetails.createEl('summary', { text: 'Prompts', cls: 'settings-summary' }).style.cursor = 'pointer';
		const promptContainer = promptDetails.createDiv();

		this.renderFullWidthTextArea(
			promptContainer,
			'Karten-Generierung Prompt',
			'Der Prompt für die Erstellung der Karteikarten. Platzhalter: {{noteContent}}, {{existingCards}}',
			this.plugin.settings.prompt,
			async (value) => { this.plugin.settings.prompt = value; await this.plugin.saveSettings(); },
			12
		);

		this.renderFullWidthTextArea(
			promptContainer,
			'Feedback Prompt',
			'Der Prompt für das AI Feedback. Platzhalter: {{noteContent}}',
			this.plugin.settings.feedbackPrompt,
			async (value) => { this.plugin.settings.feedbackPrompt = value; await this.plugin.saveSettings(); },
			6
		);
	}

	renderFullWidthTextArea(container: HTMLElement, title: string, desc: string, value: string, onChange: (v: string) => Promise<void>, rows: number = 5) {
		const div = container.createDiv({ cls: 'setting-item' });
		div.style.display = 'block'; // Vertical layout
		div.style.paddingTop = '10px';
		div.style.paddingBottom = '10px';

		const info = div.createDiv({ cls: 'setting-item-info' });
		info.style.marginBottom = '10px';
		info.createEl('div', { text: title, cls: 'setting-item-name' });
		const descEl = info.createEl('div', { text: desc, cls: 'setting-item-description' });
		descEl.style.marginBottom = '5px';

		const control = div.createDiv({ cls: 'setting-item-control' });
		control.style.width = '100%';

		const textArea = new TextAreaComponent(control);
		textArea.setValue(value);
		textArea.onChange(onChange);
		textArea.inputEl.rows = rows;
		textArea.inputEl.style.width = '100%';
		textArea.inputEl.style.maxWidth = '100%'; // Ensure it doesn't overflow
		textArea.inputEl.style.minHeight = '100px';
	}

	async updateGeminiModels(apiKey: string, dropdown: DropdownComponent) {
		if (!apiKey) { dropdown.addOption("", "Kein API Key"); dropdown.setDisabled(true); return; }
		try { const r = await requestUrl({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, method: 'GET' }); const o: any = {}; r.json.models?.forEach((m: any) => { if (m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent')) o[m.name.replace('models/', '')] = m.displayName || m.name; }); dropdown.selectEl.innerHTML = ''; dropdown.addOptions(o); dropdown.setDisabled(false); const c = this.plugin.settings.geminiModel; if (c && o[c]) dropdown.setValue(c); else { const f = Object.keys(o)[0]; if (f) { this.plugin.settings.geminiModel = f; dropdown.setValue(f); await this.plugin.saveSettings(); } } } catch (e) { dropdown.selectEl.innerHTML = ''; dropdown.addOption(this.plugin.settings.geminiModel, "Fehler"); }
	}
	async updateOllamaModels(endpoint: string, dropdown: DropdownComponent) {
		if (!endpoint) { dropdown.addOption("", "Kein Endpunkt"); dropdown.setDisabled(true); return; }
		try { let u = endpoint.endsWith("/api/generate") ? endpoint.replace("/api/generate", "/api/tags") : endpoint.replace(/\/$/, "") + "/api/tags"; const r = await requestUrl({ url: u, method: 'GET' }); const o: any = {}; r.json.models?.forEach((m: any) => o[m.name] = m.name); dropdown.selectEl.innerHTML = ''; dropdown.addOptions(o); dropdown.setDisabled(false); const c = this.plugin.settings.ollamaModel; if (c && o[c]) dropdown.setValue(c); else { const f = Object.keys(o)[0]; if (f) { this.plugin.settings.ollamaModel = f; dropdown.setValue(f); await this.plugin.saveSettings(); } } } catch (e) { dropdown.selectEl.innerHTML = ''; dropdown.addOption(this.plugin.settings.ollamaModel, "Fehler"); }
	}
	async updateOpenAiModels(apiKey: string, dropdown: DropdownComponent) {
		if (!apiKey) { dropdown.addOption("", "Kein API Key"); dropdown.setDisabled(true); return; }
		try { const r = await requestUrl({ url: 'https://api.openai.com/v1/models', method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } }); const o: any = {}; r.json.data?.filter((m: any) => m.id.startsWith('gpt')).sort((a: any, b: any) => b.created - a.created).forEach((m: any) => o[m.id] = m.id); dropdown.selectEl.innerHTML = ''; dropdown.addOptions(o); dropdown.setDisabled(false); const c = this.plugin.settings.openAiModel; if (c && o[c]) dropdown.setValue(c); else { const d = 'gpt-4o'; if (o[d]) { this.plugin.settings.openAiModel = d; dropdown.setValue(d); } else { const f = Object.keys(o)[0]; if (f) { this.plugin.settings.openAiModel = f; dropdown.setValue(f); } } await this.plugin.saveSettings(); } } catch (e) { dropdown.selectEl.innerHTML = ''; dropdown.addOption(this.plugin.settings.openAiModel || 'gpt-4o', "Fehler"); }
	}
}
