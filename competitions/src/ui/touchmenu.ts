// What the cup's keys do, for touch: a Cup and a Chat button between the pedals and the steering,
// and the rest in the menu the Cup button opens.
import type { App } from '../app.ts';
import { site } from '../game.ts';
import type { CupState } from '../state.ts';
import { btn, fill, h, show, toggle } from './dom.ts';
import { isTouch } from './touch.ts';

interface Item {
  id: string;
  label: string;
  run: () => unknown;
  on?: boolean;
  // Asked again before it runs.
  confirm?: boolean;
}
interface Group {
  title: string;
  items: Item[];
}

const CONFIRM_MS = 3000;

export class TouchMenu {
  dock = h('div', { class: 'dock', hidden: true });
  menu = h('div', { class: 'touchmenu', hidden: true });
  #cup: HTMLButtonElement;
  #open = false;
  #armed = '';
  #armTimer = 0;
  #key = '';
  #phase = '';

  constructor(
    private app: App,
    private openPanel: () => void,
    openChat: () => void,
  ) {
    this.#cup = btn('Cup', () => this.setOpen(!this.#open));
    const chat = btn('Chat', () => {
      this.setOpen(false);
      openChat();
    });
    this.dock.append(this.#cup, chat);
    window.addEventListener(
      'pointerdown',
      (e) => {
        const path = e.composedPath();
        if (this.#open && !path.includes(this.menu) && !path.includes(this.dock)) this.setOpen(false);
      },
      true,
    );
  }

  get open() {
    return this.#open;
  }

  setOpen(open: boolean) {
    if (open === this.#open) return;
    this.#open = open;
    this.#disarm();
    this.app.changed();
  }

  #disarm() {
    clearTimeout(this.#armTimer);
    this.#armed = '';
  }

  // busy: something else has the screen (the panel, the chat box, the Competitions screen).
  render(busy: boolean) {
    const app = this.app,
      s = app.state;
    const visible = !!s && !!app.game && isTouch() && !busy && s.phase !== 'podium';
    show(this.dock, visible);
    if (!visible && this.#open) {
      this.#open = false;
      this.#disarm();
    }
    const phase = s ? `${s.phase}.${s.round?.n}.${s.round?.try}` : '';
    // A press waiting to be confirmed doesn't carry into another phase.
    if (phase !== this.#phase) {
      this.#phase = phase;
      this.#disarm();
    }
    toggle(this.#cup, 'on', this.#open);
    show(this.menu, visible && this.#open);
    if (!s || !visible || !this.#open) {
      this.#key = '';
      return;
    }
    const groups = this.#groups(s).filter((g) => g.items.length);
    const key = JSON.stringify([groups, this.#armed]);
    if (key === this.#key) return;
    this.#key = key;
    fill(
      this.menu,
      groups.map((g) => [g.title ? h('h4', null, g.title) : null, h('div', { class: 'items' }, g.items.map((item) => this.#button(item)))]),
    );
  }

  #button(item: Item) {
    const armed = this.#armed === item.id;
    const press = () => {
      if (item.confirm && !armed) {
        this.#disarm();
        this.#armed = item.id;
        this.#armTimer = window.setTimeout(() => {
          this.#armed = '';
          this.app.changed();
        }, CONFIRM_MS);
        this.app.changed();
        return;
      }
      this.setOpen(false);
      return item.run();
    };
    const b = btn(armed ? 'Tap again to confirm' : item.label, press, armed ? 'danger' : item.on ? 'on' : '');
    b.dataset.id = item.id;
    return b;
  }

  #groups(s: CupState): Group[] {
    const app = this.app,
      w = app.watch,
      d = app.driver,
      g = app.game!,
      info = app.info,
      r = s.round;

    const main: Item[] = [{ id: 'panel', label: 'Cup panel', run: this.openPanel }];
    if (!s.rules.collisions) main.push({ id: 'ghosts', label: w.ghostsHidden ? 'Show other cars' : 'Hide other cars', on: w.ghostsHidden, run: () => w.toggleGhosts() });
    const driving = !d.blocks(g) || d.waitingForGo;
    const hudShown = app.native.hudShown?.(g) ?? true;
    if (app.native.toggleHud && !info?.spectator.isEnabled && (driving || !hudShown))
      main.push({ id: 'hud', label: hudShown ? 'Hide HUD' : 'Show HUD', on: !hudShown, run: () => app.native.toggleHud!(g) });
    if (d.canRestart) main.push({ id: 'restart', label: 'Restart run', confirm: s.phase === 'racing' && s.rules.style !== 'timeattack', run: () => d.restart() });
    if (d.canRetire) main.push({ id: 'retire', label: 'Retire', confirm: true, run: () => d.retire() });
    if (s.rules.skipVotes && r && app.me != null && r.racers.includes(app.me) && ['warmup', 'countdown', 'racing'].includes(s.phase)) {
      const mine = r.skip.includes(app.me);
      main.push({ id: 'skip', label: mine ? 'Take back my vote' : s.rules.casual ? 'Vote for a new track' : 'Vote to skip', on: mine, run: () => app.act({ k: 'act', a: 'skip' }) });
    }

    const camera: Item[] = [];
    // The free camera's key works once this racer is done, also when there is nobody left to watch.
    if ((w.active || (d.racing && d.done)) && (s.phase === 'countdown' || s.phase === 'racing')) {
      if (w.active) {
        camera.push(
          { id: 'director', label: 'Director', on: w.mode === 'director', run: () => w.setMode('director') },
          { id: 'follow', label: 'Follow', on: w.mode === 'follow', run: () => w.setMode('follow') },
        );
      }
      if (s.rules.freecam && info && !site.__nswsFreecamBlocked?.(info.trackData.getId(), true)) {
        const free = w.active && w.mode === 'free';
        camera.push({
          id: 'free',
          label: 'Free camera',
          on: free,
          run: () => {
            w.watchNow();
            w.setMode(free ? 'director' : 'free');
          },
        });
      }
      if (w.active && w.mode !== 'free') camera.push({ id: 'view', label: w.cockpit ? 'Chase view' : 'Cockpit view', run: () => ((w.cockpit = !w.cockpit), app.changed()) });
    }

    // The toolbar's quick round buttons on a desktop.
    const host: Item[] = [];
    const org = app.org;
    if (org && ['countdown', 'racing', 'warmup'].includes(s.phase)) {
      if (s.phase === 'racing') host.push({ id: 'end', label: 'End round', confirm: true, run: () => org.endRoundNow() });
      host.push({ id: 'again', label: 'Restart round', confirm: true, run: () => org.restartRound() }, { id: 'void', label: 'Void round', confirm: true, run: () => org.voidRound() });
    }

    return [
      { title: '', items: main },
      { title: 'Camera', items: camera },
      { title: 'Organizer', items: host },
    ];
  }
}
