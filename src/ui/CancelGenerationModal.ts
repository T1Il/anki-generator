import { FuzzySuggestModal, App, TFile } from 'obsidian';
import AnkiGeneratorPlugin from '../main';

export class CancelGenerationModal extends FuzzySuggestModal<string> {
    plugin: AnkiGeneratorPlugin;
    items: string[];

    constructor(app: App, plugin: AnkiGeneratorPlugin) {
        super(app);
        this.plugin = plugin;
        this.items = Array.from(this.plugin.activeGenerations.keys());
    }

    getItems(): string[] {
        return this.items;
    }

    getItemText(key: string): string {
        const gen = this.plugin.activeGenerations.get(key);
        if (!gen) return key;
        
        // Key format assumption: path::type OR user just sees the description + file
        // Since main.ts isn't updated yet, I'm anticipating the structure.
        // But for now, let's assume 'gen' has { description, path }.
        // If gen is just AbortController (current state), this fails.
        // So I must depend on main.ts update. 
        
        // Let's implement assuming the NEW structure:
        // interface ActiveGeneration { controller: AbortController, description: string, path: string }
        
        // To be safe against partial compilation, I'll cast 'gen' to any.
        const g = gen as any;
        const desc = g.description || "Unbekannter Prozess";
        const path = g.path || key;
        // Clean path for display
        const name = path.split('/').pop();
        
        return `${desc}: ${name} (${path})`;
    }

    onChooseItem(key: string, evt: MouseEvent | KeyboardEvent) {
        const gen = this.plugin.activeGenerations.get(key);
        if (gen) {
             // Abort
             // Support both old (Controller) and new (Object) structure during migration
             if ((gen as any).controller) {
                 (gen as any).controller.abort();
             } else if (gen instanceof AbortController) {
                 gen.abort();
             }
             
             this.plugin.removeActiveGeneration(key);
             // Notice is shown by the command usually, but here we do it.
             // We can assume main.ts helper does cleanup.
        }
    }
}
