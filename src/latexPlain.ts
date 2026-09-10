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
/**
 * Indizes und Exponenten nach Unicode.
 *
 * Im Vault stehen 103 solcher Ausdruecke, verteilt auf 35 verschiedene:
 * `$O_2$`, `$CO_2$`, `$HCO_3^-$`, `$\beta_2$`, `$H^+$`, `$m^2$`. Ausnahmslos
 * einfache Tief- und Hochstellungen — nichts, wofuer man einen Formelsatz
 * braeuchte.
 *
 * Das ist nicht nur fuer Tippkarten wichtig. In einem Mermaid-Schaubild
 * rendert LaTeX ueberhaupt nicht: die Beschriftung landet als reiner Text im
 * SVG, und das SVG wird anschliessend zu PNG gerastert. Was dort als `$M_1$`
 * hineingeht, kommt als `$M_1$` heraus. `M₁` dagegen ueberlebt jeden dieser
 * Schritte, weil es ein gewoehnliches Zeichen ist.
 */
const TIEF: Record<string, string> = {
	'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
	'5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
	'+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
	a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ',
	m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ',
};
const HOCH: Record<string, string> = {
	'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
	'5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
	'+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
	n: 'ⁿ', i: 'ⁱ',
};

/**
 * `_2`, `_{23}`, `^-`, `^{2+}` in Unicode ueberfuehren.
 *
 * Nur wenn JEDES Zeichen der Stellung eine Entsprechung hat. `GABA_A` bleibt
 * stehen und wird gemeldet — ein grossgeschriebenes A gibt es tiefgestellt
 * nicht, und ein stilles `GABAA` waere schlimmer als die Meldung.
 */
function stellungen(s: string, melden: (was: string) => void): string {
	return s.replace(/([_^])(?:\{([^{}]*)\}|(\S))/g, (treffer, zeichen: string,
			geklammert: string | undefined, einzeln: string | undefined) => {
		const inhalt = geklammert !== undefined ? geklammert : (einzeln || '');
		const tabelle = zeichen === '_' ? TIEF : HOCH;
		let aus = '';
		for (const c of inhalt) {
			const u = tabelle[c];
			if (!u) {
				melden(treffer);
				return treffer;
			}
			aus += u;
		}
		return aus;
	});
}

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
		// Indizes und Exponenten, bevor die Klammern fallen.
		s = stellungen(s, (was) => ungeloest.push(was));
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
