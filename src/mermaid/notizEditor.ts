import { Editor, MarkdownPostProcessorContext, MarkdownView, Notice, TFile, setIcon } from 'obsidian';
import AnkiGeneratorPlugin from '../main';
import { MermaidEditorModal } from '../ui/MermaidEditorModal';
import { renderMermaidInElement } from '../mermaidRenderer';
import { MermaidBlock, ersetzeMermaidCode, findeMermaidBloecke } from './mermaidBloecke';

/**
 * Mermaid-Editor fuer Diagramme in Notizen.
 *
 * - Lese- und Live-Vorschau: beim Ueberfahren eines Diagramms erscheint ein
 *   Stift. Den Knopf haengen wir erst beim Hover an – Obsidian zeichnet
 *   Diagramme asynchron und in der Live-Vorschau ohne Post-Processor.
 * - Quelltext-Modus: Befehl und Rechtsklick „Mermaid-Diagramm bearbeiten",
 *   wenn der Cursor in einem Diagramm steht.
 */
export function registriereMermaidEditor(plugin: AnkiGeneratorPlugin) {
	// Leseansicht: Abschnitt → Kontext, fuer getSectionInfo().
	const sektionen = new WeakMap<HTMLElement, MarkdownPostProcessorContext>();
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		sektionen.set(el, ctx);
		// MERMAID IN CALLOUTS ZEICHNET OBSIDIAN 1.13 NICHT.
		//
		// Nur der Editor wandelt ```mermaid in ein Diagramm um. Callouts (und
		// alles andere, was ueber den Markdown-Renderer laeuft) behalten einen
		// eingefaerbten Codeblock – ohne Fehlermeldung (03.10.2026,
		// Ondansetron, Schutzhandschuhe). Kurz warten, falls Obsidian doch
		// selbst zeichnet, dann den Rest uebernehmen.
		if (!el.querySelector('code.language-mermaid')) return;
		window.setTimeout(() => {
			if (el.querySelector('code.language-mermaid')) void renderMermaidInElement(el);
		}, 50);
	});

	plugin.registerDomEvent(document, 'mouseover', (e) => {
		const t = e.target as HTMLElement | null;
		const dia = t?.closest?.('.mermaid') as HTMLElement | null;
		if (!dia || dia.dataset.ankiMermaidEdit) return;
		if (!dia.closest('.workspace-leaf-content[data-type="markdown"]')) return;
		// Eigene Oberflaechen (Kartenblock, Chat) haben ihre eigenen Knoepfe.
		if (dia.closest('.block-language-anki-cards, .anki-chat-panel, .anki-suggestion')) return;
		if (!dia.querySelector('svg')) return;
		dia.dataset.ankiMermaidEdit = '1';
		dia.addClass('anki-mermaid-hat-knopf');
		const knopf = dia.createEl('button', { cls: 'anki-mermaid-bearbeiten', attr: { 'aria-label': 'Diagramm bearbeiten' } });
		setIcon(knopf, 'pencil');
		knopf.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			void ausDiagramm(plugin, dia, sektionen);
		});
	});

	plugin.addCommand({
		id: 'mermaid-diagramm-bearbeiten',
		name: 'Mermaid-Diagramm unter dem Cursor bearbeiten',
		editorCheckCallback: (checking, editor, view) => {
			const block = blockAmCursor(editor);
			if (!block || !(view.file instanceof TFile)) return false;
			if (!checking) oeffne(plugin, view.file, block);
			return true;
		}
	});

	plugin.registerEvent(plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
		const block = blockAmCursor(editor);
		if (!block || !(view.file instanceof TFile)) return;
		const file = view.file;
		menu.addItem((item) => item
			.setTitle('Mermaid-Diagramm bearbeiten')
			.setIcon('pencil')
			.onClick(() => oeffne(plugin, file, block)));
	}));
}

function blockAmCursor(editor: Editor): MermaidBlock | null {
	const zeile = editor.getCursor().line;
	return findeMermaidBloecke(editor.getValue()).find((b) => b.open <= zeile && zeile <= b.close) ?? null;
}

/** Vom gezeichneten Diagramm zurueck zu seinem Quelltext in der Datei. */
async function ausDiagramm(
	plugin: AnkiGeneratorPlugin,
	dia: HTMLElement,
	sektionen: WeakMap<HTMLElement, MarkdownPostProcessorContext>
) {
	const view = plugin.app.workspace.getLeavesOfType('markdown')
		.map((l) => l.view)
		.find((v): v is MarkdownView => v instanceof MarkdownView && v.containerEl.contains(dia));
	if (!view || !view.file) return;

	let startZeile: number | null = null;
	let bereich: HTMLElement = dia;

	if (view.getMode() === 'preview') {
		let n: HTMLElement | null = dia;
		while (n && !sektionen.has(n)) n = n.parentElement;
		const info = n ? sektionen.get(n)!.getSectionInfo(n) : null;
		if (n && info) { startZeile = info.lineStart; bereich = n; }
	} else {
		// Live-Vorschau: das Widget sitzt an der Position seines Quelltexts.
		const cm = (view.editor as unknown as { cm?: { posAtDOM: (el: Node) => number; state: { doc: { lineAt: (p: number) => { number: number } } } } }).cm;
		const widget = (dia.closest('.cm-embed-block') as HTMLElement | null) ?? dia;
		if (cm) {
			try {
				startZeile = cm.state.doc.lineAt(cm.posAtDOM(widget)).number - 1;
				bereich = widget;
			} catch { /* bleibt null */ }
		}
	}
	if (startZeile === null) {
		new Notice('Diagramm nicht im Quelltext gefunden – Cursor ins Diagramm setzen und den Befehl nutzen.');
		return;
	}

	const k = Math.max(0, Array.from(bereich.querySelectorAll('.mermaid')).indexOf(dia));
	const content = await plugin.app.vault.read(view.file);
	const block = findeMermaidBloecke(content).filter((b) => b.close >= startZeile!)[k];
	if (!block) {
		new Notice('Diagramm nicht im Quelltext gefunden.');
		return;
	}
	oeffne(plugin, view.file, block);
}

function oeffne(plugin: AnkiGeneratorPlugin, file: TFile, block: MermaidBlock) {
	new MermaidEditorModal(plugin.app, block.code, async (neu) => {
		let ok = false;
		await plugin.app.vault.process(file, (c) => {
			// Neu suchen: die Datei kann sich seit dem Oeffnen geaendert haben.
			const bloecke = findeMermaidBloecke(c);
			const b = bloecke.find((x) => x.open === block.open && x.code === block.code)
				?? bloecke.find((x) => x.code === block.code);
			if (!b) return c;
			ok = true;
			return ersetzeMermaidCode(c, b, neu);
		});
		new Notice(ok ? 'Diagramm gespeichert.' : 'Diagramm wurde inzwischen geändert – nicht gespeichert.');
	}).open();
}
