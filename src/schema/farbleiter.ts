/**
 * Farbleitern fuer Schema-Kacheln.
 *
 * Die bestehenden Schemata im Vault (SAMPLERS, OPQRST, xABCDE, ...) benutzen
 * alle dieselbe Leiter: die Office-Standardfarben von Rot ueber Gelb und Gruen
 * bis Dunkelblau. Genau die ist hier als `regenbogen` hinterlegt, damit neue
 * Tabellen neben den alten nicht auffallen.
 *
 * Zwischenwerte werden in OKLab interpoliert, nicht in sRGB. In sRGB laeuft
 * z.B. Gelb -> Blau durch ein schmutziges Grau; OKLab haelt die Mitte sauber
 * und die Helligkeit gleichmaessig verteilt.
 */

export interface Kachelfarbe {
	/** Hintergrund als #RRGGBB. */
	hintergrund: string;
	/** Schriftfarbe, immer #000000 oder #FFFFFF. */
	schrift: string;
}

export type LeiterVerteilung = 'gespreizt' | 'fortlaufend';

export interface Farbleiter {
	id: string;
	name: string;
	beschreibung: string;
	/** Stuetzstellen der Leiter, von Anfang bis Ende. */
	stuetzen: string[];
}

/**
 * Office-Standardfarben. Reihenfolge und Werte stammen aus den vorhandenen
 * Bildern: SAMPLERS nutzt alle acht, OPQRST die ersten sechs.
 */
export const OFFICE_REGENBOGEN = [
	'#FF0000', // Rot
	'#FFC000', // Orange
	'#FFFF00', // Gelb
	'#92D050', // Hellgruen
	'#00B050', // Gruen
	'#00B0F0', // Hellblau
	'#0070C0', // Blau
	'#002060'  // Dunkelblau
];

export const FARBLEITERN: Farbleiter[] = [
	{
		id: 'regenbogen',
		name: 'Regenbogen (Office)',
		beschreibung: 'Rot → Gelb → Grün → Dunkelblau. Wie SAMPLERS und OPQRST.',
		stuetzen: OFFICE_REGENBOGEN
	},
	{
		id: 'ampel',
		name: 'Ampel',
		beschreibung: 'Grün → Gelb → Rot. Für Schemata mit steigender Dringlichkeit.',
		stuetzen: ['#00B050', '#92D050', '#FFFF00', '#FFC000', '#FF0000']
	},
	{
		id: 'ozean',
		name: 'Ozean',
		beschreibung: 'Türkis → Blau → Dunkelblau. Ruhig, gut lesbar.',
		stuetzen: ['#7FE8D8', '#00B0F0', '#0070C0', '#1F2E7A']
	},
	{
		id: 'warm',
		name: 'Warm',
		beschreibung: 'Sand → Orange → Rot → Bordeaux.',
		stuetzen: ['#FFE08A', '#FFB020', '#F26419', '#D01C1C', '#7A1030']
	},
	{
		id: 'violett',
		name: 'Violett',
		beschreibung: 'Flieder → Magenta → Violett → Indigo.',
		stuetzen: ['#F3C6F2', '#E056D0', '#9B30D9', '#5B2AB0', '#2B1B6B']
	},
	{
		id: 'sonnenuntergang',
		name: 'Sonnenuntergang',
		beschreibung: 'Gelb → Orange → Rot → Pflaume → Nachtblau.',
		stuetzen: ['#FFE066', '#FFA630', '#F0534B', '#B4327E', '#4A2A6B']
	},
	{
		id: 'wald',
		name: 'Wald',
		beschreibung: 'Frischgrün → Blattgrün → Tannengrün. Ruhig, ohne Signalwirkung.',
		stuetzen: ['#E4EF7A', '#9CCC65', '#4CAF50', '#2E7D5B', '#1B4B45']
	},
	{
		id: 'erde',
		name: 'Erde',
		beschreibung: 'Sand → Ocker → Lehm → Kaffee. Warm und gedeckt.',
		stuetzen: ['#F2DFC0', '#DDAA6B', '#B77A44', '#7E5030', '#43291B']
	},
	{
		id: 'stahl',
		name: 'Stahl',
		beschreibung: 'Ein einziger Blauton von hell nach dunkel. Am zurückhaltendsten.',
		stuetzen: ['#E3ECF5', '#A9C2D9', '#6E8FB0', '#3E5C7E', '#1C2E45']
	},
	{
		id: 'neon',
		name: 'Neon',
		beschreibung: 'Giftgrün → Türkis → Blau → Violett → Pink. Sehr auffällig.',
		stuetzen: ['#4DFF3A', '#00F5D4', '#00BBF9', '#9B5DE5', '#F15BB5']
	},
	{
		id: 'pastell',
		name: 'Pastell',
		beschreibung: 'Durchweg helle Töne, alle mit schwarzer Schrift. Leise.',
		stuetzen: ['#FFD6E0', '#FFEFB5', '#C7F0BD', '#B5E2FF', '#DCC9F5']
	},
	{
		id: 'kontrast',
		name: 'Maximaler Kontrast',
		beschreibung: 'Kräftige Einzelfarben statt Verlauf – für Schemata, deren Buchstaben nichts miteinander zu tun haben.',
		stuetzen: ['#FF0000', '#FFC000', '#FFFF00', '#00B050', '#00B0F0', '#0070C0', '#B14FD8', '#8B5A2B']
	}
];

