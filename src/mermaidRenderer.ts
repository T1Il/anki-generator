import { App, MarkdownRenderer, Component } from 'obsidian';
import { storeAnkiMediaFile } from './anki/AnkiConnect';

// Matches ```mermaid ... ``` (with closing fence) OR ```mermaid ... (until end of string, no closing fence)
// The second case occurs inside anki-cards blocks where a closing ``` would end the outer block.
const MERMAID_BLOCK_REGEX = /```mermaid\n([\s\S]*?)(?:```|$)/g;

/**
 * Detects mermaid blocks in text, renders each to PNG,
 * uploads to Anki, and replaces the block with an <img> tag.
 *
 * Handles two formats:
 * 1. Standard: ```mermaid\n...\n``` (with closing fence)
 * 2. Unclosed: ```mermaid\n... (no closing fence, as found inside anki-cards blocks)
 */
export async function processMermaidBlocks(text: string, app: App): Promise<string> {
    const matches = Array.from(text.matchAll(MERMAID_BLOCK_REGEX));
    if (matches.length === 0) return text;

    let result = text;

    for (const match of matches) {
        const fullMatch = match[0];
        const mermaidCode = match[1].trim();

        if (!mermaidCode) continue;

        try {
            console.log(`[MermaidRenderer] Processing mermaid block (${mermaidCode.length} chars)`);
            const pngBase64 = await renderMermaidToPng(mermaidCode, app);
            if (pngBase64) {
                const filename = `anki-mermaid-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.png`;
                const ankiFilename = await storeAnkiMediaFile(filename, pngBase64);
                result = result.replace(fullMatch, `<img src="${ankiFilename}">`);
                console.log(`[MermaidRenderer] Uploaded as ${ankiFilename}`);
            } else {
                console.warn('[MermaidRenderer] Rendering returned null');
                result = result.replace(fullMatch, '[Mermaid-Diagramm konnte nicht gerendert werden]');
            }
        } catch (e) {
            console.error('[MermaidRenderer] Error processing mermaid block:', e);
            result = result.replace(fullMatch, '[Mermaid-Diagramm konnte nicht gerendert werden]');
        }
    }

    return result;
}

/**
 * Checks if text contains any mermaid code blocks (with or without closing fence).
 */
export function containsMermaid(text: string): boolean {
    return /```mermaid\n/i.test(text);
}

async function renderMermaidToPng(mermaidCode: string, app: App): Promise<string | null> {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0';
    container.style.width = '1200px';
    container.style.opacity = '0';
    container.style.pointerEvents = 'none';
    document.body.appendChild(container);

    const component = new Component();
    component.load();

    try {
        const markdown = `\`\`\`mermaid\n${mermaidCode}\n\`\`\``;
        await MarkdownRenderer.render(app, markdown, container, '', component);

        // Wait for mermaid SVG to appear (rendered asynchronously by Obsidian)
        const svg = await waitForSvg(container, 8000);
        if (!svg) {
            console.warn('[MermaidRenderer] SVG not found after timeout');
            return null;
        }

        // Small delay to ensure rendering is fully complete
        await new Promise(resolve => setTimeout(resolve, 300));

        return await svgToPngBase64(svg);
    } catch (e) {
        console.error('[MermaidRenderer] Error rendering mermaid:', e);
        return null;
    } finally {
        component.unload();
        document.body.removeChild(container);
    }
}

async function waitForSvg(container: HTMLElement, timeout: number): Promise<SVGSVGElement | null> {
    // Check immediately
    const existing = container.querySelector('svg');
    if (existing) return existing as SVGSVGElement;

    return new Promise((resolve) => {
        let resolved = false;

        const observer = new MutationObserver(() => {
            const svg = container.querySelector('svg');
            if (svg && !resolved) {
                resolved = true;
                observer.disconnect();
                // Give mermaid a moment to finalize the SVG
                setTimeout(() => resolve(svg as SVGSVGElement), 300);
            }
        });
        observer.observe(container, { childList: true, subtree: true });

        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                observer.disconnect();
                resolve(container.querySelector('svg') as SVGSVGElement | null);
            }
        }, timeout);
    });
}

async function svgToPngBase64(svg: SVGSVGElement): Promise<string> {
    const clonedSvg = svg.cloneNode(true) as SVGSVGElement;

    // Get dimensions from the rendered SVG
    const bbox = svg.getBoundingClientRect();
    let width = bbox.width || parseFloat(svg.getAttribute('width') || '800');
    let height = bbox.height || parseFloat(svg.getAttribute('height') || '600');

    if (width <= 0) width = 800;
    if (height <= 0) height = 600;

    clonedSvg.setAttribute('width', String(width));
    clonedSvg.setAttribute('height', String(height));

    // Inline computed styles from the source SVG into the clone
    inlineStyles(svg, clonedSvg);

    // Add white background
    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('width', '100%');
    bgRect.setAttribute('height', '100%');
    bgRect.setAttribute('fill', 'white');
    clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);

    // Serialize SVG
    const serializer = new XMLSerializer();
    let svgString = serializer.serializeToString(clonedSvg);

    if (!svgString.includes('xmlns="http://www.w3.org/2000/svg"')) {
        svgString = svgString.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    // Use data URI instead of blob URL to avoid tainted canvas security error
    const svgBase64 = btoa(unescape(encodeURIComponent(svgString)));
    const dataUri = `data:image/svg+xml;base64,${svgBase64}`;

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = 2; // 2x for sharp rendering
            const canvas = document.createElement('canvas');
            canvas.width = width * scale;
            canvas.height = height * scale;
            const ctx = canvas.getContext('2d')!;
            ctx.scale(scale, scale);
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);

            const pngDataUrl = canvas.toDataURL('image/png');
            const base64 = pngDataUrl.split(',')[1];
            resolve(base64);
        };
        img.onerror = () => {
            reject(new Error('Failed to load SVG as image for PNG conversion'));
        };
        img.src = dataUri;
    });
}

/**
 * Recursively copies computed styles from source elements to cloned elements.
 * This ensures the SVG renders correctly when detached from the DOM.
 */
function inlineStyles(source: Element, target: Element): void {
    const computed = window.getComputedStyle(source);
    const importantProps = ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size',
        'font-weight', 'color', 'opacity', 'transform', 'text-anchor', 'dominant-baseline',
        'marker-end', 'marker-start'];

    for (const prop of importantProps) {
        const value = computed.getPropertyValue(prop);
        if (value && value !== 'none' && value !== '' && value !== 'normal') {
            (target as SVGElement | HTMLElement).style?.setProperty(prop, value);
        }
    }

    const sourceChildren = source.children;
    const targetChildren = target.children;
    for (let i = 0; i < sourceChildren.length && i < targetChildren.length; i++) {
        inlineStyles(sourceChildren[i], targetChildren[i]);
    }
}
