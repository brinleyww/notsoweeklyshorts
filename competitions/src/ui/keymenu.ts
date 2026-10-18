// A Keys button joined to the game's speedometer (bottom right) that opens the keys a racer uses in
// a cup. The button lives in the game's UI so it scales and moves with the speedometer; the list is
// drawn in the layer, where it can keep clear of the live board.
import type { App } from '../app.ts';
import { site } from '../game.ts';
import { btn, h, icon } from './dom.ts';

export const KEYMENU_CSS = `
.speedometer-ui>.sc-keys-button{align-self:stretch;display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 3px;padding:5px 12px 5px 18px;font-size:20px;opacity:.9;clip-path:polygon(13px 0,100% 0,100% 100%,8px 100%)}
.speedometer-ui.up>.sc-keys-button{margin:3px 0 0;clip-path:polygon(8px 0,100% 0,100% 100%,13px 100%)}
.speedometer-ui>.sc-keys-button svg{width:22px;height:22px;display:block}
.speedometer-ui>.sc-keys-button.on{background-color:var(--button-hover-color)}
`;

interface Row {
  id: string;
  keys: (string | null)[];
}

const LIST: [group: string, label: string, ids: string[], note?: string, times?: number][] = [
  ['Driving', 'Accelerate', ['game0']],
  ['Driving', 'Brake', ['game2']],
  ['Driving', 'Steer left', ['game3']],
  ['Driving', 'Steer right', ['game1']],
  ['Driving', 'Back to the last checkpoint', ['game4'], 'Before the first one: back to the start, the clock keeps running'],
  ['Driving', 'Restart the run', ['game5'], 'In a race the clock keeps running'],
  ['Driving', 'Retire from the round', ['game5'], 'Press twice quickly during a race', 2],
  ['Driving', 'Cockpit camera', ['game6']],
  ['Driving', 'Hide the HUD', ['game7']],
  ['Cup', 'Cup panel', ['scoreboard']],
  ['Cup', 'Chat', ['chat']],
  ['Cup', 'Show / hide the other cars', ['ghosts'], 'Not in collision cups'],
  ['Cup', 'Free camera', ['game25'], 'Once you have finished'],
  ['Cup', 'Watch the previous / next car', ['spectatePrevious', 'spectateNext']],
];

const COARSE = matchMedia('(pointer: coarse)');
const WIDE = 640,
  NARROW = 340;

export class KeyMenu {
  #button = document.createElement('button');
  #menu = h('div', { class: 'keymenu' });
  #phase = '';

