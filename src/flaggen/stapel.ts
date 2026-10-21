import AnkiGeneratorPlugin from '../main';
import { AiProvider, Card, ChatMessage } from '../types';
import { buildChatSystemPrompt, generateChatResponse } from '../aiGenerator';
import { getAnkiBlocks, parseCardsFromBlockSource, formatCardsToExistingCardsString } from '../anki/ankiParser';
import { ohneAlteKarten } from '../anki/legacyStrip';
import { setHistory } from '../chat/chatHistory';
import { runMitSitzung, defaultCliPath, defaultZoteroDataDir } from '../agent/claudeAgent';
import { rechercheHinweise } from '../agent/verstehenPrompt';
import { Platform } from 'obsidian';
import { PROVIDERS, resolveProvider } from '../providers';
import { FlaggenEintrag, FlaggenStand, dateiFuer } from './sammeln';
import { eingeklappt, nurNeuUebertragen, pruefAuftrag, schonGeprueft, stapelSchluessel, waisenAuftrag } from './flaggen';
import { StapelDatei, ladeNotiz, ladeStapel, speichereNotiz, speichereWaisen } from './ablage';

export { ladeStapel } from './ablage';
export type { NotizStand, StapelDatei, WaisenStand } from './ablage';

/**
 * Der Stapel: die KI prüft alle geflaggten Karten vorab, Till sieht danach
 * nur noch die fertigen Vorschläge durch.
 *
 * Die Antwort zu einer Notiz landet in deren Chat-Verlauf – die Vorschläge
 * erscheinen damit in der gewohnten Oberfläche (Übernehmen, Bearbeiten,
 * Rückgängig, Vorher/Nachher im großen Chat). Dieselbe Antwort steht in der
 * Ablage im Vault (ablage.ts) – ein zweites Gerät bezahlt nichts doppelt.
 */

/** Ist diese Notiz mit genau diesen Flaggen schon geprüft? */
export function istGeprueft(d: StapelDatei, pfad: string, eintraege: FlaggenEintrag[]): boolean {
	const s = d.notizen[pfad];
	return !!s && !s.fehler && schonGeprueft(stapelSchluessel(eintraege), s.schluessel);
}

export function waisenGeprueft(d: StapelDatei, waisen: FlaggenEintrag[]): boolean {
	return !!d.waisen && !d.waisen.fehler && schonGeprueft(stapelSchluessel(waisen), d.waisen.schluessel);
}

/** Welches Modell prüft: eigene Einstellung, sonst das des Chats. */
export function stapelModell(plugin: AnkiGeneratorPlugin): AiProvider | 'claude-agent' | null {
	const s = plugin.settings;
	const wahl = s.flaggenModell || s.chatProvider || '';
	if (wahl === 'claude-agent') return Platform.isDesktopApp ? 'claude-agent' : resolveProvider(s);
	const p = wahl as AiProvider;
	if (p && PROVIDERS[p] && PROVIDERS[p].isAvailable(s)) return p;
	return resolveProvider(s);
}

export interface StapelFortschritt {
	text: string;
	fertig: number;
	gesamt: number;
}

export interface StapelErgebnis {
	geprueft: number;
	uebersprungen: number;
	fehler: number;
}

/**
 * Alle noch nicht geprüften Notizen nacheinander prüfen lassen.
 * Nacheinander, nicht parallel: der Agent liest in Zotero und im Vault, und
 * zehn gleichzeitige CLI-Prozesse am Desktop sind niemandem zu wünschen.
 */
