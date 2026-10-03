/**
 * Startet die Claude CLI (`claude -p`) als Agenten und liest ihren Verlauf als
 * stream-json mit.
 *
 * Warum die CLI und nicht die API: der Agent soll selbst in Zotero-Dateien
 * suchen (Read/Grep) und auf Wunsch im Web recherchieren. Das bringt die CLI
 * mit, inklusive ihrer Anmeldung – im Plugin muss dafuer kein Schluessel liegen.
 *
 * Nur am Desktop: auf dem Handy gibt es keine Prozesse.
 */

export interface AgentOptions {
	cliPath: string;
	prompt: string;
	/** Arbeitsverzeichnis des Agenten. */
	cwd: string;
	/** Zusaetzlich lesbare Verzeichnisse (`--add-dir`). */
	addDirs: string[];
	research: boolean;
	model?: string;
	signal?: AbortSignal;
	onEvent?: (e: AgentEvent) => void;
}

export type AgentEvent =
	| { kind: 'tool'; name: string; detail: string }
	| { kind: 'text'; text: string }
	| { kind: 'stderr'; text: string };

export interface AgentResult {
	text: string;
	costUsd: number | null;
	turns: number | null;
}

export const LESE_WERKZEUGE = ['Read', 'Grep', 'Glob'];
export const RECHERCHE_WERKZEUGE = ['WebSearch', 'WebFetch'];

export function agentArgs(o: Pick<AgentOptions, 'addDirs' | 'research' | 'model'>): string[] {
	const tools = o.research ? [...LESE_WERKZEUGE, ...RECHERCHE_WERKZEUGE] : LESE_WERKZEUGE;
	const args = [
		'-p',
		'--output-format', 'stream-json',
		'--verbose',
		// --tools begrenzt, was es ueberhaupt gibt; --allowedTools erspart die
		// Rueckfrage, die im Druckmodus ohnehin niemand beantworten kann.
		'--tools', ...tools,
		'--allowedTools', ...tools,
		'--no-session-persistence',
		// Keine MCP-Server des Nutzers (Browser, Mail …) in diesem Auftrag.
		'--strict-mcp-config'
	];
	if (o.model && o.model.trim()) args.push('--model', o.model.trim());
	for (const d of o.addDirs) args.push('--add-dir', d);
	return args;
}

/** Eine Zeile stream-json → Ereignis fuer die Fortschrittsanzeige (oder null). */
export function describeStreamLine(obj: any): AgentEvent[] {
	if (!obj || obj.type !== 'assistant') return [];
	const out: AgentEvent[] = [];
	for (const c of obj.message?.content ?? []) {
		if (c.type === 'tool_use') {
			const inp = c.input ?? {};
			const detail = inp.file_path ?? inp.pattern ?? inp.query ?? inp.url ?? '';
			out.push({ kind: 'tool', name: c.name, detail: String(detail) });
		} else if (c.type === 'text' && c.text) {
			out.push({ kind: 'text', text: c.text });
		}
	}
	return out;
}

export function runClaudeAgent(o: AgentOptions): Promise<AgentResult> {
	return new Promise((resolve, reject) => {
		let cp: typeof import('child_process');
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			cp = require('child_process');
		} catch {
			reject(new Error('Der Claude-Agent läuft nur in Obsidian am Desktop.'));
			return;
		}

		const child = cp.spawn(o.cliPath, agentArgs(o), {
			cwd: o.cwd,
			windowsHide: true,
			env: process.env
		});

		let buffer = '';
		let stderr = '';
		let result: AgentResult | null = null;
		let errorText: string | null = null;
		let lastText = '';

		const onAbort = () => {
			child.kill();
			reject(new DOMException('Aborted by user', 'AbortError'));
		};
		if (o.signal) {
			if (o.signal.aborted) { onAbort(); return; }
			o.signal.addEventListener('abort', onAbort, { once: true });
		}

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let obj: any;
			try { obj = JSON.parse(line); } catch { return; }

			for (const ev of describeStreamLine(obj)) {
				if (ev.kind === 'text') lastText = ev.text;
				o.onEvent?.(ev);
			}
			if (obj.type === 'result') {
				if (obj.is_error || obj.subtype !== 'success') {
					errorText = obj.result || obj.subtype || 'unbekannter Fehler';
				} else {
					result = {
						text: obj.result ?? lastText,
						costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
						turns: typeof obj.num_turns === 'number' ? obj.num_turns : null
					};
				}
			}
		};

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				handleLine(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
			o.onEvent?.({ kind: 'stderr', text: chunk });
		});

		child.on('error', (err: any) => {
			o.signal?.removeEventListener('abort', onAbort);
			reject(new Error(
				err?.code === 'ENOENT'
					? `Claude CLI nicht gefunden („${o.cliPath}"). Pfad in den Plugin-Einstellungen eintragen.`
					: `Claude CLI ließ sich nicht starten: ${err?.message || err}`
			));
		});

		child.on('close', (code: number | null) => {
			o.signal?.removeEventListener('abort', onAbort);
			if (o.signal?.aborted) return;
			if (buffer.trim()) handleLine(buffer);
			if (result) resolve(result);
			else reject(new Error(errorText
				? `Claude-Agent meldet einen Fehler: ${errorText}`
				: `Claude CLI endete ohne Ergebnis (Code ${code}). ${stderr.trim().slice(-400)}`));
		});

		// Prompt ueber stdin: kein Laengenlimit der Kommandozeile, nichts in argv.
		child.stdin.write(o.prompt, 'utf8');
		child.stdin.end();
	});
}

/** Sinnvoller Standardpfad: der native Installer legt claude unter ~/.local/bin ab. */
export function defaultCliPath(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const home = require('os').homedir();
		const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
		const local = path.join(home, '.local', 'bin', exe);
		if (fs.existsSync(local)) return local;
	} catch { /* mobil */ }
	return 'claude';
}

export function defaultZoteroDataDir(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('path').join(require('os').homedir(), 'Zotero');
	} catch {
		return '';
	}
}
