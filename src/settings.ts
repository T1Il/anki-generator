import { App, PluginSettingTab, Setting, ToggleComponent, requestUrl, Notice, DropdownComponent } from 'obsidian';
import AnkiGeneratorPlugin from './main';

export interface AnkiGeneratorSettings {
	geminiApiKey: string;
	geminiModel: string;
	openAiApiKey: string; // NEU
	openAiModel: string;  // NEU
	prompt: string;
	mainDeck: string;
	basicModelName: string;
	clozeModelName: string;
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
	clozeModelName: 'Lückentext',
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

		new Setting(containerEl)
			.setName('Gemini API Key')
			.setDesc('Benötigt für die Verbindung zu Google Gemini.')
			.addText(text => text
				.setPlaceholder('Gib deinen Schlüssel ein...')
				.setValue(this.plugin.settings.geminiApiKey)
				.onChange(async (value) => {
					this.plugin.settings.geminiApiKey = value;
					await this.plugin.saveSettings();
					if (this.geminiModelDropdown) {
						await this.updateGeminiModels(value, this.geminiModelDropdown);
					}
				}));

		new Setting(containerEl)
			.setName('Gemini Modell')
			.setDesc('Wähle das Gemini-Modell. Die Liste wird automatisch geladen, wenn ein gültiger API-Key vorhanden ist.')
			.addDropdown(async (dropdown) => {
				this.geminiModelDropdown = dropdown;
				await this.updateGeminiModels(this.plugin.settings.geminiApiKey, dropdown);
				dropdown.onChange(async (value) => {
					this.plugin.settings.geminiModel = value;
					await this.plugin.saveSettings();
				});
			});

		// --- OPENAI (NEU) ---
		containerEl.createEl('h3', { text: 'OpenAI (ChatGPT)' });

		new Setting(containerEl)
			.setName('OpenAI API Key')
			.setDesc('Benötigt für ChatGPT (gpt-4o, etc.).')
			.addText(text => text
				.setPlaceholder('sk-proj-...')
				.setValue(this.plugin.settings.openAiApiKey)
				.onChange(async (value) => {
					this.plugin.settings.openAiApiKey = value;
					await this.plugin.saveSettings();
					if (this.openAiModelDropdown) {
						await this.updateOpenAiModels(value, this.openAiModelDropdown);
					}
				}));

		new Setting(containerEl)
			.setName('OpenAI Modell')
			.setDesc('Modell wählen. Wird automatisch geladen.')
			.addDropdown(async (dropdown) => {
				this.openAiModelDropdown = dropdown;
				await this.updateOpenAiModels(this.plugin.settings.openAiApiKey, dropdown);
				dropdown.onChange(async (value) => {
					this.plugin.settings.openAiModel = value;
					await this.plugin.saveSettings();
				});
			});

		// --- OLLAMA ---
		containerEl.createEl('h3', { text: 'Ollama (Lokal)' });

		new Setting(containerEl)
			.setName('Ollama als Fallback aktivieren')
			.setDesc('Wenn Gemini nicht erreichbar ist, wird versucht, Ollama lokal zu verwenden.')
			.addToggle((toggle: ToggleComponent) => {
				toggle.setValue(this.plugin.settings.ollamaEnabled)
					.onChange(async (value) => {
						this.plugin.settings.ollamaEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.ollamaEnabled) {
			new Setting(containerEl)
				.setName('Ollama API Endpunkt')
				.setDesc('Die URL deiner lokalen Ollama-Instanz (Standard: http://localhost:11434/api/generate).')
				.addText(text => text
					.setPlaceholder('z.B. http://localhost:11434/api/generate')
					.setValue(this.plugin.settings.ollamaEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.ollamaEndpoint = value;
						await this.plugin.saveSettings();
						if (this.ollamaModelDropdown) {
							await this.updateOllamaModels(value, this.ollamaModelDropdown);
						}
					}));

			new Setting(containerEl)
				.setName('Ollama Modell')
				.setDesc('Wähle das lokal verfügbare Modell. Stelle sicher, dass Ollama läuft.')
				.addDropdown(async (dropdown) => {
					this.ollamaModelDropdown = dropdown;
					await this.updateOllamaModels(this.plugin.settings.ollamaEndpoint, dropdown);
					dropdown.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
					});
				});
		}

