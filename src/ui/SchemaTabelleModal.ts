import { App, Modal, Setting, ButtonComponent, TextAreaComponent, TextComponent, Notice } from 'obsidian';
import {
	FARBLEITERN, LeiterVerteilung, farbenFuer, findeLeiter
} from '../schema/farbleiter';
import {
	KACHEL_GROESSE, bahnschriftVerfuegbar, dateinamenFuer, gemeinsameSchriftgroesse, zeichneKachel
} from '../schema/kachelRenderer';

export type SchemaModus = 'notiz' | 'tabelle' | 'aktualisieren';

export interface SchemaEingabe {
	schemaName: string;
	/** Ueberschriften aller Spalten, inklusive Buchstabenspalte. */
	kopf: string[];
	/** Je Zeile: [Buchstabe, Spalte2, Spalte3, ...]. */
	zeilen: string[][];
	leiterId: string;
	verteilung: LeiterVerteilung;
	breite: number;
	/** Elternordner der Kachelordner, z.B. "Taktik/Schemata/Bilder". */
	ordnerBasis: string;
	ordner: string;
	hintergrund: string;
	deck: string;
}

export interface SchemaModalVorgabe extends SchemaEingabe {
	modus: SchemaModus;
	/** Nur bei 'aktualisieren': die Bedeutungsspalten sind dann gesperrt. */
	spaltenGesperrt?: boolean;
}

/**
 * Der Dialog fuer alle drei Schema-Befehle.
 *
 * Der Kern ist die Vorschau: die Kacheln werden mit demselben Code gezeichnet,
 * der sie spaeter als PNG schreibt. Was hier steht, kommt genau so in den
 * Vault – kein zweiter Renderpfad, der auseinanderlaufen kann.
 */
export class SchemaTabelleModal extends Modal {
	private daten: SchemaEingabe;
	private modus: SchemaModus;
	private spaltenGesperrt: boolean;
	private onSubmit: (eingabe: SchemaEingabe) => void;

	private vorschauEl: HTMLElement | null = null;
	private ordnerAnzeige: HTMLElement | null = null;
	private zeilenFeld: TextAreaComponent | null = null;
	private ordnerFeld: TextComponent | null = null;
	/** Sobald der Ordner von Hand geaendert wurde, zieht er dem Namen nicht mehr nach. */
	private ordnerManuell = false;
	private zeilenText = '';