  constructor(
    private app: App,
    private stage: HTMLElement,
    private rects: () => DOMRect[],
    private openAll: () => void,
  ) {
    this.#button.className = 'button sc-keys-button';
    this.#button.title = 'Your keys';
    this.#button.append(icon('keyboard'), document.createTextNode('Keys'));
    this.#button.addEventListener('click', (e) => {
      e.stopPropagation();
      site.__nswsUIClick?.();
      if (this.open) this.close();
      else this.#show();
      this.#button.blur();
    });
    window.addEventListener(
      'pointerdown',
      (e) => {
        const path = e.composedPath();
        if (this.open && !path.includes(this.#menu) && !path.includes(this.#button)) this.close();
      },
      true,
    );
  }

  get open() {
    return this.#menu.isConnected;
  }

  close() {
    this.#menu.remove();
    this.#button.classList.remove('on');
  }

  // Keeps the button on the current race's speedometer. It is gone while watching (the game hides
  // the speedometer then) and on touch screens, which have no keys.
  sync() {
    const app = this.app,
      s = app.state;
    const speedo = app.game && s && !COARSE.matches ? document.querySelector<HTMLElement>('.game-ui > .speedometer-ui') : null;
    if (s && s.phase !== this.#phase) {
      this.#phase = s.phase;
      this.close();
    }
    if (!speedo || !speedo.offsetParent) {
      if (!speedo && this.#button.isConnected) this.#button.remove();
      this.close();
      return;
    }
    if (this.#button.parentElement !== speedo) {
      this.close();
      speedo.insertBefore(this.#button, speedo.querySelector(':scope > .box'));
    }
    if (this.open) this.#place(speedo);
  }

  // Next to the speedometer (above it, or below it when it is at the top), right-aligned with it or,
  // when there isn't room there, left of the live board. The list keeps clear of everything else on
  // screen and scrolls when it has to.
  #place(speedo: HTMLElement) {
    const scale = this.stage.getBoundingClientRect().width / (this.stage.offsetWidth || 1) || 1;
    const W = window.innerWidth,
      H = window.innerHeight;
    const sp = speedo.getBoundingClientRect();
    const up = speedo.classList.contains('up');
    const blocks = [...this.rects()];
    for (const sel of ['.rcol', '.roundbar', '.feed', '.warm', '.spec']) {
      const el = this.stage.querySelector<HTMLElement>(sel);
      const r = el && !el.hidden ? el.getBoundingClientRect() : null;
      if (r?.width && r.height) blocks.push(r);
    }
    // The game's centre hints ("Press R to ...") stay readable: the list always starts below them.
    const hints = [...document.querySelectorAll<HTMLElement>('.game-ui > .hint-ui.show > *')].map((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return range.getBoundingClientRect();
    });
    const gap = 8 * scale;
    // The free band in a column: below what is above the speedometer's edge, above what is below it.
    const fit = (x1: number, width: number) => {
      const x0 = x1 - width * scale;
      let top = gap,
        bottom = H - gap;
      const edge = up ? sp.bottom : sp.top;
      for (const r of blocks) {
        if (!r.width || r.right <= x0 || r.left >= x1) continue;
        if (r.bottom <= edge + 1) top = Math.max(top, r.bottom + gap);
        else if (r.top >= edge - 1) bottom = Math.min(bottom, r.top - gap);
        else if (up) top = Math.max(top, r.bottom + gap);
        else bottom = Math.min(bottom, r.top - gap);
      }
      for (const r of hints) if (r.width && r.right > x0 && r.left < x1) top = Math.max(top, r.bottom + gap);
      return { x1, width, top, bottom, ok: x0 >= gap };
    };
    const col = this.stage.querySelector<HTMLElement>('.rcol')?.getBoundingClientRect();
    const xs = [sp.right];
    if (col?.width) xs.push(col.left - gap);
    const tries = xs.flatMap((x) => [fit(x, WIDE), fit(x, NARROW)]).filter((t) => t.ok);
    const best = tries.find((t) => t.bottom - t.top >= 300 * scale) ?? tries.sort((p, q) => q.bottom - q.top - (p.bottom - p.top))[0];
    if (!best) return;
    const wide = best.width === WIDE;
    if (this.#menu.classList.contains('wide') !== wide) this.#menu.classList.toggle('wide', wide);
    const style = this.#menu.style;
    const set = (k: 'right' | 'top' | 'bottom' | 'maxHeight', v: string) => style[k] !== v && (style[k] = v);
    const px = (v: number) => `${Math.round(v / scale)}px`;
    set('right', px(W - best.x1));
    set('top', up ? px(best.top) : '');
    set('bottom', up ? '' : px(H - best.bottom));
    set('maxHeight', px(Math.max(0, best.bottom - best.top)));
  }

  #show() {
    const speedo = this.#button.parentElement;
    const keys = site.__nswsCupKeys;
    if (!speedo || !keys) return;
    const rows = new Map((keys.list() as Row[]).map((r) => [r.id, r.keys]));
    const timeAttack = this.app.state?.rules.style === 'timeattack';
    const parts: HTMLElement[] = [
      h(
        'div',
        { class: 'top' },
        h('b', null, 'Your keys'),
        btn('Change keys', () => {
          this.close();
          this.openAll();
        }, 'small'),
      ),
    ];
    const cols = new Map<string, HTMLElement>();
    for (const [g, label, ids, note, times] of LIST) {
      // Time attack has no retiring: the restart key just restarts.
      if (times && timeAttack) continue;
      let col = cols.get(g);
      if (!col) cols.set(g, (col = h('div', { class: 'col' }, h('h4', null, g))));
      const codes = [...new Set(ids.flatMap((id) => rows.get(id) ?? []).filter((k): k is string => !!k))];
      col.append(
        h(
          'div',
          { class: 'krow' },
          h('div', { class: 'what' }, label, note ? h('small', null, note) : null),
          h('div', { class: 'keys' }, codes.length ? codes.map((code) => h('span', { class: 'kc' }, keys.format(code))) : h('span', { class: 'kc' }, '—'), times ? h('span', { class: 'times' }, `×${times}`) : null),
        ),
      );
    }
    parts.push(h('div', { class: 'cols' }, [...cols.values()]));
    this.#menu.replaceChildren(...parts);
    this.stage.append(this.#menu);
    this.#button.classList.add('on');
    this.#place(speedo);
  }
}