export function findeLeiter(id: string): Farbleiter {
	return FARBLEITERN.find(l => l.id === id) || FARBLEITERN[0];
}

// --- Farbmathematik ---------------------------------------------------------

interface Rgb { r: number; g: number; b: number; }
interface OkLab { L: number; a: number; b: number; }

export function hexZuRgb(hex: string): Rgb {
	const h = hex.replace('#', '').trim();
	const voll = h.length === 3
		? h.split('').map(c => c + c).join('')
		: h;
	return {
		r: parseInt(voll.substring(0, 2), 16),
		g: parseInt(voll.substring(2, 4), 16),
		b: parseInt(voll.substring(4, 6), 16)
	};
}

export function rgbZuHex(c: Rgb): string {
	const teil = (v: number) => {
		const h = Math.max(0, Math.min(255, Math.round(v))).toString(16).toUpperCase();
		return h.length < 2 ? '0' + h : h;
	};
	return `#${teil(c.r)}${teil(c.g)}${teil(c.b)}`;
}

function srgbZuLinear(v: number): number {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearZuSrgb(v: number): number {
	const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
	return c * 255;
}

function rgbZuOkLab(c: Rgb): OkLab {
	const r = srgbZuLinear(c.r);
	const g = srgbZuLinear(c.g);
	const b = srgbZuLinear(c.b);

	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

	return {
		L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
	};
}

function okLabZuRgb(c: OkLab): Rgb {
	const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
	const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
	const s_ = c.L - 0.0894841775 * c.a - 1.2914855480 * c.b;

	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;

	return {
		r: linearZuSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		g: linearZuSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		b: linearZuSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
	};
}

/** WCAG-Relativhelligkeit, fuer die Entscheidung Schrift schwarz oder weiss. */
function relativeHelligkeit(c: Rgb): number {
	return 0.2126 * srgbZuLinear(c.r)
		+ 0.7152 * srgbZuLinear(c.g)
		+ 0.0722 * srgbZuLinear(c.b);
}

function kontrast(a: Rgb, b: Rgb): number {
	const ha = relativeHelligkeit(a);
	const hb = relativeHelligkeit(b);
	const hell = Math.max(ha, hb);
	const dunkel = Math.min(ha, hb);
	return (hell + 0.05) / (dunkel + 0.05);
}

const SCHWARZ: Rgb = { r: 0, g: 0, b: 0 };

/**
 * SCHWARZ IST DIE REGEL, WEISS DIE AUSNAHME.
 *
 * In den vorhandenen Bildern ist genau eine Kachel weiss beschriftet:
 * das dunkelblaue S2 von SAMPLERS (#002060). Alle anderen, auch das
 * mittelblaue #0070C0, tragen schwarze Schrift. Ein reiner
 * "nimm den besseren Kontrast"-Vergleich wuerde bei #0070C0 schon zu Weiss
 * kippen (Kontrast zu Schwarz 3.1, zu Weiss 6.8) und die Leiter mitten im
 * Blau umspringen lassen.
 *
 * Deshalb: Weiss nur, wenn Schwarz unter 3.0 faellt – dann ist es wirklich
 * nicht mehr lesbar. Das reproduziert die bestehende Aufteilung exakt.
 */
const SCHWARZ_UNTERGRENZE = 3.0;

export function schriftfarbeFuer(hintergrund: string): string {
	const bg = hexZuRgb(hintergrund);
	return kontrast(bg, SCHWARZ) >= SCHWARZ_UNTERGRENZE ? '#000000' : '#FFFFFF';
}

/** Ein Punkt auf der Leiter, t zwischen 0 und 1. */
export function leiterfarbeBei(stuetzen: string[], t: number): string {
	if (stuetzen.length === 0) return '#808080';
	if (stuetzen.length === 1) return stuetzen[0];

	const geklemmt = Math.max(0, Math.min(1, t));
	const position = geklemmt * (stuetzen.length - 1);
	const unten = Math.floor(position);
	const oben = Math.min(stuetzen.length - 1, unten + 1);
	const anteil = position - unten;

	if (anteil === 0) return stuetzen[unten].toUpperCase();

	const a = rgbZuOkLab(hexZuRgb(stuetzen[unten]));
	const b = rgbZuOkLab(hexZuRgb(stuetzen[oben]));
	return rgbZuHex(okLabZuRgb({
		L: a.L + (b.L - a.L) * anteil,
		a: a.a + (b.a - a.a) * anteil,
		b: a.b + (b.b - a.b) * anteil
	}));
}

/**
 * Die fertigen Farben fuer `anzahl` Kacheln.
 *
 * `gespreizt` verteilt die Kacheln ueber die ganze Leiter – die erste
 * Kachel bekommt den Anfang, die letzte das Ende. Bei acht Buchstaben und der
 * Office-Leiter kommt damit exakt SAMPLERS heraus.
 *
 * `fortlaufend` nimmt stattdessen die ersten `anzahl` Stuetzstellen, solange
 * es genug gibt – bei sechs Buchstaben also exakt OPQRST. Reichen die
 * Stuetzstellen nicht, faellt es auf `gespreizt` zurueck.
 */
export function farbenFuer(
	anzahl: number,
	leiterOderId: Farbleiter | string,
	verteilung: LeiterVerteilung = 'gespreizt'
): Kachelfarbe[] {
	// Eine gewuerfelte Leiter hat keine Id, unter der man sie wiederfinden
	// koennte – sie wird deshalb als ganzes Objekt durchgereicht.
	const leiter = typeof leiterOderId === 'string' ? findeLeiter(leiterOderId) : leiterOderId;
	if (anzahl <= 0 || leiter.stuetzen.length === 0) return [];

	const hintergruende: string[] = [];
	if (verteilung === 'fortlaufend' && anzahl <= leiter.stuetzen.length) {
		for (let i = 0; i < anzahl; i++) hintergruende.push(leiter.stuetzen[i].toUpperCase());
	} else if (anzahl === 1) {
		hintergruende.push(leiter.stuetzen[0].toUpperCase());
	} else {
		for (let i = 0; i < anzahl; i++) {
			hintergruende.push(leiterfarbeBei(leiter.stuetzen, i / (anzahl - 1)));
		}
	}

	return hintergruende.map(hg => ({ hintergrund: hg, schrift: schriftfarbeFuer(hg) }));
}

// --- Gewuerfelte Leitern ----------------------------------------------------

/**
 * OKLCh statt OKLab: L bleibt die Helligkeit, C wird zur Buntheit und h zum
 * Farbton auf dem Farbkreis. Nur so laesst sich "derselbe Farbton, nur
 * dunkler" oder "vierzig Grad weiter" ueberhaupt formulieren.
 */
function okLchZuRgb(L: number, C: number, hGrad: number): Rgb {
	const bogen = (hGrad * Math.PI) / 180;
	return okLabZuRgb({ L, a: C * Math.cos(bogen), b: C * Math.sin(bogen) });
}

function ausserhalbDarstellbar(c: Rgb): boolean {
	// Kleine Toleranz, sonst gilt schon Rundungsrauschen als Ueberlauf.
	const raus = (v: number) => v < -0.5 || v > 255.5;
	return raus(c.r) || raus(c.g) || raus(c.b);
}

/**
 * Farbe aus OKLCh, notfalls entsaettigt.
 *
 * Nicht jede Kombination aus Helligkeit und Buntheit existiert in sRGB –
 * ein knalliges Gelb bei 30 % Helligkeit gibt es schlicht nicht. Wuerde man
 * einfach abschneiden, kaeme ein verfaerbter, flauer Ton heraus und der
 * Farbton verschoebe sich. Stattdessen wird die Buntheit so weit
 * zurueckgenommen, bis die Farbe wieder darstellbar ist; der Farbton bleibt
 * dabei erhalten.
 */
export function okLchZuHex(L: number, C: number, hGrad: number): string {
	let hoch = C;
	let tief = 0;
	if (!ausserhalbDarstellbar(okLchZuRgb(L, hoch, hGrad))) {
		return rgbZuHex(okLchZuRgb(L, hoch, hGrad));
	}
	// Zwoelf Halbierungen reichen fuer deutlich feiner als einen 8-Bit-Schritt.
	for (let i = 0; i < 12; i++) {
		const mitte = (tief + hoch) / 2;
		if (ausserhalbDarstellbar(okLchZuRgb(L, mitte, hGrad))) hoch = mitte;
		else tief = mitte;
	}
	return rgbZuHex(okLchZuRgb(L, tief, hGrad));
}

/** Die Formen, in denen eine gewuerfelte Leiter ueber den Farbkreis laeuft. */
interface Verlaufsform {
	name: string;
	/** Wie weit der Farbton insgesamt wandert, in Grad. */
	spanne: number;
}

const VERLAUFSFORMEN: Verlaufsform[] = [
	{ name: 'einfarbig', spanne: 0 },
	{ name: 'benachbart', spanne: 45 },
	{ name: 'weit', spanne: 100 },
	{ name: 'gegenüber', spanne: 170 },
	{ name: 'Regenbogen', spanne: 280 }
];

/** Deutscher Name des Farbtons, damit die gewuerfelte Leiter nicht "Zufall 3" heisst. */
function farbtonName(hGrad: number): string {
	const namen: [number, string][] = [
		[20, 'Rot'], [50, 'Orange'], [95, 'Gelb'], [140, 'Grün'],
		[190, 'Türkis'], [240, 'Blau'], [290, 'Violett'], [330, 'Magenta'], [360, 'Rot']
	];
	const h = ((hGrad % 360) + 360) % 360;
	for (const [grenze, name] of namen) {
		if (h < grenze) return name;
	}
	return 'Rot';
}

/**
 * Wuerfelt eine Farbleiter, die aussieht wie von Hand gewaehlt.
 *
 * Frei gewuerfelte Farben ergeben keine Leiter, sondern Konfetti. Drei Dinge
 * bleiben deshalb festgelegt, gewuerfelt wird nur innerhalb davon:
 *
 * 1. Die Helligkeit faellt streng von hell nach dunkel. Das macht aus fuenf
 *    Farben ueberhaupt erst eine Leiter – und sorgt nebenbei dafuer, dass
 *    die Schrift genau einmal von Schwarz auf Weiss umspringt, am dunklen
 *    Ende, so wie beim Office-Regenbogen auch.
 * 2. Der Farbton wandert gleichmaessig in eine Richtung, um eine feste
 *    Spanne. Springt er hin und her, wirken die Kacheln zusammenhanglos.
 * 3. Die Buntheit ist in der Mitte am hoechsten. Ganz helle und ganz dunkle
 *    Toene vertragen weniger Buntheit, bevor sie aus sRGB herauslaufen.
 */
export function zufallsLeiter(): Farbleiter {
	const zufall = (von: number, bis: number) => von + Math.random() * (bis - von);

	const start = zufall(0, 360);
	const form = VERLAUFSFORMEN[Math.floor(Math.random() * VERLAUFSFORMEN.length)];
	const richtung = Math.random() < 0.5 ? 1 : -1;

	// Von hell nach dunkel. Die Grenzen sind so gewaehlt, dass oben noch
	// schwarze Schrift traegt und unten weisse noetig wird.
	const oben = zufall(0.86, 0.93);
	const unten = zufall(0.30, 0.42);
	const buntheit = zufall(0.13, 0.20);

	const stufen = 5;
	const stuetzen: string[] = [];
	for (let i = 0; i < stufen; i++) {
		const t = i / (stufen - 1);
		const L = oben + (unten - oben) * t;
		// Halbwelle: an beiden Enden gedaempft, in der Mitte voll.
		const C = buntheit * (0.45 + 0.55 * Math.sin(Math.PI * t));
		stuetzen.push(okLchZuHex(L, C, start + richtung * form.spanne * t));
	}

	const bis = start + richtung * form.spanne;
	const name = form.spanne === 0
		? `Zufall: ${farbtonName(start)}`
		: `Zufall: ${farbtonName(start)} → ${farbtonName(bis)}`;

	return {
		id: 'zufall',
		name,
		beschreibung: `Gewürfelt, Verlauf „${form.name}“. Nochmal würfeln gibt eine andere Leiter.`,
		stuetzen
	};
}
