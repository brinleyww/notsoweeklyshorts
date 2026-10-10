// Every key a cup uses, with rebinding, opened from the Competitions screen and the cup panel's
// Keys button. The bindings live in main.bundle.js (window.__nswsCupKeys); the game's own keys are
// saved exactly as Settings -> Controls saves them.
interface KeyRow {
  id: string;
  group: string;
  label: string;
  keys: (string | null)[];
  fixed?: boolean;
  set?: (slot: number, binding: string) => void;
}
interface Keys {
  list(): KeyRow[];
  format(binding: string | null): string;
  record(passThrough: (e: KeyboardEvent) => boolean, onModifiers: (label: string) => void, onDone: (binding: string | null) => void): () => void;
}

const site = window as unknown as {
  __nswsCupKeys?: Keys;
  __nswsKeyBindCapturing?: boolean;
  __nswsUIClick?: () => void;
};

const CSS = `
.nsws-keys{position:fixed;inset:0;z-index:100300;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);color:var(--text-color);font-family:inherit}
.nsws-keys.open{display:flex}
.nsws-keys .panel{width:min(640px,94vw);max-height:90vh;display:flex;flex-direction:column;background:var(--surface-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%)}
.nsws-keys .head{display:flex;align-items:center;gap:14px;padding:12px 20px;background:var(--surface-secondary-color)}
.nsws-keys h2{margin:0;font-size:30px;font-weight:400;flex:1}
.nsws-keys .body{overflow-y:auto;padding:8px 18px 16px}
.nsws-keys h3{margin:14px 0 6px;font-size:21px;font-weight:400;opacity:.75}
.nsws-keys .row{display:flex;align-items:center;gap:8px;padding:5px 8px;margin-top:4px;background:var(--surface-tertiary-color);font-size:18px}
.nsws-keys .row .grow{flex:1;min-width:0}
.nsws-keys .button{font-size:16px;padding:4px 10px;min-width:96px}
.nsws-keys .fixed{min-width:96px;text-align:center;opacity:.7;font-size:16px}
.nsws-keys .dupe{color:#ffd26b}
.nsws-keys .hint{font-size:15px;opacity:.65;margin:10px 2px 0}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class KeysPanel {
  #root = el('div', 'nsws-keys');
  #body = el('div', 'body');
  #stop: (() => void) | null = null;

  constructor() {
    const style = el('style');
    style.textContent = CSS;
    document.head.append(style);
    const panel = el('div', 'panel');
    const head = el('div', 'head');
    const close = el('button', 'button', 'Done');
    close.addEventListener('click', () => this.close());
    head.append(el('h2', undefined, 'Keys'), close);
    panel.append(head, this.#body);
    this.#root.append(panel);
    this.#root.addEventListener('pointerdown', (e) => {
      if (e.target === this.#root) this.close();
    });
    // Typing here must not reach the game, except the key being recorded.
    for (const type of ['keydown', 'keyup'] as const)
      this.#root.addEventListener(type, (e) => {
        if (site.__nswsKeyBindCapturing) return;
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Escape') this.close();
      });
    document.body.append(this.#root);
  }

  open() {
    this.#render();
    this.#root.classList.add('open');
    this.#root.querySelector<HTMLButtonElement>('.head .button')?.focus();
  }

  close() {
    this.#cancel();
    this.#root.classList.remove('open');
  }

  #cancel() {
    this.#stop?.();
    this.#stop = null;
  }

  #render() {
    const keys = site.__nswsCupKeys;
    this.#body.replaceChildren();
    if (!keys) return;
    const rows = keys.list();
    const used = new Map<string, number>();
    for (const row of rows) for (const k of row.keys) if (k) used.set(k, (used.get(k) ?? 0) + 1);
    let group = '';
    for (const row of rows) {
      if (row.group !== group) {
        group = row.group;
        this.#body.append(el('h3', undefined, group));
      }
      const line = el('div', 'row');
      line.append(el('span', 'grow', row.label));
      row.keys.forEach((binding, slot) => {
        if (row.fixed || !row.set) {
          line.append(el('span', 'fixed', keys.format(binding)));
          return;
        }
        const button = el('button', 'button', keys.format(binding));
        if (binding && (used.get(binding) ?? 0) > 1) {
          button.classList.add('dupe');
          button.title = 'Also used by another key here';
        }
        button.addEventListener('click', () => this.#record(button, row, slot));
        line.append(button);
      });
      this.#body.append(line);
    }
    this.#body.append(
      el('p', 'hint', 'Click a key to change it, then press the new key (Escape cancels). The same keys are in Settings: Competitions, Ghosts and Controls.'),
    );
  }

  #record(button: HTMLButtonElement, row: KeyRow, slot: number) {
    const keys = site.__nswsCupKeys;
    if (!keys) return;
    site.__nswsUIClick?.();
    this.#cancel();
    button.textContent = 'Press any key...';
    const cancel = (e: PointerEvent) => {
      if (e.target === button) return;
      window.removeEventListener('pointerdown', cancel, true);
      this.#cancel();
      this.#render();
    };
    window.addEventListener('pointerdown', cancel, true);
    this.#stop = keys.record(
      () => false,
      (label) => {
        button.textContent = label || 'Press any key...';
      },
      (binding) => {
        window.removeEventListener('pointerdown', cancel, true);
        this.#stop = null;
        if (binding) row.set?.(slot, binding);
        this.#render();
      },
    );
  }
}
