import { App, PluginSettingTab, Setting, DropdownComponent, TextAreaComponent, requestUrl, Notice } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { t } from './lang/helpers';

export interface AnkiGeneratorSettings {
	vaultName: string;
	enableFeedback: boolean;
	aiProvider: string;
	geminiApiKey: string;
	geminiModel: string;
	openAiApiKey: string;
	openAiModel: string;
	ollamaEndpoint: string;
	ollamaModel: string;
	ollamaEnabled: boolean;
	prompt: string;
	feedbackPrompt: string;
	useCustomPrompt: boolean;
	useCustomFeedbackPrompt: boolean;
	mainDeck: string;
	basicModel: string;
	basicFront: string;
	basicBack: string;
	clozeModel: string;
	clozeText: string;
	typeInModel: string;
	typeInFront: string;
	typeInBack: string;
	fileDecorations: boolean;
}

export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	vaultName: 'My Vault',
	enableFeedback: false,
	aiProvider: 'gemini',
	geminiApiKey: '',
	geminiModel: 'gemini-1.5-flash',
	openAiApiKey: '',
	openAiModel: 'gpt-4o',
	ollamaEndpoint: 'http://localhost:11434',
	ollamaModel: 'llama3',
	ollamaEnabled: false,
	prompt: `Du bist ein Assistent, der Lerninhalte in Anki-Karteikarten umwandelt. 
Deine Aufgabe ist es, präzise, atomare und KURZE Karten zu erstellen.

FORMATIERUNG - STRIKT EINHALTEN:
1. Jede Karte MUSS mit 'Q:' beginnen.
2. Trennung durch Leerzeile.
3. NIEMALS Lückentext-Syntax in 'A:' verwenden.
4. NIEMALS Listen in mehrere 'Q:' Zeilen aufsplitten.

⛔️ FALSCH (Antwort wird zerrissen):
Q: Welche Medikamente?
A: Folgende gehören dazu:
Q: - {{c1::Medikament A}}
Q: - {{c1::Medikament B}}

✅ RICHTIG (Alles in einer Karte):
Q: Welche Medikamente gehören dazu?
A: - Medikament A
- Medikament B

REGELN ZUR KARTENERSTELLUNG:

1. **Listen und Aufzählungen (Basic Karten)**:
   - Fasse Listen IMMER in EINER Karte zusammen.
   - Die Antwort (A:) ist eine Markdown-Liste.
   - Nutze KEINE Lückentexte für Listenpunkte.

2. **Eintipp-Karten (Type-In)**:
   - Nutze dies für kurze, präzise Fakten, die exakt reproduziert werden müssen (z.B. Vitalwerte, Dosierungen, Formeln, Jahreszahlen).
   - Format: 'A (type):' statt 'A:'.
   - Beispiel:
     Q: Normalwert Herzfrequenz Erwachsene?
     A (type): 60-100 bpm

3. **Lückentexte (Cloze)**:
   - Nutze Lückentexte NUR für einzelne Sätze im 'Q:'-Feld.
   - Ein Satz = Eine Karte.
   - KEINE Lücken in der Antwort (A:).

4. **Bilder**:
   - Kopiere Bild-Links (![[bild.png]]) exakt in das 'A:' Feld.

Hier ist der Lerninhalt:
{{noteContent}}

Bestehende Karten (vermeide Duplikate):
{{existingCards}}`,
	feedbackPrompt: `Analysiere den folgenden Lerninhalt (Aufschrieb) auf Vollständigkeit, Struktur und Verständlichkeit. Das Feedback soll kurz sein, ausschließlich inhaltlich und auf die Präklinik (Rettungsdienst) bezogen sein. Gib konstruktives Feedback und Verbesserungsvorschläge zum Inhalt selbst, nicht zu den daraus generierten Karten.`,
	useCustomPrompt: false,
	useCustomFeedbackPrompt: false,
	mainDeck: 'Default',
	basicModel: 'Basic',
	basicFront: 'Front',
	basicBack: 'Back',
	clozeModel: 'Cloze',
	clozeText: 'Text',
	typeInModel: 'Basic (Type in the answer)',
	typeInFront: 'Front',
	typeInBack: 'Back',
	fileDecorations: false
};

export class AnkiGeneratorSettingTab extends PluginSettingTab {
	plugin: AnkiGeneratorPlugin;

