// The cup's whole UI: one shadow root over the game, scaled with the game's own UI factor.
import type { App } from '../app.ts';
import { site } from '../game.ts';
import { KeysPanel } from '../keys.ts';
import { h, icon, onUiError } from './dom.ts';
import { Hub } from './hub.ts';
import { Hud } from './hud.ts';
import { Panel } from './panel.ts';
import css from './style.css';

const DOC_CSS = `
.game-toolbar-ui.sc-toolbar{max-width:calc(100% - 2 * var(--safe-area-horizontal,0px) - 8px)}
.game-toolbar-ui.sc-toolbar>.button-container{display:flex;flex-wrap:wrap;row-gap:4px}
.game-toolbar-ui.sc-toolbar>.button-container>.button{white-space:nowrap}
.game-toolbar-ui .sc-toolbar-button{pointer-events:inherit;display:inline-flex;align-items:center;gap:8px}
.game-toolbar-ui .sc-toolbar-button svg{width:24px;height:24px;display:block}
.game-toolbar-ui .sc-toolbar-button.sc-host{background-color:#3a2a10}
.game-toolbar-ui .sc-toolbar-button.sc-host:hover{background-color:#5a4318}
.game-ui.sc-watching>:is(.time-announcer-ui,.hint-ui,.timer-ui,.checkpoint-ui,.speedometer-ui),
.game-ui.sc-session-ended>.player-list-ui,
.session-end-ui.sc-session-ended{display:none!important}
`;

export class Layer {
  host = h('div', { id: 'nsws-cuppa' });
  root: ShadowRoot;
  hud: Hud;
  panel: Panel;
  hub: Hub;
  keys = new KeysPanel();
  #stage = h('div', { class: 'stage' });
  #raf = 0;
  #toolbar: { el: HTMLElement | null; items: HTMLElement[]; key: string } = { el: null, items: [], key: '' };
  #layoutAt = 0;

  constructor(private app: App) {
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    const doc = document.createElement('style');
    doc.textContent = DOC_CSS;
    document.head.append(doc);
    const root = h('div', { class: 'root' }, this.#stage);
    this.root.append(style, root);
    document.body.append(this.host);
    this.hud = new Hud(app);
    this.panel = new Panel(app);
    this.hub = new Hub(app);
    this.#stage.append(this.hud.el, this.panel.el, this.hub.el);
    this.hud.onOpenPanel = () => this.panel.setOpen(true);
    this.hud.onChatSubmit = (text) => app.chat.cup.post(text);
    this.panel.onKeys = this.hub.onKeys = () => this.keys.open();
    this.hub.onJoined = () => setTimeout(() => app.isHost && this.panel.setOpen(true), 1500);
    onUiError((error) => app.fail(error));
    app.onChange = () => this.render();
    window.addEventListener('keydown', (e) => this.#key(e), { capture: true });
    const loop = () => {
      this.#raf = requestAnimationFrame(loop);
      this.#frame();
    };
    this.#raf = requestAnimationFrame(loop);
  }

  #phase = '';
  render() {
    const s = this.app.state;
    if (s && s.phase !== this.#phase) {
      this.#phase = s.phase;
      // A racer's panel gets out of the way when their round starts.
      if (s.phase === 'countdown' && this.app.me != null && s.round?.racers.includes(this.app.me)) this.panel.setOpen(false);
    }
    this.hud.render();
    this.panel.render();
    this.#renderToolbar();
  }

  #frame() {
    const app = this.app;
    if (!app.state) return;
    this.hud.tick();
    this.hud.tickSpec();
    const now = performance.now();
    if (now - this.#layoutAt > 1000) {
      this.#layoutAt = now;
      this.#layout();
      this.render();
    }
  }

  // The chat feed sits above whatever the game shows in the bottom-left corner (checkpoints, inputs).
  #layout() {
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale-factor')) || 1;
    let bottom = 16;
    for (const el of document.querySelectorAll<HTMLElement>('.game-ui > *')) {
      if (el.classList.contains('game-toolbar-ui') || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.left > 400 * scale || r.top < window.innerHeight * 0.55) continue;
      // Full-width rows (the timer) only count where they actually draw something on the left.
      if (r.width > window.innerWidth * 0.8) continue;
      bottom = Math.max(bottom, (window.innerHeight - r.top) / scale + 8);
    }
    // The round bar stays between the game's toolbar (top left) and whatever sits top right.
    let side = 260;
    const bar = document.querySelector('.game-ui .game-toolbar-ui');
    if (bar) side = Math.max(side, bar.getBoundingClientRect().right / scale + 14);
    const max = `${Math.max(260, Math.round(window.innerWidth / scale - 2 * side))}px`;
    if (this.hud.el.style.getPropertyValue('--bar-max') !== max) this.hud.el.style.setProperty('--bar-max', max);
    const value = `${Math.round(bottom)}px`;
    if (this.hud.feed.style.getPropertyValue('--feed-bottom') !== value) this.hud.feed.style.setProperty('--feed-bottom', value);
  }

