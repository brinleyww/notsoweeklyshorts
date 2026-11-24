// The cup's whole UI: one shadow root over the game, scaled with the game's own UI factor.
import type { App } from '../app.ts';
import { site } from '../game.ts';
import { KeysPanel } from '../keys.ts';
import { h, icon, onUiError, toggle } from './dom.ts';
import { Hub } from './hub.ts';
import { Hud } from './hud.ts';
import { KEYMENU_CSS, KeyMenu } from './keymenu.ts';
import { Panel } from './panel.ts';
import { isPhone, isTouch, tapWithOtherFingers, watchTouch } from './touch.ts';
import { TouchMenu } from './touchmenu.ts';
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
body.sc-touch .game-ui>.hint-ui{top:var(--sc-hint-top,150px)}
` + KEYMENU_CSS;

export class Layer {
  host = h('div', { id: 'nsws-cuppa' });
  root: ShadowRoot;
  hud: Hud;
  panel: Panel;
  hub: Hub;
  keys = new KeysPanel();
  keyMenu: KeyMenu;
  touchMenu: TouchMenu;
  #root: HTMLElement;
  #stage = h('div', { class: 'stage' });
  // As big as the screen's safe-area insets, to read them.
  #safe = h('i', { class: 'safe' });
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
    this.#root = h('div', { class: 'root' }, this.#stage, this.#safe);
    this.#touchClasses();
    this.root.append(style, this.#root);
    document.body.append(this.host);
    this.hud = new Hud(app);
    this.panel = new Panel(app);
    this.hub = new Hub(app);
    this.keyMenu = new KeyMenu(app, this.#stage, () => this.#rects, () => this.keys.open());
    this.#stage.append(this.hud.el, this.panel.el, this.hub.el);
    this.hud.onOpenPanel = () => this.panel.setOpen(true);
    app.onOpenPanel = () => {
      this.panel.tab = 'cup';
      this.panel.setOpen(true);
    };
    this.touchMenu = new TouchMenu(
      app,
      () => this.panel.setOpen(true),
      () => app.chat.open(),
    );
    this.hud.addControls(this.touchMenu.menu, this.touchMenu.dock);
    tapWithOtherFingers(this.host);
    watchTouch(() => {
      this.render();
      this.#layout();
    });
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
    document.addEventListener('focusin', () => app.chat.typing && app.driver.clearInput());
    window.addEventListener('resize', () => this.#layout());
    // Phone keyboards cover the bottom of the page without resizing it (Android Chrome, iOS Safari),
    // which is where both chat boxes are. While a box here has focus the layer shrinks to what is
    // still visible, so the box being typed in sits just above the keyboard.
    const vv = window.visualViewport;
    if (vv) {
      const fit = () => this.#fitKeyboard();
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
      this.root.addEventListener('focusin', () => setTimeout(fit, 0));
      this.root.addEventListener('focusout', () => setTimeout(fit, 0));
    }
    this.#layout();
    const loop = () => {
      this.#raf = requestAnimationFrame(loop);
      this.#frame();
    };
    this.#raf = requestAnimationFrame(loop);
  }

  #keyboard = '';
  #fitKeyboard() {
    const vv = window.visualViewport;
    const el = this.root.querySelector<HTMLElement>('.root');
    if (!vv || !el) return;
    const active = this.root.activeElement;
    const typing = active instanceof HTMLInputElement && (active.type === 'text' || active.type === 'number');
    // Less than this missing is browser chrome coming and going, not a keyboard.
    const covered = window.innerHeight - vv.height;
    const key = typing && covered > 120 ? `${Math.round(vv.offsetTop)},${Math.round(vv.height)}` : '';
    if (key === this.#keyboard) return;
    this.#keyboard = key;
    el.classList.toggle('kb', !!key);
    if (key) {
      el.style.top = `${Math.round(vv.offsetTop)}px`;
      el.style.height = `${Math.round(vv.height)}px`;
      el.style.bottom = 'auto';
    } else {
      el.style.removeProperty('top');
      el.style.removeProperty('height');
      el.style.removeProperty('bottom');
    }
    this.#layout();
  }

  #phase = '';
  #shownKey = '';
  render() {
    const s = this.app.state;
    this.#touchClasses();
    toggle(document.body, 'sc-touch', !!s && isTouch());
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
    const menu = this.touchMenu;
    menu.render(this.panel.open || this.hub.isOpen || this.app.chatTyping || !!this.#keyboard);
    const shown = JSON.stringify([menu.dock.hidden, menu.menu.hidden, menu.menu.childElementCount, this.hud.spec.hidden, this.hud.spec.childElementCount, this.hud.warm.hidden]);
    if (shown !== this.#shownKey) {
      this.#shownKey = shown;
      relayout = true;
    }
    // Bars that come and go move the chat feed straight away.
    if (relayout) this.#layout();
  }

  // Also set before any cup, for the Competitions screen.
  #touchClasses() {
    toggle(this.#root, 'touch', isTouch());
    toggle(this.#root, 'phone', isPhone());
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
    for (const el of document.querySelectorAll('#ui > *, .game-ui > *, .touch-controls-ui > *, .nsws-rocket-pad')) {
      if (el.matches('.game-ui, .touch-controls-ui, .hint-ui')) continue;
      // Rocket League's pads stick out of the pedals' own boxes.
      if (el.classList.contains('nsws-rocket-pad')) {
        if (el.closest('.touch-controls-ui')) add(el, true);
        continue;
      }
      const touch = !!el.parentElement?.classList.contains('touch-controls-ui') || el.classList.contains('nsws-freecam-touch');
      if (el.getBoundingClientRect().width > W * 0.6) for (const child of el.children) add(child, touch);
      else add(el, touch);
    }
    return list;
  }

  #layout() {
    const gameScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale-factor')) || 1;
    // On a phone the game's scale makes cup text and tiles too small to read or tap, so the layer
    // is drawn as if the screen were about 640 x 480 (never smaller than the game's own scale).
    const coarse = isPhone();
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
      H = (this.#keyboard && window.visualViewport?.height) || window.innerHeight,
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
    // Upright, or on a tablet, the game's top buttons leave no room beside them, so the bar goes under them.
    if (coarse && W < H * 1.5 && W - left - right < 360 * u) {
      for (const { r } of obstacles) if (r.top < barTop + 56 * u && r.bottom >= barTop && r.bottom < H * 0.4) barTop = Math.max(barTop, r.bottom + 6 * u);
      left = right = 12 * u;
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
    if (isTouch()) {
      // The game's reset hint starts under the round bar when that would cover it.
      const own = 150 * gameScale;
      const top = round && round.top < own + 60 * gameScale && round.bottom > own ? round.bottom + 6 : own;
      const value = `${Math.round(top / gameScale)}px`;
      if (document.body.style.getPropertyValue('--sc-hint-top') !== value) document.body.style.setProperty('--sc-hint-top', value);
    }

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

    const placed = this.#placeTouch(obstacles, u, H, set);

    // Chat key hint: bottom left, beside the touch pedals when there are any, and above anything low on
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
    const low = [...obstacles.filter((o) => squeezed || !o.touch).map((o) => o.r), ...placed];
    for (const sel of ['.warm', '.spec']) {
      const el = this.root.querySelector<HTMLElement>(sel);
      if (el && !el.hidden) low.push(el.getBoundingClientRect());
    }
    for (const r of low) if (r.width && across(r, fx0, fx1) && r.top > H * 0.55) feedBottom = Math.max(feedBottom, H - r.top + 8 * u);
    // A card in the middle (votes, results) wins over the hint's corner.
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

  // The touch buttons and the bars along the bottom: in the gap between the pedals and the steering
  // when they fit there, else above whatever is in their way. Returns where they went.
  #placeTouch(obstacles: { r: DOMRect; touch: boolean }[], u: number, H: number, set: (el: HTMLElement, name: string, px: number) => void) {
    if (!isTouch()) return [];
    const W = window.innerWidth,
      gap = 6,
      safe = this.#safe.getBoundingClientRect(),
      minX = Math.max(gap, safe.width),
      maxX = W - Math.max(gap, parseFloat(getComputedStyle(this.#safe).marginRight) || 0),
      floor = H - Math.max(gap, safe.height);
    const taken = obstacles.filter(({ r }) => r.bottom > H * 0.35).map((o) => o.r);
    let gapL = minX,
      gapR = maxX;
    for (const { r, touch } of obstacles) {
      if (!touch || r.bottom <= H * 0.5) continue;
      if (r.left + r.right < W) gapL = Math.max(gapL, r.right + gap);
      else gapR = Math.min(gapR, r.left - gap);
    }
    const hits = (box: DOMRect, list: DOMRect[]) => list.filter((r) => r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom);
    const raise = (x: number, w: number, tall: number) => {
      let box = new DOMRect(x, floor - tall, w, tall);
      for (let hit = hits(box, taken); hit.length; hit = hits(box, taken)) {
        const top = Math.min(...hit.map((r) => r.top)) - gap - tall;
        if (top < 0) break;
        box = new DOMRect(x, top, w, tall);
      }
      return box;
    };
    const size = (el: HTMLElement) => [el.offsetWidth * u, el.offsetHeight * u] as const;
    const placed: DOMRect[] = [];
    const { dock, menu } = this.touchMenu;

    if (!dock.hidden && dock.offsetWidth) {
      const [w, tall] = size(dock);
      let x = gapL;
      // Along the bottom, past the toolbar, as long as the steering leaves room.
      for (const r of [...taken].sort((a, b) => a.left - b.left))
        if (r.bottom > floor - tall && r.top < floor && r.right > x && r.left < x + w && r.right + gap + w <= gapR) x = r.right + gap;
      const box = raise(x + w <= gapR ? x : minX, w, tall);
      set(dock, '--x', box.x);
      set(dock, '--b', H - box.bottom);
      placed.push(box);
      taken.push(box);

      if (!menu.hidden) {
        const room = gapR - gapL;
        // Beside the pedals when that is wide enough, else over them.
        const inGap = room >= (W > H ? 250 : 320) * u;
        const width = Math.min(440 * u, inGap ? room : maxX - minX);
        const left = inGap ? Math.max(gapL, Math.min(box.x, gapR - width)) : minX;
        let bottom = box.top - gap;
        if (!inGap) for (const { r, touch } of obstacles) if (touch && r.bottom > H * 0.5) bottom = Math.min(bottom, r.top - gap);
        // Too little room above the pedals: over them after all.
        if (bottom < 200 * u) bottom = box.top - gap;
        set(menu, '--x', left);
        set(menu, '--w', width);
        set(menu, '--b', H - bottom);
        set(menu, '--max', bottom - gap);
      }
    }

    for (const el of [this.hud.warm, this.hud.spec]) {
      if (el.hidden || !el.offsetWidth) continue;
      const [w, tall] = size(el);
      const free = [(W - w) / 2, maxX - w].find((x) => x >= minX && !hits(new DOMRect(x, floor - tall, w, tall), taken).length);
      const middle = w <= gapR - gapL ? Math.min(gapR - w, Math.max(gapL, (W - w) / 2)) : (W - w) / 2;
      const box = raise(free ?? middle, w, tall);
      set(el, '--x', box.x);
      set(el, '--b', H - box.bottom);
      placed.push(box);
      taken.push(box);
    }
    return placed;
  }

  // A Cup button in the game's own toolbar, and the organizer's quick round controls next to it.
  #renderToolbar() {
    const app = this.app,
      s = app.state;
    const toolbar = app.game && s ? (document.querySelector('.game-toolbar-ui') as HTMLElement | null) : null;
    const container = toolbar?.querySelector(':scope > .button-container') as HTMLElement | null;
    const live = !!s && ['countdown', 'racing', 'warmup'].includes(s.phase);
    const key = JSON.stringify([!!container, app.isHost, live, s?.phase, isTouch()]);
    if (this.#toolbar.el === container && this.#toolbar.key === key && this.#toolbar.items.every((i) => i.isConnected)) return;
    for (const item of this.#toolbar.items) item.remove();
    this.#toolbar.el?.classList.remove('sc-toolbar');
    this.#toolbar = { el: container, items: [], key };
    if (!container || !toolbar) return;
    toolbar.classList.add('sc-toolbar');
    // Touch has its own Cup button, and the organizer's controls are in that menu.
    if (isTouch()) return;
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
    // Custom Tracks dialogs and screen (mod/nsws_tracks.js) sit above Cuppa and handle their own keys.
    if (document.querySelector('.nt-modal, .nt-screen:not([hidden])')) return;
    const match = (binding: string) => keys.matches(e, binding);
    if (this.hub.isOpen || document.querySelector('.nsws-keys.open')) return;
    if (e.key === 'Escape' && this.keyMenu.open) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.keyMenu.close();
      return;
    }
    if (e.key === 'Escape' && this.touchMenu.open) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.touchMenu.setOpen(false);
      return;
    }
    if (e.key === 'Escape' && this.panel.open) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.panel.setOpen(false);
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
      if (!e.repeat) app.chat.open();
      return;
    }
    if (match(keys.ghosts()) && !app.state.rules.collisions) {
      if (e.repeat) return;
      app.watch.toggleGhosts();
      return;
    }
    if (app.watch.active && match(keys.spectatePrevious())) return app.watch.cycle(-1);
    if (app.watch.active && match(keys.spectateNext())) return app.watch.cycle(1);
  }

  dispose() {
    cancelAnimationFrame(this.#raf);
  }
}
