import { App, Modal, Setting, TextComponent } from 'obsidian';

interface EmojiItem {
    char: string;
    keywords: string;
}

// Compact list of common emojis for UI contexts
const EMOJI_LIST: EmojiItem[] = [
    // STATUS / CHECK
    { char: '✅', keywords: 'check tick done success green' },
    { char: '☑️', keywords: 'check box tick done' },
    { char: '✔️', keywords: 'check tick heavy' },
    { char: '❌', keywords: 'cross x error fail red delete' },
    { char: '❎', keywords: 'cross x box fail' },
    { char: '🟢', keywords: 'circle green status online' },
    { char: '🔴', keywords: 'circle red status offline error' },
    { char: '🟡', keywords: 'circle yellow status warning' },
    { char: '🟠', keywords: 'circle orange status' },
    { char: '🔵', keywords: 'circle blue status info' },
    { char: '🟣', keywords: 'circle purple status' },
    { char: '⚫', keywords: 'circle black status off' },
    { char: '⚪', keywords: 'circle white status' },
    { char: '⚠️', keywords: 'warning alert sign triangle yellow' },
    { char: '🚫', keywords: 'stop no ban forbidden' },
    { char: '⛔', keywords: 'no entry stop' },
    { char: '🛑', keywords: 'stop sign red' },
    
    // FILES / OFFICE
    { char: '🗃️', keywords: 'file box cabinet archive empty' },
    { char: '📁', keywords: 'folder directory' },
    { char: '📂', keywords: 'folder open directory' },
    { char: '📄', keywords: 'page file document text paper' },
    { char: '📝', keywords: 'memo note write file' },
    { char: '📋', keywords: 'clipboard list task' },
    { char: '📌', keywords: 'pin pushpin' },
    { char: '📍', keywords: 'pin round location' },
    { char: '📎', keywords: 'clip paperclip attachment' },
    { char: '📕', keywords: 'book red closed' },
    { char: '📖', keywords: 'book open read' },
    { char: '📚', keywords: 'books library study' },
    { char: '🔖', keywords: 'bookmark tag' },
    { char: '🏷️', keywords: 'tag label' },
    { char: '🗳️', keywords: 'box ballot archive' },
    { char: '📥', keywords: 'inbox tray input' },
    { char: '📤', keywords: 'outbox tray output' },
    
    // UI / INTERFACE
    { char: '🔍', keywords: 'search glass find' },
    { char: '🔎', keywords: 'search glass find right' },
    { char: '🔒', keywords: 'lock closed secure' },
    { char: '🔓', keywords: 'unlock open insecure' },
    { char: '🔑', keywords: 'key password' },
    { char: '⚙️', keywords: 'gear settings config detail' },
    { char: '🔧', keywords: 'wrench tool fix settings' },
    { char: '🔨', keywords: 'hammer tool build' },
    { char: '🔔', keywords: 'bell notification alert' },
    { char: '🔕', keywords: 'bell off silent' },
    { char: '📅', keywords: 'calendar date' },
    { char: '🕒', keywords: 'clock time watch' },
    { char: '🗑️', keywords: 'trash bin delete garbage' },
    
    // OBJECTS / MISC
    { char: '💡', keywords: 'idea light bulb hint' },
    { char: '🧠', keywords: 'brain mind think smart ai' },
    { char: '🤖', keywords: 'robot bot ai' },
    { char: '🔥', keywords: 'fire hot burn flame flow' },
    { char: '💧', keywords: 'water drop liquid' },
    { char: '⚡', keywords: 'zap bolt energy electric flash' },
    { char: '⭐', keywords: 'star favorite rate yellow' },
    { char: '🌟', keywords: 'star glow shine' },
    { char: '✨', keywords: 'sparkles stars magic clean new' },
    { char: '💎', keywords: 'gem diamond' },
    { char: '🚩', keywords: 'flag red mark' },
    { char: '🏁', keywords: 'flag checkered finish' },
    { char: '🎓', keywords: 'cap grad education learn' },
    { char: '🧬', keywords: 'dna science gene' },
    { char: '🔬', keywords: 'microscope science' },
    { char: '💊', keywords: 'pill medicine doctor' },
    { char: '🌡️', keywords: 'thermometer temp hot' },
    
    // HEARTS
    { char: '❤️', keywords: 'heart red love like' },
    { char: '🧡', keywords: 'heart orange' },
    { char: '💛', keywords: 'heart yellow' },
    { char: '💚', keywords: 'heart green' },
    { char: '💙', keywords: 'heart blue' },
    { char: '💜', keywords: 'heart purple' },
    { char: '🖤', keywords: 'heart black' },
    { char: '🤍', keywords: 'heart white' },
    { char: '💔', keywords: 'heart broken' },
    
    // FACES
    { char: '😀', keywords: 'smile face happy grin' },
    { char: '🙂', keywords: 'smile face simple' },
    { char: '😐', keywords: 'neutral face straight' },
    { char: '😔', keywords: 'sad face downcast' },
    { char: '😭', keywords: 'cry face tears loud' },
    { char: '😎', keywords: 'cool sunglasses face' },
    { char: '🤔', keywords: 'think face wonder' },
    { char: '🧐', keywords: 'monocle face observe' },
    { char: '🤯', keywords: 'explode head mindblown' },
    { char: '🫡', keywords: 'salute face respect' },
];