  // A Cup button in the game's own toolbar, and the organizer's quick round controls next to it.
  #renderToolbar() {
    const app = this.app,
      s = app.state;
    const toolbar = app.game && s ? (document.querySelector('.game-toolbar-ui') as HTMLElement | null) : null;
    const container = toolbar?.querySelector(':scope > .button-container') as HTMLElement | null;
    const live = !!s && ['countdown', 'racing', 'warmup'].includes(s.phase);
    const key = JSON.stringify([!!container, app.isHost, live, s?.phase]);
    if (this.#toolbar.el === container && this.#toolbar.key === key && this.#toolbar.items.every((i) => i.isConnected)) return;
    for (const item of this.#toolbar.items) item.remove();
    this.#toolbar.el?.classList.remove('sc-toolbar');
    this.#toolbar = { el: container, items: [], key };
    if (!container || !toolbar) return;
    toolbar.classList.add('sc-toolbar');
    const make = (label: string, ic: string, fn: () => void, extra = '') => {
      const b = document.createElement('button');
      b.className = 'button sc-toolbar-button ' + extra;
      b.append(icon(ic));
      // The organizer's quick controls are icons only, so the toolbar stays clear of the round bar.
      if (extra) b.title = label;
      else b.append(document.createTextNode(label));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        site.__nswsUIClick?.();
        try {
          fn();
        } catch (error) {
          app.fail(error);
        }
        b.blur();
      });
      return b;
    };
    const items = [make('Cup', 'trophy', () => this.panel.setOpen(!this.panel.open))];
    if (app.isHost && live && s) {
      const org = app.org!;
      if (s.phase === 'racing') items.push(make('End round', 'stop', () => org.endRoundNow(), 'sc-host'));
      items.push(make('Restart', 'restart', () => org.restartRound(), 'sc-host'));
      items.push(make('Void', 'x', () => org.voidRound(), 'sc-host'));
    }
    container.append(...items);
    this.#toolbar.items = items;
  }

  #key(e: KeyboardEvent) {
    const app = this.app;
    const keys = site.__nswsCupKeys;
    if (!keys || site.__nswsKeyBindCapturing || e.defaultPrevented) return;
    if (e.composedPath().some((t) => (t as HTMLElement).tagName === 'INPUT' || (t as HTMLElement).tagName === 'TEXTAREA')) return;
    if (!app.state || !app.game) return;
    const match = (binding: string) => keys.matches(e, binding);
    if (this.hub.isOpen || document.querySelector('.nsws-keys.open')) return;
    if (e.key === 'Escape' && (this.panel.open || this.hud.chatOpen)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.hud.chatOpen) this.hud.closeChat();
      else this.panel.setOpen(false);
      return;
    }
    if (match(keys.scoreboard())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) this.panel.setOpen(!this.panel.open);
      return;
    }
    if (match(keys.chat())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (this.panel.open) this.root.querySelector<HTMLInputElement>('.side form input')?.focus();
      else this.hud.openChat();
      return;
    }
    if (match(keys.ghosts()) && !app.state.rules.collisions) {
      if (e.repeat) return;
      app.watch.ghostsHidden = !app.watch.ghostsHidden;
      app.notify(app.watch.ghostsHidden ? 'Other cars hidden' : 'Other cars shown', 'info');
      return;
    }
    if (app.watch.active && match(keys.spectatePrevious())) return app.watch.cycle(-1);
    if (app.watch.active && match(keys.spectateNext())) return app.watch.cycle(1);
  }

  dispose() {
    cancelAnimationFrame(this.#raf);
  }
}