	constructor(app: App, plugin: AnkiGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: t('settings.title') });

		// --- AI Provider Settings ---
		containerEl.createEl('h3', { text: 'AI Provider Settings' });

		new Setting(containerEl)
			.setName('AI Provider')
			.setDesc('Select the AI provider to use')
			.addDropdown(dropdown => dropdown
				.addOption('gemini', 'Google Gemini')
				.addOption('openai', 'OpenAI')
				.addOption('ollama', 'Ollama (Local)')
				.setValue(this.plugin.settings.aiProvider)
				.onChange(async (value) => {
					this.plugin.settings.aiProvider = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.aiProvider === 'gemini') {
			new Setting(containerEl)
				.setName(t('settings.geminiApiKey'))
				.setDesc(t('settings.geminiApiKeyDesc'))
				.addText(text => text
					.setPlaceholder('Enter your API Key')
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(t('settings.geminiModel'))
				.setDesc(t('settings.geminiModelDesc'))
				.addDropdown(async (dropdown) => {
					await this.updateGeminiModels(this.plugin.settings.geminiApiKey, dropdown);
					dropdown.onChange(async (value) => {
						this.plugin.settings.geminiModel = value;
						await this.plugin.saveSettings();
					});
				});
		} else if (this.plugin.settings.aiProvider === 'openai') {
			new Setting(containerEl)
				.setName('OpenAI API Key')
				.setDesc('Enter your OpenAI API Key')
				.addText(text => text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.openAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openAiApiKey = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('OpenAI Model')
				.setDesc('Select the OpenAI model')
				.addDropdown(async (dropdown) => {
					await this.updateOpenAiModels(this.plugin.settings.openAiApiKey, dropdown);
					dropdown.onChange(async (value) => {
						this.plugin.settings.openAiModel = value;
						await this.plugin.saveSettings();
					});
				});
		} else if (this.plugin.settings.aiProvider === 'ollama') {
			new Setting(containerEl)
				.setName('Ollama Endpoint')
				.setDesc('Enter your Ollama endpoint (e.g. http://localhost:11434)')
				.addText(text => text
					.setPlaceholder('http://localhost:11434')
					.setValue(this.plugin.settings.ollamaEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.ollamaEndpoint = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Ollama Model')
				.setDesc('Select the Ollama model')
				.addDropdown(async (dropdown) => {
					await this.updateOllamaModels(this.plugin.settings.ollamaEndpoint, dropdown);
					dropdown.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName(t('settings.fileDecorations'))
			.setDesc(t('settings.fileDecorationsDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.fileDecorations)
				.onChange(async (value) => {
					this.plugin.settings.fileDecorations = value;
					await this.plugin.saveSettings();
					new Notice("Bitte Plugin neu laden, um Änderungen anzuwenden.");
				}));

		// --- Anki Settings ---
		containerEl.createEl('h3', { text: t('settings.ankiConfig') });

		new Setting(containerEl)
			.setName('Standard Deck')
			.setDesc('Das Standard-Deck, in das neue Karten importiert werden.')
			.addText(text => text
				.setValue(this.plugin.settings.mainDeck)
				.onChange(async (value) => {
					this.plugin.settings.mainDeck = value;
					await this.plugin.saveSettings();
				}));

		// Basic Model
		new Setting(containerEl)
			.setName('Basic Note Type')
			.setDesc('Name des Notiztyps für Basic-Karten in Anki')
			.addText(text => text
				.setValue(this.plugin.settings.basicModel)
				.onChange(async (value) => {
					this.plugin.settings.basicModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Basic Front Field')
			.setDesc('Name des Feldes für die Vorderseite')
			.addText(text => text
				.setValue(this.plugin.settings.basicFront)
				.onChange(async (value) => {
					this.plugin.settings.basicFront = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Basic Back Field')
			.setDesc('Name des Feldes für die Rückseite')
			.addText(text => text
				.setValue(this.plugin.settings.basicBack)
				.onChange(async (value) => {
					this.plugin.settings.basicBack = value;
					await this.plugin.saveSettings();
				}));

		// Cloze Model
		new Setting(containerEl)
			.setName('Cloze Note Type')
			.setDesc('Name des Notiztyps für Lückentext-Karten in Anki')
			.addText(text => text
				.setValue(this.plugin.settings.clozeModel)
				.onChange(async (value) => {
					this.plugin.settings.clozeModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Cloze Text Field')
			.setDesc('Name des Text-Feldes für Lückentexte')
			.addText(text => text
				.setValue(this.plugin.settings.clozeText)
				.onChange(async (value) => {
					this.plugin.settings.clozeText = value;
					await this.plugin.saveSettings();
				}));

		// Type-In Model
		new Setting(containerEl)
			.setName('Type-In Note Type')
			.setDesc('Name des Notiztyps für Eintipp-Karten in Anki')
			.addText(text => text
				.setValue(this.plugin.settings.typeInModel)
				.onChange(async (value) => {
					this.plugin.settings.typeInModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Type-In Front Field')
			.setDesc('Name des Feldes für die Vorderseite (Type-In)')
			.addText(text => text
				.setValue(this.plugin.settings.typeInFront)
				.onChange(async (value) => {
					this.plugin.settings.typeInFront = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Type-In Back Field')
			.setDesc('Name des Feldes für die Rückseite (Type-In)')
			.addText(text => text
				.setValue(this.plugin.settings.typeInBack)
				.onChange(async (value) => {
					this.plugin.settings.typeInBack = value;
					await this.plugin.saveSettings();
				}));

		// Prompts
		containerEl.createEl('h3', { text: t('settings.prompts') });

		new Setting(containerEl)
			.setName(t('settings.useCustomPrompt'))
			.setDesc(t('settings.useCustomPromptDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useCustomPrompt)
				.onChange(async (value) => {
					this.plugin.settings.useCustomPrompt = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.useCustomPrompt) {
			this.renderFullWidthTextArea(
				containerEl,
				t('settings.cardPrompt'),
				t('settings.cardPromptDesc'),
				this.plugin.settings.prompt,
				async (value) => {
					this.plugin.settings.prompt = value;
					await this.plugin.saveSettings();
				},
				10
			);
		}

		new Setting(containerEl)
			.setName(t('settings.useCustomFeedbackPrompt'))
			.setDesc(t('settings.useCustomFeedbackPromptDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useCustomFeedbackPrompt)
				.onChange(async (value) => {
					this.plugin.settings.useCustomFeedbackPrompt = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.useCustomFeedbackPrompt) {
			this.renderFullWidthTextArea(
				containerEl,
				t('settings.feedbackPrompt'),
				t('settings.feedbackPromptDesc'),
				this.plugin.settings.feedbackPrompt,
				async (value) => {
					this.plugin.settings.feedbackPrompt = value;
					await this.plugin.saveSettings();
				},
				5
			);
		}
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