		// --- ANKI ---
		containerEl.createEl('h3', { text: 'Anki' });
		new Setting(containerEl).setName('Anki Hauptdeck').addText(text => text.setPlaceholder('z.B. Medizin').setValue(this.plugin.settings.mainDeck).onChange(async (value) => { this.plugin.settings.mainDeck = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Name für Basic-Kartentyp').setDesc('Der exakte Name des "Basic" Notiztyps in Anki.').addText(text => text.setValue(this.plugin.settings.basicModelName).onChange(async (value) => { this.plugin.settings.basicModelName = value; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Name für Lückentext-Kartentyp').setDesc('Der exakte Name des "Cloze" / "Lückentext" Notiztyps in Anki.').addText(text => text.setValue(this.plugin.settings.clozeModelName).onChange(async (value) => { this.plugin.settings.clozeModelName = value; await this.plugin.saveSettings(); }));

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

	async updateGeminiModels(apiKey: string, dropdown: DropdownComponent) {
		if (!apiKey) {
			dropdown.addOption("", "Kein API Key gesetzt");
			dropdown.setDisabled(true);
			return;
		}

		try {
			const response = await requestUrl({
				url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
				method: 'GET'
			});

			const modelsData = response.json;
			if (!modelsData.models) throw new Error("Keine Modelle in Antwort gefunden");

			const options: Record<string, string> = {};
			modelsData.models.forEach((model: any) => {
				if (model.name.includes('gemini') && model.supportedGenerationMethods && model.supportedGenerationMethods.includes('generateContent')) {
					const modelId = model.name.replace('models/', '');
					options[modelId] = model.displayName || modelId;
				}
			});

			dropdown.selectEl.innerHTML = '';
			dropdown.addOptions(options);
			dropdown.setDisabled(false);

			const currentSettingsModel = this.plugin.settings.geminiModel;
			if (currentSettingsModel && options[currentSettingsModel]) {
				dropdown.setValue(currentSettingsModel);
			} else {
				const firstModel = Object.keys(options)[0];
				if (firstModel) {
					this.plugin.settings.geminiModel = firstModel;
					dropdown.setValue(firstModel);
					await this.plugin.saveSettings();
				}
			}
		} catch (e) {
			console.error("Fehler beim Laden der Gemini Modelle:", e);
			dropdown.selectEl.innerHTML = '';
			dropdown.addOption(this.plugin.settings.geminiModel || 'gemini-1.5-pro', `Fehler (Aktuell: ${this.plugin.settings.geminiModel})`);
		}
	}

	async updateOllamaModels(endpoint: string, dropdown: DropdownComponent) {
		if (!endpoint) {
			dropdown.addOption("", "Kein Endpunkt gesetzt");
			dropdown.setDisabled(true);
			return;
		}

		try {
			let tagsUrl = "";
			if (endpoint.endsWith("/api/generate")) {
				tagsUrl = endpoint.replace("/api/generate", "/api/tags");
			} else if (endpoint.endsWith("/")) {
				tagsUrl = endpoint + "api/tags";
			} else {
				tagsUrl = endpoint + "/api/tags";
			}

			const response = await requestUrl({
				url: tagsUrl,
				method: 'GET'
			});

			const data = response.json;

			if (!data.models) throw new Error("Keine Modelle gefunden");

			const options: Record<string, string> = {};
			data.models.forEach((model: any) => {
				options[model.name] = model.name;
			});

			dropdown.selectEl.innerHTML = '';
			dropdown.addOptions(options);
			dropdown.setDisabled(false);

			const currentModel = this.plugin.settings.ollamaModel;
			if (currentModel && options[currentModel]) {
				dropdown.setValue(currentModel);
			} else {
				const firstModel = Object.keys(options)[0];
				if (firstModel) {
					this.plugin.settings.ollamaModel = firstModel;
					dropdown.setValue(firstModel);
					await this.plugin.saveSettings();
				}
			}

		} catch (e) {
			console.error("Fehler beim Laden der Ollama Modelle:", e);
			dropdown.selectEl.innerHTML = '';
			dropdown.addOption(this.plugin.settings.ollamaModel || 'llama3', `Verbindungsfehler (Aktuell: ${this.plugin.settings.ollamaModel})`);
		}
	}

	// NEU: OpenAI Modelle laden
	async updateOpenAiModels(apiKey: string, dropdown: DropdownComponent) {
		if (!apiKey) {
			dropdown.addOption("", "Kein API Key gesetzt");
			dropdown.setDisabled(true);
			return;
		}

		try {
			const response = await requestUrl({
				url: 'https://api.openai.com/v1/models',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${apiKey}`
				}
			});

			const data = response.json;
			const options: Record<string, string> = {};

			// Filtern nach GPT Modellen und Sortieren nach Erstellungsdatum (neueste zuerst)
			const models = data.data
				.filter((m: any) => m.id.startsWith('gpt'))
				.sort((a: any, b: any) => b.created - a.created);

			models.forEach((m: any) => {
				options[m.id] = m.id;
			});

			dropdown.selectEl.innerHTML = '';
			dropdown.addOptions(options);
			dropdown.setDisabled(false);

			const current = this.plugin.settings.openAiModel;
			if (current && options[current]) {
				dropdown.setValue(current);
			} else {
				// Versuche gpt-4o als Standard, sonst das erste
				const defaultModel = 'gpt-4o';
				if (options[defaultModel]) {
					this.plugin.settings.openAiModel = defaultModel;
					dropdown.setValue(defaultModel);
				} else {
					const first = Object.keys(options)[0];
					if (first) {
						this.plugin.settings.openAiModel = first;
						dropdown.setValue(first);
					}
				}
				await this.plugin.saveSettings();
			}

		} catch (e) {
			console.error("Fehler beim Laden der OpenAI Modelle:", e);
			dropdown.selectEl.innerHTML = '';
			dropdown.addOption(this.plugin.settings.openAiModel || 'gpt-4o', `Fehler (Aktuell: ${this.plugin.settings.openAiModel})`);
		}
	}
}
