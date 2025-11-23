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
	ollamaEnabled: boolean;
	ollamaEndpoint: string;
	ollamaModel: string;
	mainDeck: string;
	basicModel: string;
	basicFront: string;
	basicBack: string;
	typeInModel: string;
	typeInFront: string;
	typeInBack: string;
	clozeModel: string;
	clozeText: string;
	useCustomPrompt: boolean;
	prompt: string;
	useCustomFeedbackPrompt: boolean;
	feedbackPrompt: string;
	language: string;
}

export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	vaultName: 'My Vault',
	enableFeedback: false,
	aiProvider: 'gemini',
	geminiApiKey: '',
	geminiModel: 'gemini-1.5-flash',
	openAiApiKey: '',
	openAiModel: 'gpt-4o',
	ollamaEnabled: false,
	ollamaEndpoint: 'http://localhost:11434',
	ollamaModel: 'llama3',
	mainDeck: 'Default',
	basicModel: 'Basic',
	basicFront: 'Front',
	basicBack: 'Back',
	typeInModel: 'Basic (type in the answer)',
	typeInFront: 'Front',
	typeInBack: 'Back',
	clozeModel: 'Cloze',
	clozeText: 'Text',
	useCustomPrompt: false,
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

2. **Lückentexte (Cloze)**:
   - Nutze Lückentexte NUR für einzelne Sätze im 'Q:'-Feld.
   - Ein Satz = Eine Karte.
   - KEINE Lücken in der Antwort (A:).

3. **Bilder**:
   - Kopiere Bild-Links (![[bild.png]]) exakt in das 'A:' Feld.

Hier ist der Lerninhalt:
{{noteContent}}

Bestehende Karten (vermeide Duplikate):
{{existingCards}}`,
	useCustomFeedbackPrompt: false,
	feedbackPrompt: `Du bist ein erfahrener Tutor. Analysiere den folgenden Lerninhalt und gib kurzes, konstruktives Feedback basierend auf wissenschaftlichen Lernprinzipien (z.B. Klarheit, Struktur, fehlende Schlüsselkonzepte) und lege besonderen Fokus auf die inhaltliche Korrektheit und mögliche Ergänzungen, die für die Präklinik (Rettungsdienst) sinnvoll sein könnten.
WICHTIG: Das Feedback MUSS auf DEUTSCH sein.
Halte das Feedback präzise (2-3 Sätze).
Erstelle KEINE Karteikarten hier, nur den Feedback-Text.

Notiz Inhalt:
"""
{{noteContent}}
"""`,
	language: 'de'
}

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

		// General Settings
		containerEl.createEl('h3', { text: t('settings.general') });

		new Setting(containerEl)
			.setName(t('settings.vaultName'))
			.addText(text => text
				.setValue(this.plugin.settings.vaultName)
				.onChange(async (value) => {
					this.plugin.settings.vaultName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('settings.enableFeedback'))
			.setDesc(t('settings.enableFeedbackDesc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableFeedback)
				.onChange(async (value) => {
					this.plugin.settings.enableFeedback = value;
					await this.plugin.saveSettings();
				}));

		// AI Provider
		new Setting(containerEl)
			.setName(t('settings.aiProvider'))
			.addDropdown(dropdown => dropdown
				.addOption('gemini', 'Google Gemini')
				.addOption('openai', 'OpenAI')
				.addOption('ollama', t('settings.ollama'))
				.setValue(this.plugin.settings.aiProvider)
				.onChange(async (value) => {
					this.plugin.settings.aiProvider = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show relevant settings
				}));

		// Gemini Settings
		if (this.plugin.settings.aiProvider === 'gemini') {
			new Setting(containerEl)
				.setName(t('settings.geminiApiKey'))
				.addText(text => text
					.setPlaceholder('API Key')
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(t('settings.geminiModel'))
				.addDropdown(async (dropdown) => {
					await this.updateGeminiModels(this.plugin.settings.geminiApiKey, dropdown);
					dropdown.onChange(async (value) => {
						this.plugin.settings.geminiModel = value;
						await this.plugin.saveSettings();
					});
				});
		}

		// OpenAI Settings
		if (this.plugin.settings.aiProvider === 'openai') {
			new Setting(containerEl)
				.setName(t('settings.openAiApiKey'))
				.addText(text => text
					.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.openAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openAiApiKey = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(t('settings.openAiModel'))
				.addDropdown(async (dropdown) => {
					await this.updateOpenAiModels(this.plugin.settings.openAiApiKey, dropdown);
					dropdown.onChange(async (value) => {
						this.plugin.settings.openAiModel = value;
						await this.plugin.saveSettings();
					});
				});
		}

		// Ollama Settings
		if (this.plugin.settings.aiProvider === 'ollama') {
			new Setting(containerEl)
				.setName(t('settings.ollamaEndpoint'))
				.addText(text => text
					.setPlaceholder('http://localhost:11434')
					.setValue(this.plugin.settings.ollamaEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.ollamaEndpoint = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(t('settings.ollamaModel'))
				.addDropdown(async (dropdown) => {
					await this.updateOllamaModels(this.plugin.settings.ollamaEndpoint, dropdown);
					dropdown.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
					});
				});
		}

		// Anki Configuration
		containerEl.createEl('h3', { text: t('settings.ankiConfig') });

		new Setting(containerEl)
			.setName(t('settings.mainDeck'))
			.addText(text => text
				.setValue(this.plugin.settings.mainDeck)
				.onChange(async (value) => {
					this.plugin.settings.mainDeck = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('settings.basicModel'))
			.setDesc(t('settings.basicModelDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.basicModel)
				.onChange(async (value) => {
					this.plugin.settings.basicModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('settings.basicFront'))
			.setDesc(t('settings.basicFrontDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.basicFront)
				.onChange(async (value) => {
					this.plugin.settings.basicFront = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('settings.basicBack'))
			.setDesc(t('settings.basicBackDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.basicBack)
				.onChange(async (value) => {
					this.plugin.settings.basicBack = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Type-In Model')
			.setDesc('Anki-Modell für Type-In Karten (z.B. "Basic (type in the answer)")')
			.addText(text => text
				.setValue(this.plugin.settings.typeInModel)
				.onChange(async (value) => {
					this.plugin.settings.typeInModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Type-In Front Field')
			.setDesc('Name des Front-Feldes im Type-In Modell')
			.addText(text => text
				.setValue(this.plugin.settings.typeInFront)
				.onChange(async (value) => {
					this.plugin.settings.typeInFront = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Type-In Back Field')
			.setDesc('Name des Back-Feldes im Type-In Modell')
			.addText(text => text
				.setValue(this.plugin.settings.typeInBack)
				.onChange(async (value) => {
					this.plugin.settings.typeInBack = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('settings.clozeModel'))
			.setDesc(t('settings.clozeModelDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.clozeModel)
				.onChange(async (value) => {
					this.plugin.settings.clozeModel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('settings.clozeText'))
			.setDesc(t('settings.clozeTextDesc'))
			.addText(text => text
				.setValue(this.plugin.settings.clozeText)
				.onChange(async (value) => {
					this.plugin.settings.clozeText = value;
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