export class IconPickerModal extends Modal {
    onChoose: (icon: string) => void;
    gridEl: HTMLElement;

    constructor(app: App, onChoose: (icon: string) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('anki-icon-picker');
        contentEl.empty();
        
        contentEl.createEl('h2', { text: 'Select an Icon' });

        // Search Bar
        const searchContainer = contentEl.createDiv({ cls: 'anki-icon-search' });
        searchContainer.style.marginBottom = '15px';
        searchContainer.style.width = '100%';

        new TextComponent(searchContainer)
            .setPlaceholder('Search icons (e.g. "check", "star")...')
            .onChange((value) => {
                this.renderGrid(value);
            })
            .inputEl.focus();
        
        // Grid Container
        this.gridEl = contentEl.createDiv({ cls: 'emoji-grid' });
        this.gridEl.style.display = 'grid';
        this.gridEl.style.gridTemplateColumns = 'repeat(auto-fill, minmax(45px, 1fr))';
        this.gridEl.style.gap = '8px';
        this.gridEl.style.maxHeight = '400px';
        this.gridEl.style.overflowY = 'auto';
        this.gridEl.style.padding = '5px';

        // Initial Render
        this.renderGrid('');

        // Custom Input Fallback
        const customContainer = contentEl.createDiv();
        customContainer.style.marginTop = '20px';
        customContainer.style.borderTop = '1px solid var(--background-modifier-border)';
        customContainer.style.paddingTop = '15px';
        
        new Setting(customContainer)
            .setName('Or type custom text/icon')
            .addText(text => text
                .setPlaceholder('Custom...')
                .inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        this.onChoose(text.getValue());
                        this.close();
                    }
                })
            )
            .addButton(btn => btn
                .setButtonText('Select')
                .onClick(() => {
                    const input = customContainer.querySelector('input');
                    if (input && input.value) {
                        this.onChoose(input.value);
                        this.close();
                    }
                })
            );
    }

    renderGrid(filter: string) {
        this.gridEl.empty();
        const lowerFilter = filter.toLowerCase();

        const filtered = EMOJI_LIST.filter(item => 
            item.keywords.includes(lowerFilter) || item.char.includes(lowerFilter)
        );

        if (filtered.length === 0) {
            this.gridEl.createDiv({ text: 'No icons found.' });
            return;
        }

        filtered.forEach(item => {
            const btn = this.gridEl.createEl('div', { text: item.char, cls: 'emoji-btn' });
            btn.title = item.keywords;
            btn.style.fontSize = '24px';
            btn.style.textAlign = 'center';
            btn.style.padding = '8px';
            btn.style.cursor = 'pointer';
            btn.style.borderRadius = '6px';
            btn.style.transition = 'background-color 0.1s';
            
            btn.onmouseover = () => btn.style.backgroundColor = 'var(--background-secondary-alt)';
            btn.onmouseout = () => btn.style.backgroundColor = 'transparent';
            
            btn.onclick = () => {
                this.onChoose(item.char);
                this.close();
            };
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
