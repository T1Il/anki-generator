/**
 * Die Grundeinstellungen eines Mermaid-Flussdiagramms lesen und setzen:
 * Richtung (Kopfzeile `flowchart TD`), Kantenform und Abstaende (Init-Zeile
 * `%%{init: {'flowchart': {...}}}%%`). Alles uebrige im Code bleibt stehen.
 */

export type Richtung = 'TD' | 'LR' | 'BT' | 'RL';
export type Kurve = 'step' | 'basis' | 'linear';
export type Abstand = 'kompakt' | 'normal' | 'weit';

export interface MermaidEinstellungen {
	/** null: kein Flussdiagramm (Sequenz, Mindmap …) – Richtung nicht einstellbar. */
	richtung: Richtung | null;
	kurve: Kurve | null;
	abstand: Abstand | null;
}

const ABSTAENDE: Record<Abstand, { nodeSpacing: number; rankSpacing: number }> = {
	kompakt: { nodeSpacing: 25, rankSpacing: 30 },
	normal: { nodeSpacing: 50, rankSpacing: 50 },
	weit: { nodeSpacing: 80, rankSpacing: 80 }
};

const KOPF = /^([ \t]*)(flowchart|graph)(?:[ \t]+(TB|TD|LR|RL|BT))?[ \t]*;?[ \t]*$/m;
const INIT = /^[ \t]*%%\{\s*init\s*:\s*([\s\S]*?)\s*\}%%[ \t]*$/m;

type Init = Record<string, any>;

function leseInit(code: string): Init | null {
	const m = code.match(INIT);
	if (!m) return null;
	try {
		return JSON.parse(m[1].replace(/'/g, '"'));
	} catch {
		return null;
	}
}

export function leseEinstellungen(code: string): MermaidEinstellungen {
	const kopf = code.match(KOPF);
	const init = leseInit(code);
	const fc = init?.flowchart ?? {};
	const curve = fc.curve as string | undefined;
	let abstand: Abstand | null = null;
	(Object.keys(ABSTAENDE) as Abstand[]).forEach((a) => {
		if (fc.nodeSpacing === ABSTAENDE[a].nodeSpacing && fc.rankSpacing === ABSTAENDE[a].rankSpacing) abstand = a;
	});
	if (!abstand && fc.nodeSpacing === undefined && fc.rankSpacing === undefined) abstand = 'normal';
	return {
		richtung: kopf ? ((kopf[3] === 'TB' ? 'TD' : kopf[3] || 'TD') as Richtung) : null,
		kurve: curve === 'step' || curve === 'basis' || curve === 'linear' ? curve : (curve ? null : 'basis'),
		abstand
	};
}

export function setzeEinstellungen(code: string, e: Partial<MermaidEinstellungen>): string {
	let out = code;

	if (e.richtung) {
		out = out.replace(KOPF, (_m, ws, typ) => `${ws}${typ} ${e.richtung}`);
	}

	if (e.kurve || e.abstand) {
		const init: Init = leseInit(out) ?? {};
		const fc: Init = { ...(init.flowchart ?? {}) };
		if (e.kurve) fc.curve = e.kurve;
		if (e.abstand) Object.assign(fc, ABSTAENDE[e.abstand]);
		init.flowchart = fc;
		// Einfache Anfuehrungszeichen wie in den vorhandenen Notizen.
		const zeile = `%%{init: ${JSON.stringify(init).replace(/"/g, "'").replace(/,/g, ', ').replace(/:/g, ': ')}}%%`;
		out = INIT.test(out) ? out.replace(INIT, zeile) : zeile + '\n' + out;
	}
	return out;
}

/** Waagerechte Flussdiagramme (LR/RL) senkrecht stellen. */
export function senkrecht(code: string): string {
	return code.replace(KOPF, (m, ws, typ, r) => (r === 'LR' || r === 'RL' ? `${ws}${typ} TD` : m));
}
