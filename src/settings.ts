import { App, PluginSettingTab, Setting, DropdownComponent, TextAreaComponent, Notice } from 'obsidian';
import AnkiGeneratorPlugin from './main';
import { t } from './lang/helpers';
import { IconPickerModal } from './ui/IconPickerModal';
import { PROVIDERS, PROVIDER_ORDER } from './providers';
import { AiProvider } from './types';

export interface AnkiGeneratorSettings {
	vaultName: string;
	enableFeedback: boolean;
	aiProvider: string;
	geminiApiKey: string;
	geminiModel: string;
	openAiApiKey: string;
	openAiModel: string;
	claudeApiKey: string;
	claudeModel: string;
	claudeEffort: string;
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
	folderDecorations: boolean;
	enableManualMode: boolean;
	iconSynced: string;
	iconUnsynced: string;
	iconEmpty: string;
	iconIgnored: string;
	decorationTemplate: string;
	maxRetries: number;
	ignoredFiles: string[];
}

/**
 * Repariert einen historisch beschaedigten gespeicherten Prompt.
 *
 * In data.json aelterer Installationen ist beim Speichern roher Quelltext
 * mitgewandert: der Wert laeuft ueber die Feldgrenze hinaus und endet mit
 * ' `,\n\tfeedbackPrompt: `Du bist ein erfahrener Tutor...'.
 * Darin steht unter anderem 'Erstelle KEINE Karteikarten hier' - sobald jemand
 * useCustomPrompt einschaltet, bekommt das Modell diese Anweisung und erzeugt
 * keine Karten mehr. Das sieht dann nach Modellversagen aus.
 *
 * Gibt den bereinigten Prompt zurueck oder null, wenn nichts zu tun ist.
 */