export async function pruefeStapel(
	plugin: AnkiGeneratorPlugin,
	stand: FlaggenStand,
	signal: AbortSignal,
	onFortschritt: (f: StapelFortschritt) => void
): Promise<StapelErgebnis> {
	const d = await ladeStapel(plugin);
	const modell = stapelModell(plugin);
	if (!modell) throw new Error('Kein KI-Modell für die Prüfung eingestellt.');
	const modellName = modell === 'claude-agent' ? 'Claude-Agent' : modell;

	const offen = Array.from(stand.notizen.entries()).filter(([pfad, e]) => !istGeprueft(d, pfad, e));
	const mitWaisen = stand.waisen.length > 0 && !waisenGeprueft(d, stand.waisen);
	const gesamt = offen.length + (mitWaisen ? 1 : 0);
	const ergebnis: StapelErgebnis = { geprueft: 0, uebersprungen: stand.notizen.size - offen.length, fehler: 0 };

	let fertig = 0;
	for (const [pfad, eintraege] of offen) {
		if (signal.aborted) break;
		const datei = dateiFuer(plugin, pfad);
		onFortschritt({ text: datei?.basename ?? pfad, fertig, gesamt });
		const schluessel = stapelSchluessel(eintraege);

		// Ein anderes Gerät war schneller – dessen Antwort steht schon im Vault.
		const frisch = await ladeNotiz(plugin, pfad);
		if (frisch && !frisch.fehler && schonGeprueft(schluessel, frisch.schluessel)) {
			d.notizen[pfad] = frisch;
			ergebnis.uebersprungen++;
			fertig++;
			continue;
		}

		// Rein technische Fälle: erneutes Übertragen genügt, keine KI.
		if (eintraege.every((e) => nurNeuUebertragen(e.befunde))) {
			d.notizen[pfad] = { schluessel, am: new Date().toISOString(), modell: '', ohneKi: true, karten: eintraege };
			await speichereNotiz(plugin, pfad, d.notizen[pfad]);
			ergebnis.geprueft++;
			fertig++;
			continue;
		}

		const am = new Date().toISOString();
		try {
			const g = await pruefeNotiz(plugin, pfad, eintraege, modell, modellName, am, signal);
			d.notizen[pfad] = { schluessel, am, modell: modellName, auftrag: g.auftrag, antwort: g.antwort, karten: eintraege };
			ergebnis.geprueft++;
		} catch (e: any) {
			if (signal.aborted) break;
			d.notizen[pfad] = { schluessel, am, modell: modellName, fehler: e?.message || String(e), karten: eintraege };
			ergebnis.fehler++;
		}
		await speichereNotiz(plugin, pfad, d.notizen[pfad]);
		fertig++;
	}

	if (mitWaisen && !signal.aborted) {
		onFortschritt({ text: 'Karten ohne Notiz', fertig, gesamt });
		const schluessel = stapelSchluessel(stand.waisen);
		try {
			const antwort = await frageModell(plugin, modell, {
				inhalt: '(Keine Notiz – diese Karten existieren nur in Anki.)',
				karten: 'Keine.',
				auftrag: waisenAuftrag(stand.waisen, modell === 'claude-agent'),
				signal
			});
			d.waisen = { schluessel, am: new Date().toISOString(), modell: modellName, antwort: antwort.text, erledigt: {}, karten: stand.waisen };
			ergebnis.geprueft++;
		} catch (e: any) {
			if (!signal.aborted) {
				d.waisen = { schluessel, am: new Date().toISOString(), modell: modellName, antwort: '', erledigt: {}, fehler: e?.message || String(e), karten: stand.waisen };
				ergebnis.fehler++;
			}
		}
		if (d.waisen) await speichereWaisen(plugin, d.waisen);
	}

	return ergebnis;
}

