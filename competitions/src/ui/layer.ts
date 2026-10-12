// The cup's whole UI: one shadow root over the game, scaled with the game's own UI factor.
import type { App } from '../app.ts';
import { site } from '../game.ts';
import { KeysPanel } from '../keys.ts';
import { h, icon, onUiError } from './dom.ts';
import { Hub } from './hub.ts';
import { Hud } from './hud.ts';
import { KEYMENU_CSS, KeyMenu } from './keymenu.ts';
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
` + KEYMENU_CSS;

export class Layer {
  host = h('div', { id: 'nsws-cuppa' });
  root: ShadowRoot;
  hud: Hud;
  panel: Panel;
  hub: Hub;
  keys = new KeysPanel();
  keyMenu: KeyMenu;
  #stage = h('div', { class: 'stage' });
  #raf = 0;
  #toolbar: { el: HTMLElement | null; items: HTMLElement[]; key: string } = { el: null, items: [], key: '' };
  #layoutAt = 0;
  // What the game draws, as of the last layout (screen pixels).
  #rects: DOMRect[] = [];
  #renderAt = 0;

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
    this.keyMenu = new KeyMenu(app, this.#stage, () => this.#rects, () => this.keys.open());
    this.#stage.append(this.hud.el, this.panel.el, this.hub.el);
    this.hud.onOpenPanel = () => this.panel.setOpen(true);
    this.hud.onChatPanel = () => {
      this.panel.setOpen(true);
      this.panel.render();
      this.root.querySelector<HTMLInputElement>('.side form input')?.focus();
    };
    this.hud.onChatSubmit = (text) => app.chat.post(text);
    this.panel.onKeys = this.hub.onKeys = () => this.keys.open();
    this.hub.onJoined = () => setTimeout(() => app.isHost && this.panel.setOpen(true), 1500);
    onUiError((error) => app.fail(error));
    app.onChange = () => this.render();
    window.addEventListener('keydown', (e) => this.#key(e), { capture: true });
    // The game's touch steering listens on window and cancels every touch that isn't on a <button>.
    // From there a touch in this layer looks like one on the host <div>, so taps here never became
    // clicks and the chat box never took focus.
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) this.host.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    // The game's canvas doesn't take focus when clicked, so a click outside the box being typed in
    // ends the typing itself (otherwise the car stays held).
    window.addEventListener(
      'pointerdown',
      (e) => {
        const active = this.root.activeElement;
        if (active instanceof HTMLInputElement && !e.composedPath().includes(active.closest('.chat') ?? active.closest('form') ?? active)) active.blur();
      },
      true,
    );
    // The text box stops key releases from reaching the game, so keys held on the way in are let go.
    this.root.addEventListener('focusin', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') app.driver.clearInput();
    });
    window.addEventListener('resize', () => this.#layout());
    this.#layout();
    const loop = () => {
      this.#raf = requestAnimationFrame(loop);
      this.#frame();
    };
    this.#raf = requestAnimationFrame(loop);
  }

  #phase = '';
  render() {
    const s = this.app.state;
    let relayout = false;
    if (s && s.phase !== this.#phase) {
      this.#phase = s.phase;
      relayout = true;
      // A racer's panel gets out of the way when their round starts.
      if (s.phase === 'countdown' && this.app.me != null && s.round?.racers.includes(this.app.me)) this.panel.setOpen(false);
      // Picks, bans and votes happen on their own cards, so the panel steps aside for racers.
      const racer = this.app.self?.role === 'racer' && !this.app.self?.out;
      if ((s.phase === 'draft' || s.phase === 'vote') && racer) this.panel.setOpen(false);
    }
    this.hud.render();
    this.panel.render();
    this.#renderToolbar();
    this.keyMenu.sync();
    // Bars that come with a phase (warm-up, spectating) move the chat feed straight away.
    if (relayout) this.#layout();
  }

  #frame() {
    const app = this.app;
    if (!app.state) return;
    this.hud.tick();
    this.hud.tickSpec();
    const now = performance.now();
    // A new round's game UI builds over a few frames, so the layout is measured often (it only
    // writes when something moved).
    if (now - this.#layoutAt > 250) {
      this.#layoutAt = now;
      this.#layout();
      this.keyMenu.sync();
    }
    if (now - this.#renderAt > 1000) {
      this.#renderAt = now;
      this.render();
    }
  }

  // What the game (and other mods) draw over a race, in screen pixels. Full-width rows (the timer)
  // count only where they draw; the centre hints come and go and are left out. Touch buttons are
  // marked: the chat feed goes beside them rather than above.
  #obstacles() {
    const W = window.innerWidth,
      H = window.innerHeight;
    const list: { r: DOMRect; touch: boolean }[] = [];
    const add = (el: Element, touch: boolean) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || (!touch && (r.width > W * 0.6 || r.height > H * 0.6))) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      list.push({ r, touch });
    };
    for (const el of document.querySelectorAll('#ui > *, .game-ui > *, .touch-controls-ui > *')) {
      if (el.matches('.game-ui, .touch-controls-ui, .hint-ui')) continue;
      const touch = !!el.parentElement?.classList.contains('touch-controls-ui');
      if (el.getBoundingClientRect().width > W * 0.6) for (const child of el.children) add(child, touch);
      else add(el, touch);
    }
    return list;
  }

  #layout() {
    const gameScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale-factor')) || 1;
    // On a phone the game's scale makes cup text and tiles too small to read or tap, so the layer
    // is drawn as if the screen were about 640 x 480 (never smaller than the game's own scale).
    const coarse = matchMedia('(pointer: coarse)').matches;
    const want = coarse ? Math.max(gameScale, Math.min(window.innerWidth / 640, window.innerHeight / 480)) : 0;
    const value0 = want ? want.toFixed(3) : '';
    const scale = want || gameScale;
    const stage = this.root.querySelector<HTMLElement>('.stage');
    if (stage && stage.style.getPropertyValue('--touch-scale') !== value0) {
      if (value0) stage.style.setProperty('--touch-scale', value0);
      else stage.style.removeProperty('--touch-scale');
    }
    // Measured in screen pixels, written in the layer's own units.
    const W = window.innerWidth,
      H = window.innerHeight,
      u = scale;
    const hud = this.hud.el;
    const set = (el: HTMLElement, name: string, px: number) => {
      const value = `${Math.round(px / u)}px`;
      if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
    };
    const across = (r: DOMRect, x0: number, x1: number) => r.right > x0 && r.left < x1;
    const obstacles = this.#obstacles();
    this.#rects = obstacles.map((o) => o.r);

    // Round bar: top centre, under whatever the game draws there (its timer on touch screens), and
    // as wide as the room left between what sits beside it.
    let barTop = 10 * u;
    for (const { r } of obstacles) if (r.top < H * 0.2 && across(r, W / 2 - 1, W / 2 + 1)) barTop = Math.max(barTop, r.bottom + 6 * u);
    // Centred on the screen when it fits there whole, else centred in the gap it actually has.
    let left = 12 * u,
      right = 296 * u;
    for (const { r } of obstacles) {
      if (r.top > barTop + 56 * u || r.bottom < barTop) continue;
      if (r.right < W / 2) left = Math.max(left, r.right + 14 * u);
      else if (r.left > W / 2) right = Math.max(right, W - r.left + 14 * u);
    }
    const roundEl = this.root.querySelector<HTMLElement>('.roundbar');
    const rr = roundEl && !roundEl.hidden ? roundEl.getBoundingClientRect() : null;
    const name = roundEl?.querySelector<HTMLElement>('.track');
    const whole = !!rr?.width && !!name && name.scrollWidth <= name.clientWidth + 1;
    const even = W - 2 * Math.max(left, right);
    const centred = even >= 560 * u || (whole && rr!.width <= even);
    const [barX, barMax] = centred ? [W / 2, even] : [(left + W - right) / 2, W - left - right];
    set(hud, '--bar-top', barTop);
    set(hud, '--bar-x', barX);
    set(hud, '--bar-max', Math.max(260 * u, barMax));
    const round = rr?.width ? new DOMRect(barX - rr.width / 2, barTop, rr.width, rr.height) : null;

    // Right column (who is watching, the live board): below what sits top right, above what sits
    // lower down (the speedometer, touch steering); the board shows as many rows as fit.
    const x1 = W - 12 * u,
      x0 = x1 - 268 * u;
    const column = round ? [...obstacles.map((o) => o.r), round] : obstacles.map((o) => o.r);
    let colTop = 10 * u,
      colBottom = H - 10 * u;
    for (const r of column) if (across(r, x0, x1) && r.top < H * 0.4) colTop = Math.max(colTop, r.bottom + 8 * u);
    for (const r of column) if (across(r, x0, x1) && r.top >= colTop) colBottom = Math.min(colBottom, r.top - 8 * u);
    set(hud, '--tr-top', colTop);
    this.hud.boardRoom = (colBottom - colTop) / u;

    // Chat feed: bottom left, beside the touch pedals when there are any, and above anything low on
    // its side (the checkpoint count, the warm-up and spectator bars).
    let fx0 = 12 * u;
    for (const { r, touch } of obstacles) if (touch && r.bottom > H * 0.5 && r.left < W / 2) fx0 = Math.max(fx0, r.right + 10 * u);
    let fx1 = fx0 + 380 * u;
    for (const { r, touch } of obstacles) if (touch && r.bottom > H * 0.5 && r.left >= W / 2) fx1 = Math.min(fx1, r.left - 10 * u);
    // Too little room between the pedals: the feed goes above them on the left instead.
    const squeezed = fx1 - fx0 < 200 * u;
    if (squeezed) {
      fx0 = 12 * u;
      fx1 = Math.min(fx0 + 380 * u, W - 12 * u);
    }
    let feedBottom = 16 * u;
    const low = obstacles.filter((o) => squeezed || !o.touch).map((o) => o.r);
    for (const sel of ['.warm', '.spec']) {
      const el = this.root.querySelector<HTMLElement>(sel);
      if (el && !el.hidden) low.push(el.getBoundingClientRect());
    }
    for (const r of low) if (r.width && across(r, fx0, fx1) && r.top > H * 0.55) feedBottom = Math.max(feedBottom, H - r.top + 8 * u);
    // A card in the middle (votes, results) wins over the feed's corner; the panel has the chat then.
    const card = this.root.querySelector<HTMLElement>('.center');
    const cr = card && !card.hidden ? card.getBoundingClientRect() : null;
    const blocked = !!cr?.width && across(cr, fx0, fx1) && cr.bottom > H - feedBottom - 160 * u;
    if (blocked !== this.hud.feedBlocked) {
      this.hud.feedBlocked = blocked;
      this.app.changed();
    }
    set(this.hud.feed, '--feed-left', fx0);
    set(this.hud.feed, '--feed-w', fx1 - fx0);
    set(this.hud.feed, '--feed-bottom', feedBottom);
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
      let voidArmed = 0;
      items.push(
        make('Void the round (press twice)', 'x', () => {
          if (Date.now() - voidArmed > 3000) {
            voidArmed = Date.now();
            app.notify('Press Void again to void the round', 'bad');
            return;
          }
          org.voidRound();
        }, 'sc-host'),
      );
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
    if (e.key === 'Escape' && this.keyMenu.open) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.keyMenu.close();
      return;
    }
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