	constructor(
		app: App,
		vorgabe: SchemaModalVorgabe,
		onSubmit: (eingabe: SchemaEingabe) => void
	) {
		super(app);
		this.modus = vorgabe.modus;
		this.spaltenGesperrt = vorgabe.spaltenGesperrt === true;
		this.onSubmit = onSubmit;
		this.daten = {
			schemaName: vorgabe.schemaName,
			kopf: [...vorgabe.kopf],
			zeilen: vorgabe.zeilen.map(z => [...z]),
			leiterId: vorgabe.leiterId,
			verteilung: vorgabe.verteilung,
			breite: vorgabe.breite,
			ordnerBasis: vorgabe.ordnerBasis,
			ordner: vorgabe.ordner,
			hintergrund: vorgabe.hintergrund,
			deck: vorgabe.deck
		};
		this.zeilenText = zeilenZuText(this.daten.zeilen);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('schema-modal');

		const titel = this.modus === 'aktualisieren'
			? 'Schema-Kacheln neu einfärben'
			: this.modus === 'notiz'
				? 'Schema-Notiz erstellen'
				: 'Schema-Tabelle einfügen';
		contentEl.createEl('h2', { text: titel });

		if (!bahnschriftVerfuegbar()) {
			contentEl.createDiv({
				cls: 'schema-warnung',
				text: 'Bahnschrift SemiBold ist auf diesem Gerät nicht installiert. '
					+ 'Die Kacheln werden mit einer schmalen Ersatzschrift gezeichnet.'
			});
		}

		new Setting(contentEl)
			.setName('Schema')
			.setDesc('Name des Schemas, z. B. SAMPLERS. Bestimmt Bildordner und Kartentexte.')
			.addText(text => text
				.setValue(this.daten.schemaName)
				.onChange(wert => {
					this.daten.schemaName = wert.trim();
					// Der Bildordner zieht dem Namen nach, bis jemand ihn von
					// Hand anfasst.
					if (!this.ordnerManuell) {
						const name = this.daten.schemaName || 'Schema';
						this.daten.ordner = this.daten.ordnerBasis
							? `${this.daten.ordnerBasis}/${name}`
							: name;
						this.ordnerFeld?.setValue(this.daten.ordner);
					}
					this.zeichneVorschau();
					this.ordnerAnzeige?.setText(this.daten.ordner);
				}));

		if (this.modus !== 'aktualisieren') {
			let folgeFeld: TextComponent | null = null;
			const uebernehmen = () => {
				if (!folgeFeld) return;
				this.uebernehmeFolge(folgeFeld.getValue());
				folgeFeld.setValue('');
			};
			new Setting(contentEl)
				.setName('Buchstaben übernehmen')
				.setDesc('Buchstabenfolge eintippen — legt für jeden Buchstaben eine Zeile an. '
					+ 'Bereits eingetragene Bedeutungen bleiben erhalten.')
				.addText(text => {
					folgeFeld = text;
					text.setPlaceholder('SAMPLERS');
					text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							uebernehmen();
						}
					});
				})
				.addButton(btn => btn.setButtonText('Übernehmen').onClick(uebernehmen));
		}

		// --- Zeilen ---------------------------------------------------------
		const zeilenSetting = new Setting(contentEl)
			.setName('Zeilen')
			.setDesc(this.spaltenGesperrt
				? 'Eine Zeile je Kachel. Nur die Buchstaben vor dem ersten "|" werden ausgewertet, der Rest bleibt in der Notiz stehen.'
				: 'Eine Zeile je Kachel, Spalten mit "|" getrennt: Buchstabe | Bedeutung | weitere Spalte');
		zeilenSetting.settingEl.addClass('schema-setting-breit');

		const bereich = new TextAreaComponent(contentEl);
		this.zeilenFeld = bereich;
		bereich.inputEl.addClass('schema-zeilen');
		bereich.setValue(this.zeilenText);
		bereich.setPlaceholder('S | Symptome | Beschwerden, Anzeichen einer Erkrankung\nA | Allergien | alle Allergien');
		bereich.onChange(wert => {
			this.zeilenText = wert;
			this.daten.zeilen = textZuZeilen(wert);
			this.zeichneVorschau();
		});
		if (this.spaltenGesperrt) bereich.inputEl.readOnly = true;

		if (!this.spaltenGesperrt) {
			new Setting(contentEl)
				.setName('Spaltenüberschriften')
				.setDesc('Mit Komma getrennt. Die erste Spalte enthält die Kacheln.')
				.addText(text => text
					.setValue(this.daten.kopf.join(', '))
					.onChange(wert => {
						this.daten.kopf = wert.split(',').map(s => s.trim()).filter(s => s.length > 0);
					}));
		}

		// --- Farben ---------------------------------------------------------
		const leiterSetting = new Setting(contentEl)
			.setName('Farbleiter')
			.setDesc(findeLeiter(this.daten.leiterId).beschreibung);
		leiterSetting.addDropdown(dd => {
			FARBLEITERN.forEach(l => dd.addOption(l.id, l.name));
			dd.setValue(this.daten.leiterId);
			dd.onChange(wert => {
				this.daten.leiterId = wert;
				leiterSetting.setDesc(findeLeiter(wert).beschreibung);
				this.zeichneVorschau();
			});
		});

		new Setting(contentEl)
			.setName('Verteilung')
			.setDesc('Gespreizt nutzt die ganze Leiter (8 Buchstaben = SAMPLERS). '
				+ 'Fortlaufend nimmt die ersten Farben der Reihe nach (6 Buchstaben = OPQRST).')
			.addDropdown(dd => dd
				.addOption('gespreizt', 'Gespreizt')
				.addOption('fortlaufend', 'Fortlaufend')
				.setValue(this.daten.verteilung)
				.onChange(wert => {
					this.daten.verteilung = wert as LeiterVerteilung;
					this.zeichneVorschau();
				}));

		new Setting(contentEl)
			.setName('Bildbreite in der Notiz')
			.setDesc('Der Wert hinter dem "|" im Bild-Link. Die PNGs selbst sind immer '
				+ `${KACHEL_GROESSE} × ${KACHEL_GROESSE} px.`)
			.addText(text => text
				.setValue(String(this.daten.breite))
				.onChange(wert => {
					const zahl = parseInt(wert, 10);
					if (!isNaN(zahl) && zahl > 0) this.daten.breite = zahl;
				}));

		new Setting(contentEl)
			.setName('Bildordner')
			.setDesc('Hier landen die PNGs. Gleichnamige Dateien werden überschrieben.')
			.addText(text => {
				this.ordnerFeld = text;
				text.setValue(this.daten.ordner)
					.onChange(wert => {
						this.ordnerManuell = true;
						this.daten.ordner = wert.trim();
						this.ordnerAnzeige?.setText(this.daten.ordner);
					});
			});

		if (this.modus === 'notiz') {
			new Setting(contentEl)
				.setName('Hintergrund')
				.setDesc('Ein Satz für den Callout und die Lückentext-Karte.')
				.addTextArea(text => text
					.setValue(this.daten.hintergrund)
					.setPlaceholder('Merkhilfe für die Übergabe von Traumapatienten in der Klinik')
					.onChange(wert => { this.daten.hintergrund = wert; }));

			new Setting(contentEl)
				.setName('Anki-Deck')
				.addText(text => text
					.setValue(this.daten.deck)
					.onChange(wert => { this.daten.deck = wert.trim(); }));
		}

		// --- Vorschau -------------------------------------------------------
		contentEl.createEl('h3', { text: 'Vorschau', cls: 'schema-vorschau-titel' });
		this.vorschauEl = contentEl.createDiv({ cls: 'schema-vorschau' });
		this.zeichneVorschau();

		const fuss = contentEl.createDiv({ cls: 'schema-aktionen' });
		this.ordnerAnzeige = fuss.createSpan({ cls: 'schema-ordner-anzeige', text: this.daten.ordner });
		new ButtonComponent(fuss)
			.setButtonText(this.modus === 'aktualisieren' ? 'Kacheln neu schreiben' : 'Erzeugen')
			.setCta()
			.onClick(() => {
				this.daten.zeilen = textZuZeilen(this.zeilenText);
				if (this.daten.zeilen.length === 0) {
					new Notice('Keine Zeilen angegeben.');
					return;
				}
				if (!this.daten.ordner) {
					new Notice('Kein Bildordner angegeben.');
					return;
				}
				this.close();
				this.onSubmit(this.daten);
			});
	}

	private uebernehmeFolge(folge: string) {
		const zeichen = Array.from(folge.trim()).filter(z => z.trim().length > 0);
		if (zeichen.length === 0) return;
		const vorhandene = textZuZeilen(this.zeilenText);
		this.daten.zeilen = zeichen.map((z, i) => {
			const alt = vorhandene[i];
			const rest = alt && alt[0].toUpperCase() === z.toUpperCase() ? alt.slice(1) : [];
			return [z.toUpperCase(), ...rest];
		});
		this.zeilenText = zeilenZuText(this.daten.zeilen);
		this.zeilenFeld?.setValue(this.zeilenText);
		this.zeichneVorschau();
	}

	/** Zeichnet die Kacheln so, wie sie spaeter als PNG rauskommen. */
	private zeichneVorschau() {
		if (!this.vorschauEl) return;
		this.vorschauEl.empty();

		const zeilen = textZuZeilen(this.zeilenText);
		if (zeilen.length === 0) {
			this.vorschauEl.createSpan({ cls: 'schema-vorschau-leer', text: 'Noch keine Zeilen.' });
			return;
		}

		const zeichen = zeilen.map(z => z[0]);
		const farben = farbenFuer(zeichen.length, this.daten.leiterId, this.daten.verteilung);
		const namen = dateinamenFuer(zeichen);
		// Dieselbe gemeinsame Schriftgroesse wie beim Schreiben der PNGs, nur
		// auf die Vorschaugroesse gerechnet.
		const schriftgroesse = gemeinsameSchriftgroesse(zeichen, 128);

		zeichen.forEach((z, i) => {
			const kachelEl = this.vorschauEl!.createDiv({ cls: 'schema-vorschau-kachel' });
			const canvas = zeichneKachel(z, farben[i], 128, schriftgroesse);
			canvas.addClass('schema-vorschau-bild');
			kachelEl.appendChild(canvas);
			kachelEl.createSpan({ cls: 'schema-vorschau-name', text: namen[i] });
			kachelEl.createSpan({ cls: 'schema-vorschau-hex', text: farben[i].hintergrund });
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** "S | Symptome | ..." je Zeile -> Zellen. Leere Zeilen fallen raus. */
export function textZuZeilen(text: string): string[][] {
	return text.split('\n')
		.map(z => z.trim())
		.filter(z => z.length > 0)
		.map(z => {
			const teile = z.split('|').map(t => t.trim());
			// Erste Zelle ist der Buchstabe; ohne Buchstabe hat die Zeile keine Kachel.
			if (!teile[0]) teile[0] = '?';
			return teile;
		})
		.filter(t => t[0] !== '?' || t.length > 1);
}

export function zeilenZuText(zeilen: string[][]): string {
	return zeilen.map(z => z.join(' | ')).join('\n');
}