/** Eine Notiz prüfen lassen und die Antwort an ihren Chat-Verlauf hängen. */
async function pruefeNotiz(
	plugin: AnkiGeneratorPlugin,
	pfad: string,
	eintraege: FlaggenEintrag[],
	modell: AiProvider | 'claude-agent',
	modellName: string,
	am: string,
	signal: AbortSignal
): Promise<{ auftrag: string; antwort: ChatMessage }> {
	const datei = dateiFuer(plugin, pfad);
	if (!datei) throw new Error('Notiz nicht gefunden.');

	const roh = await plugin.app.vault.read(datei);
	const karten = getAnkiBlocks(roh)
		.map((b) => parseCardsFromBlockSource(b.innerClean))
		.reduce((acc, l) => acc.concat(l), [] as Card[]);

	// Die CARD-Nummern können sich seit dem Einsammeln verschoben haben.
	for (const e of eintraege) {
		const i = karten.findIndex((k) => k.id === e.noteId);
		e.kartenNummer = i >= 0 ? i + 1 : null;
	}

	const auftrag = pruefAuftrag(eintraege, modell === 'claude-agent');
	const antwort = await frageModell(plugin, modell, {
		inhalt: ohneAlteKarten(roh),
		karten: formatCardsToExistingCardsString(karten),
		auftrag,
		signal
	});

	const kopf = eingeklappt(auftrag, eintraege.length);
	const nachricht: ChatMessage = {
		role: 'ai',
		content: antwort.text,
		modell: modellName,
		karten: karten.map((k) => ({ id: k.id, q: k.q })),
		flaggenAm: am
	};
	if (antwort.sitzung) nachricht.agentSitzung = antwort.sitzung;

	const verlauf: ChatMessage[] = plugin.feedbackCache.get(pfad) ?? [];
	verlauf.push({ role: 'user', content: kopf }, nachricht);
	setHistory(plugin, pfad, verlauf);
	plugin.app.workspace.trigger('anki:chat-update', pfad, plugin.feedbackCache.get(pfad));
	// Die Ablage bekommt eine eigene Kopie – der Verlauf wird im Chat weiter verändert.
	return { auftrag: kopf, antwort: JSON.parse(JSON.stringify(nachricht)) };
}

async function frageModell(
	plugin: AnkiGeneratorPlugin,
	modell: AiProvider | 'claude-agent',
	a: { inhalt: string; karten: string; auftrag: string; signal: AbortSignal }
): Promise<{ text: string; sitzung?: string }> {
	if (modell !== 'claude-agent') {
		// generateChatResponse kennt nur ein { aborted }-Objekt.
		const abbruch = { get aborted() { return a.signal.aborted; } };
		const text = await generateChatResponse(plugin.app, [], a.auftrag, a.inhalt, modell, plugin.settings, abbruch, a.karten);
		return { text: text.trim() };
	}

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require('fs');
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const path = require('path');
	const dataDir = plugin.settings.zoteroDataDir || defaultZoteroDataDir();
	const storage = path.join(dataDir, 'storage');
	const hatZotero = !!dataDir && fs.existsSync(dataDir);
	const hatStorage = hatZotero && fs.existsSync(storage);
	const adapter = plugin.app.vault.adapter as any;
	const vaultDir: string | null = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null;

	const prompt = [
		buildChatSystemPrompt(a.inhalt, a.karten),
		rechercheHinweise({ vaultDir, zoteroStorage: hatStorage ? storage : null }),
		'## Neue Nachricht des Nutzers\n\n' + a.auftrag
	].filter(Boolean).join('\n\n');

	const started = Date.now();
	const r = await runMitSitzung({
		cliPath: plugin.settings.claudeCliPath || defaultCliPath(),
		prompt,
		cwd: hatZotero ? dataDir : (vaultDir || require('os').tmpdir()),
		addDirs: [...(hatStorage ? [storage] : []), ...(vaultDir ? [vaultDir] : [])],
		research: true,
		model: plugin.settings.claudeAgentModel,
		frisch: () => prompt,
		signal: a.signal
	});
	const info = [`${r.turns ?? '?'} Schritte`, `${Math.round((Date.now() - started) / 1000)} s`];
	if (r.costUsd !== null) info.push(`${r.costUsd.toFixed(2).replace('.', ',')} $`);
	return {
		text: r.text.trim() + `\n\n> [!info]- Claude-Agent\n> ${info.join(' · ')}`,
		sitzung: r.sessionId ?? undefined
	};
}
