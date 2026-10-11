import trophy from '../assets/toolbar-trophy.svg';
import { layoutCupHud, type HudElements } from './hud-layout.ts';
import css from './toolbar.css';

// Keep the launcher inside the native toolbar: native scaling, clipping, hover
// animation and auto-hide then apply without copying any game UI implementation.
export class CupToolbar {
  #fallback: HTMLElement;

  #toolbar: HTMLElement | null = null;
  #overlays: HudElements;
  #button: HTMLButtonElement;
  #schedule: () => void;
  #frame: number | null = null;
  #observer: MutationObserver;
  #resize: ResizeObserver;
  #open: boolean = false;
  // Not So Weekly Shorts: the organizer's round controls, as native toolbar buttons next to Cup.
  #actions: HTMLButtonElement[] = [];
  #actionsKey = '';

  constructor({
    fallback,
    hud,
    povHud,
    povRecordHud,
    inputHud,
    practiceHud,
    notice,
    roundTimer,
    banner,
    downtime,
    toggle,
  }: HudElements & { fallback: HTMLElement; toggle: () => void }) {
    this.#fallback = fallback;

    this.#overlays = { hud, povHud, povRecordHud, inputHud, practiceHud, notice, roundTimer, banner, downtime };
    this.#button = document.createElement('button');
    this.#button.type = 'button';
    this.#button.className = 'button polycup-toolbar-button';
    this.#button.title = 'Cup panel';
    const icon = document.createElement('img');
    icon.className = 'button-icon polycup-trophy';
    icon.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trophy)}`;
    icon.alt = '';
    icon.draggable = false;
    this.#button.append(icon, document.createTextNode(' Cup'));
    this.#button.addEventListener('click', toggle);
    // Native game input listens on window and otherwise consumes Space/Enter.
    for (const type of ['keydown', 'keyup'] as const)
      window.addEventListener(
        type,
        (e) => {
          const focused = [this.#button, ...this.#actions].find((b) => b === document.activeElement);
          if (!focused || !['Space', 'Enter'].includes(e.code)) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          if (type === 'keydown' && !e.repeat) focused.click();
        },
        { capture: true },
      );
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const SYNC_GAP_MS = 200;
    let lastSync = 0;
    this.#schedule = () => {
      if (this.#frame) return;
      const wait = Math.max(0, lastSync + SYNC_GAP_MS - performance.now());
      this.#frame = window.setTimeout(() => {
        requestAnimationFrame(() => {
          this.#frame = 0;
          lastSync = performance.now();
          this.sync();
        });
      }, wait);
    };
    this.#observer = new MutationObserver((records) => {
      if (
        records.some((r) => r.type === 'childList' || (r.target as Element).closest?.('.game-ui'))
      )
        this.#schedule();
    });
    this.#observer.observe(document.getElementById('ui') ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
    this.#resize = new ResizeObserver(this.#schedule);
    window.addEventListener('resize', this.#schedule);
    this.sync();
  }
  sync(open?: boolean) {
    if (open !== undefined) this.#open = open;
    const toolbar = document.querySelector<HTMLElement>('.game-toolbar-ui');
    if (toolbar !== this.#toolbar) {
      this.#resize.disconnect();
      this.#toolbar?.removeEventListener('transitionend', this.#schedule);
      this.#toolbar?.classList.remove('polycup-toolbar');
      this.#toolbar = toolbar;
      if (toolbar) {
        toolbar.classList.add('polycup-toolbar');
        this.#resize.observe(toolbar);
        toolbar.addEventListener('transitionend', this.#schedule);
      }
    }
    const container = toolbar?.querySelector(':scope > .button-container');
    if (container && this.#button.parentElement !== container) container.append(this.#button);
    if (!container) this.#button.remove();
    let after: HTMLElement = this.#button;
    for (const action of this.#actions) {
      if (!container) action.remove();
      else if (after.nextElementSibling !== action) after.after(action);
      action.tabIndex = toolbar?.classList.contains('visible') ? 0 : -1;
      after = action;
    }
    // Not So Weekly Shorts: no version label over the site's menus.
    this.#fallback.hidden = true;
    this.#button.setAttribute('aria-expanded', String(!!this.#open));
    this.#button.tabIndex = toolbar?.classList.contains('visible') ? 0 : -1;

    layoutCupHud(this.#overlays);
  }
  // Not So Weekly Shorts: lay the overlays out again soon (at most every 200 ms).
  relayout() {
    this.#schedule();
  }
  setActions(actions: { label: string; icon: string; run: () => void }[]) {
    const key = actions.map((a) => a.label).join('|');
    if (key === this.#actionsKey) return;
    this.#actionsKey = key;
    for (const button of this.#actions) button.remove();
    this.#actions = actions.map(({ label, icon, run }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button polycup-toolbar-button';
      const image = document.createElement('img');
      image.className = 'button-icon';
      image.src = new URL(`images/${icon}.svg`, document.baseURI).href;
      image.alt = '';
      image.draggable = false;
      button.append(image, document.createTextNode(' ' + label));
      button.addEventListener('click', run);
      return button;
    });
    this.sync();
  }
}
