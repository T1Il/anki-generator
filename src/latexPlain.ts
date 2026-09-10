/**
 * LaTeX für Tippkarten: nach Unicode statt nach MathJax.
 *
 * DAS PROBLEM
 * -----------
 * `convertObsidianLatexToAnki` wandelt `$\leq$` in `\(\leq\)` — und das ist für
 * gewöhnliche Karten genau richtig: Anki rendert MathJax mit diesen
 * Trennzeichen.
 *
 * Auf einer TIPPKARTE nicht. Dort zeigt Anki das Antwortfeld wörtlich und in
 * Monospace, weil es zeichenweise mit der Eingabe verglichen wird; MathJax
 * läuft in diesem Vergleich grundsätzlich nicht. Till sah am 10.09.2026 auf
 * dem Handy:
 *
 *     \(\leq\) 65 mmHg          statt        ≤ 65 mmHg
 *
 * Die Umwandlung war nicht falsch. Sie wurde nur auf einen Kartentyp
 * angewandt, der sie nicht verarbeiten kann.
 *
 * WARUM UNICODE UND NICHT „LATEX WEGLASSEN"
 * -----------------------------------------
 * Eine Tippkarte soll getippt werden. „≤ 65 mmHg" kann man tippen, `\(\leq\)`
 * nicht und `\leq` auch nicht. Der nackte Befehl wäre also genauso unbrauchbar
 * wie die MathJax-Fassung, nur kürzer.
 *
 * WAS HIER BEWUSST NICHT STEHT
 * ----------------------------
 * Brüche, Wurzeln, Indizes, Summenzeichen — alles, was sich nicht in EIN
 * Zeichen übersetzen lässt. Eine Tippkarte, deren Antwort einen Bruch enthält,
 * ist keine Tippkarte; sie gehört als normale Karte geschrieben. Ein
 * halbherziges `1/2` für `\frac{1}{2}` würde das verdecken, statt es zu
 * zeigen.
 */

/** LaTeX-Befehl -> ein Zeichen. Nur Eindeutiges. */
const ZEICHEN: Record<string, string> = {
	// Vergleiche
	leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
	approx: '≈', equiv: '≡', sim: '~', propto: '∝',
	ll: '≪', gg: '≫',
	// Rechenzeichen
	pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', ast: '*',
	// Pfeile
	to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←',
	Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
	uparrow: '↑', downarrow: '↓',
	// Griechisch, klein
	alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
	zeta: 'ζ', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ',
	mu: 'µ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
	tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
	// Griechisch, groß
	Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
	Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
	// Sonstiges, das in medizinischen Notizen vorkommt
	infty: '∞', degree: '°', circ: '°', percent: '%',
	prime: '′', ldots: '…', dots: '…',

	// `\micro` GIBT ES IN LATEX NICHT — richtig ist `\mu`.
	//
	// Es steht trotzdem hier, weil es in Tills Vault zweimal vorkommt
	// (`$\micro g/kgKG/min$`) und dort auch auf einer normalen Karte scheitern
	// würde: MathJax zeigt bei unbekannten Makros einen roten Fehler. Ein
	// stiller roter Kasten beim Lernen ist schlechter als ein µ, das jeder
	// versteht. Die Notiz gehört trotzdem korrigiert.
	micro: 'µ',
};

/** `\text{...}`, `\mathrm{...}` und Verwandte: Inhalt behalten, Hülle weg. */
const HUELLEN = /\\(?:text|mathrm|mathit|mathbf|mathsf|operatorname|si|unit)\{([^{}]*)\}/g;

/** Was danach noch nach LaTeX aussieht — daran erkennt man, dass es nicht taugt. */
const REST = /\\[a-zA-Z]+|[\^_]\{|\\frac|\\sqrt/;

export interface KlartextErgebnis {
	text: string;
	/** Was sich nicht übersetzen ließ. Leer heißt: sauber durchgekommen. */
	ungeloest: string[];
}

/**
 * `$…$` in einer Tippantwort durch Unicode ersetzen.
 *
 * Die Dollarzeichen fallen weg, der Inhalt bleibt. Was sich nicht übersetzen
 * lässt, bleibt stehen und wird in `ungeloest` gemeldet — verschwiegen wird
 * nichts.
 */
export function latexZuKlartext(text: string): KlartextErgebnis {
	if (!text) return { text, ungeloest: [] };

	const ungeloest: string[] = [];

	const inhalt = (roh: string): string => {
		let s = roh.replace(HUELLEN, '$1');
		// Befehle mit Wortgrenze, damit `\mu` nicht in `\mup` hineingreift.
		s = s.replace(/\\([a-zA-Z]+)/g, (treffer, name: string) => {
			const zeichen = ZEICHEN[name];
			if (zeichen) return zeichen;
			ungeloest.push('\\' + name);
			return treffer;
		});
		// Geschweifte Klammern, die nur der Gruppierung dienten.
		s = s.replace(/[{}]/g, '');
		if (REST.test(s)) ungeloest.push(s.trim());
		// Mehrfache Leerzeichen, die beim Ersetzen entstehen.
		return s.replace(/\s{2,}/g, ' ').trim();
	};

	// Erst abgesetzte Formeln, dann eingebettete — sonst zerlegt die zweite
	// Regel die `$$`-Paare der ersten.
	let raus = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, m: string) => inhalt(m));
	// Kein Leerzeichen direkt hinter dem oeffnenden und vor dem schliessenden
	// Dollar — das ist die TeX-Regel. Ohne sie liest „Kostet 5 $ und 3 $ extra"
	// das Wort dazwischen als Formel.
	raus = raus.replace(/(?<!\\)\$(?!\s)((?:[^$\\]|\\.)+?)(?<![\s\\])\$/g, (_, m: string) => inhalt(m));

	return { text: raus, ungeloest: [...new Set(ungeloest)] };
}