export function repairCorruptedPrompt(prompt: unknown): string | null {
	if (typeof prompt !== 'string' || !prompt) return null;

	// Backtick, Komma, Zeilenumbruch, danach ein JS-Feldname mit Doppelpunkt.
	const match = prompt.match(/`\s*,\s*[\r\n]+\s*[A-Za-z_$][\w$]*\s*:/);
	if (!match || match.index === undefined) return null;

	const repaired = prompt.substring(0, match.index).trimEnd();
	// Nur uebernehmen, wenn danach noch ein brauchbarer Prompt uebrig bleibt.
	return repaired.length > 50 ? repaired : null;
}

export const DEFAULT_SETTINGS: AnkiGeneratorSettings = {
	vaultName: 'My Vault',
	enableFeedback: false,
	aiProvider: 'gemini',
	geminiApiKey: '',
	geminiModel: 'gemini-1.5-flash',
	openAiApiKey: '',
	openAiModel: 'gpt-4o',
	claudeApiKey: '',
	claudeModel: 'claude-opus-5',
	claudeEffort: 'low',
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
5. **KONTEXT PFLICHT**: Jede Frage (Q:) muss so formuliert sein, dass sie auch OHNE den Kontext der Notiz verständlich ist. 
   - Nenne IMMER das Thema/Titel der Notiz in der Frage.
   - ⛔️ Falsch: "Wie lautet die Dosierung?"
   - ✅ Richtig: "Wie lautet die Dosierung von [Titel]?" (oder dynamisch eingebaut).


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

3. **Lückentexte (Cloze)**:In 
   - Nutze Lückentexte NUR für einzelne Sätze im 'Q:'-Feld.
   - ⛔️ **VERBOTEN**: Verstecke NIEMALS das Subjekt einer Definition ("Was ist die Aufgabe von {{c1::X}}?").
     - FALSCH: "Was ist die Aufgabe von {{c1::T-Helferzellen}}?" (Fragt nach Unbekanntem)
     - RICHTIG: "Welche Zelle ist für die Opsonierung zuständig? -> {{c1::T-Helferzelle}}"
   - Ein Satz = Eine Karte.
   - KEINE Lücken in der Antwort (A:).

4. **Bilder**:
   - Kopiere Bild-Links (![[bild.png]]) exakt in das 'A:' Feld.
   - **Vermeide 'Visualisiere...' in der Frage (Q:)!**
   - Stattdessen: Frage konkret nach dem Inhalt, der auf dem Bild zu sehen ist.
   - Beispiel:
     - ⛔️ Falsch: "Visualisiere die Übersicht zu X."
     - ✅ Richtig: "Zeige die Übersicht zu X." oder "Nenne die Risikofaktoren für X."

5. **Verlinkungen (ESSENTIELL)**:
   - Deine Aufgabe ist es, Schlüsselbegriffe im Text mit vorhandenen Block-IDs zu verknüpfen.
   - **VORGEHEN**:
     1. Finde einen Begriff in der Frage (Q) oder Antwort (A), für den eine Block-ID (z.B. \`^12345\`) existiert.
     2. **ERSETZE** diesen Begriff im Text durch den Wikilink: \`[[#^id|Begriff]]\`.
     3. Der Link muss **INLINE** sein, also direkt im Satzfluss stehen.
   - **REGELN**:
     - ⛔️ **NIEMALS** Links isoliert ans Ende der Karte hängen.
     - ⛔️ **NIEMALS** die Block-ID ohne Alias verwenden (\`[[#^id]]\` ist FALSCH).
   - **BEISPIELE**:
     - *Text*: "Der Thalamus ist wichtig." + *ID*: \`^thal1\`
     - ⛔️ Falsch: "Der Thalamus ist wichtig. [[#^thal1]]"
     - ✅ Richtig: "Der [[#^thal1|Thalamus]] ist wichtig."
   - Falls keine Überschrift/Block-ID in der AKTUELLEN Notiz passt, verlinke auf die aktuelle Notiz selbst: \`[Schlagwort]({{noteURI}})\`.
   - ⛔️ **NIEMALS** \`[[NotizName]](obsidian://...)\` kombinieren — entweder \`[[NotizName]]\` ODER \`[Text](URL)\`, aber nicht beides gleichzeitig.
   - Verlinkungen auf andere Notizen (\`[[AndereNotiz]]\`) bleiben als Wikilinks unverändert.

Hier ist der Lerninhalt:
{{noteContent}}

Bestehende Karten (vermeide Duplikate):
{{existingCards}}`,
	feedbackPrompt: `Analysiere den folgenden Lerninhalt (Aufschrieb) auf Vollständigkeit, Struktur und Verständlichkeit. 
Das Feedback soll kurz sein, ausschließlich inhaltlich und auf die Präklinik (Rettungsdienst) bezogen sein.

WICHTIG FÜR KORREKTUREN:
Wenn du eine konkrete Änderung vorschlägst, gib sie im unten beschriebenen
anki-edit- bzw. anki-card-Format aus - nur so lässt sie sich per Klick übernehmen.
Reine Zitatblöcke (> Zitat) helfen nicht weiter.

Gib konstruktives Feedback und Verbesserungsvorschläge zum Inhalt selbst.
	
Hier ist der Lerninhalt:
{{noteContent}}`,
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
	fileDecorations: false,
	folderDecorations: true,
	enableManualMode: false,
	iconSynced: '✅',
	iconUnsynced: '🔴',
	iconEmpty: '🗃️',
	iconIgnored: '👁️‍🗨️',
	decorationTemplate: ' {count}',
	maxRetries: 3,
	ignoredFiles: []
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

		// --- General Settings ---
		new Setting(containerEl)
			.setName('Vault Name')
			.setDesc('Name of your Obsidian Vault (used for links). If empty, auto-detection is attempted.')
			.addText(text => text
				.setPlaceholder('My Vault')
				.setValue(this.plugin.settings.vaultName)
				.onChange(async (value) => {
					this.plugin.settings.vaultName = value;
					await this.plugin.saveSettings();
				}));

		// --- AI Provider Settings ---
		containerEl.createEl('h3', { text: 'AI Provider Settings' });

		new Setting(containerEl)
			.setName('AI Provider')
			.setDesc('Select the AI provider to use')
			.addDropdown(dropdown => dropdown
				.addOptions(PROVIDER_ORDER.reduce((acc: Record<string, string>, id) => {
					acc[id] = PROVIDERS[id].label;
					return acc;
				}, {}))
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
					await this.updateModelDropdown('gemini', dropdown, this.plugin.settings.geminiModel,
						(v) => { this.plugin.settings.geminiModel = v; });
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
					await this.updateModelDropdown('openai', dropdown, this.plugin.settings.openAiModel,
						(v) => { this.plugin.settings.openAiModel = v; });
					dropdown.onChange(async (value) => {
						this.plugin.settings.openAiModel = value;
						await this.plugin.saveSettings();
					});
				});
		} else if (this.plugin.settings.aiProvider === 'claude') {
			new Setting(containerEl)
				.setName(t('settings.claudeApiKey'))
				.setDesc(t('settings.claudeApiKeyDesc'))
				.addText(text => text
					.setPlaceholder('sk-ant-...')
					.setValue(this.plugin.settings.claudeApiKey)
					.onChange(async (value) => {
						this.plugin.settings.claudeApiKey = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(t('settings.claudeModel'))
				.setDesc(t('settings.claudeModelDesc'))
				.addDropdown(async (dropdown) => {
					await this.updateModelDropdown('claude', dropdown, this.plugin.settings.claudeModel,
						(v) => { this.plugin.settings.claudeModel = v; });
					dropdown.onChange(async (value) => {
						this.plugin.settings.claudeModel = value;
						await this.plugin.saveSettings();
					});
				});

			new Setting(containerEl)
				.setName(t('settings.claudeEffort'))
				.setDesc(t('settings.claudeEffortDesc'))
				.addDropdown(dropdown => dropdown
					.addOption('low', 'Niedrig')
					.addOption('medium', 'Mittel')
					.addOption('high', 'Hoch')
					.setValue(this.plugin.settings.claudeEffort || 'low')
					.onChange(async (value) => {
						this.plugin.settings.claudeEffort = value;
						await this.plugin.saveSettings();
					}));
		} else if (this.plugin.settings.aiProvider === 'ollama') {
			new Setting(containerEl)
				.setName(t('settings.ollamaEnable'))
				.setDesc(t('settings.ollamaEnableDesc'))
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.ollamaEnabled)
					.onChange(async (value) => {
						this.plugin.settings.ollamaEnabled = value;
						await this.plugin.saveSettings();
					}));

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
					await this.updateModelDropdown('ollama', dropdown, this.plugin.settings.ollamaModel,
						(v) => { this.plugin.settings.ollamaModel = v; });
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
					this.display(); // Refresh to show/hide sub-settings
				}));

		if (this.plugin.settings.fileDecorations) {
			new Setting(containerEl)
				.setName(t('settings.folderDecorations'))
				.setDesc(t('settings.folderDecorationsDesc'))
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.folderDecorations)
					.onChange(async (value) => {
						this.plugin.settings.folderDecorations = value;
						await this.plugin.saveSettings();
						if (this.plugin.ankiFileDecorationProvider) {
							this.plugin.ankiFileDecorationProvider.triggerUpdate();
						}
					}));

			this.addDecorationSettings(containerEl);
		}

		new Setting(containerEl)
			.setName('Manueller Modus bei Fehler')
			.setDesc('Wenn aktiviert, wird bei API-Fehlern (z.B. Überlastung) oder Timeouts ein Popup angezeigt, mit dem du den Prompt kopieren und die Antwort manuell einfügen kannst.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableManualMode)
				.onChange(async (value) => {
					this.plugin.settings.enableManualMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Maximale Wiederholungen bei Fehler')
			.setDesc('Wie oft soll bei einem 503 Fehler (Überlastung) automatisch erneut versucht werden, bevor der manuelle Modus (falls aktiviert) greift?')
			.addText(text => text
				.setValue(String(this.plugin.settings.maxRetries))
				.onChange(async (value) => {
					const val = parseInt(value);
					if (!isNaN(val) && val >= 0) {
						this.plugin.settings.maxRetries = val;
						await this.plugin.saveSettings();
					}
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

	/** Minimal nötige Konfiguration, um überhaupt eine Modell-Liste abrufen zu können. */
	private canFetchModels(id: AiProvider): boolean {
		const s = this.plugin.settings;
		switch (id) {
			case 'gemini': return !!s.geminiApiKey;
			case 'openai': return !!s.openAiApiKey;
			case 'claude': return !!s.claudeApiKey;
			case 'ollama': return !!s.ollamaEndpoint;
			default: return false;
		}
	}

	/**
	 * Befüllt ein Modell-Dropdown aus der Provider-Registry.
	 * Ersetzt die früheren drei fast identischen updateXModels-Methoden.
	 */
	async updateModelDropdown(
		id: AiProvider,
		dropdown: DropdownComponent,
		current: string,
		apply: (value: string) => void
	) {
		if (!this.canFetchModels(id)) {
			dropdown.addOption(current || '', id === 'ollama' ? 'Kein Endpunkt' : 'Kein API Key');
			dropdown.setDisabled(true);
			return;
		}

		try {
			const options = await PROVIDERS[id].fetchModels(this.plugin.settings);
			dropdown.selectEl.empty();

			if (Object.keys(options).length === 0) {
				dropdown.addOption(current || '', 'Keine Modelle gefunden');
				dropdown.setDisabled(true);
				return;
			}

			dropdown.addOptions(options);
			dropdown.setDisabled(false);

			if (current && options[current]) {
				dropdown.setValue(current);
			} else {
				const first = Object.keys(options)[0];
				if (first) {
					apply(first);
					dropdown.setValue(first);
					await this.plugin.saveSettings();
				}
			}
		} catch (e) {
			console.error(`Modell-Liste für ${id} konnte nicht geladen werden:`, e);
			dropdown.selectEl.empty();
			dropdown.addOption(current || '', 'Fehler beim Laden');
			dropdown.setDisabled(true);
		}
	}

	addDecorationSettings(containerEl: HTMLElement) {
		containerEl.createEl('h4', { text: 'Decoration Icons' });

		const addIconSetting = (name: string, desc: string, key: 'iconSynced' | 'iconUnsynced' | 'iconEmpty' | 'iconIgnored') => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText(text => text
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value;
						await this.plugin.saveSettings();
					}))
				.addButton(btn => btn
					.setButtonText('Pick Icon')
					.onClick(() => {
						new IconPickerModal(this.app, async (icon) => {
							this.plugin.settings[key] = icon;
							await this.plugin.saveSettings();
							this.display(); // Refresh to show new value
						}).open();
					}));
		};

		addIconSetting('Synced Icon', 'Icon shown when all cards are synced', 'iconSynced');
		addIconSetting('Unsynced Icon', 'Icon shown when there are unsynced cards', 'iconUnsynced');
		addIconSetting('Empty Icon', 'Icon shown when block exists but has no recognized cards', 'iconEmpty');
		addIconSetting('Ignored Icon', 'Icon shown when file is explicitly ignored from folder stats', 'iconIgnored');

		containerEl.createEl('h4', { text: 'Label Format' });
		new Setting(containerEl)
			.setName('Decoration Label Template')
			.setDesc('Format string for the text next to the icon. Placeholders: {count} (total cards), {synced}, {unsynced}. Leave empty for no text.')
			.addText(text => text
				.setPlaceholder(' {count}')
				.setValue(this.plugin.settings.decorationTemplate)
				.onChange(async (value) => {
					this.plugin.settings.decorationTemplate = value;
					await this.plugin.saveSettings();
				}));
	}
}