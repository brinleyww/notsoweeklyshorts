// A Build Off's build time on this page: the editor (mod/nsws_editor.js) opens on a new track with a
// countdown bar, and once time is up the track open in it goes to the organizer by itself.
// Anyone not building (and a builder once the cup has their track) can watch another builder from the cup menu: the
// editor shows that builder's track as it is now and follows their camera (BE nsws_watch.js), while this player's own
// track waits untouched; it comes back when they stop watching. A builder's page only sends its track and camera
// while someone watches it (the organizer passes them on).
import type { App } from './app.ts';
import { beReady, ensureBE, isBE, site } from './game.ts';
import { player, type TrackMode } from './state.ts';

// A watched builder's track goes out at most this often (only when it changed), its camera twice a second.
const SNAP_MS = 2000;
const TICK_MS = 500;

interface EditorTrack {
  name: string;
  code: string;
  mode?: string;
}
interface BarBuilder {
  name: string;
  done: boolean;
  me: boolean;
  // Watching them: on this page, and how many watch them.
  watched?: boolean;
  watchers?: number;
  onWatch?: () => void;
}
interface CupBar {
  title: string;
  phase: string;
  status: string;
  sent: boolean;
  closed: boolean;
  // False for someone who only watches (no Send button).
  canSend: boolean;
  builders: BarBuilder[];
  // How many watch this page's player build.
  watchers: number;
  watching: {
    name: string;
    follow: boolean;
    onFollow: () => void;
    onPrev: (() => void) | null;
    onNext: (() => void) | null;
    onStop: () => void;
  } | null;
  left: () => number;
  onSubmit: () => void;
  onBack: () => void;
  onLeave: () => void;
  leaveLabel: string;
  // The organizer's build clock: +2 min and end now.
  more?: () => void;
  endNow?: () => void;
}
interface Editor {
  open(track?: unknown): void;
  close(): void;
  current?(): Promise<EditorTrack | null>;
  fresh?(): void;
  cup?(bar: CupBar | null): void;
  isOpen?(): boolean;
  note?(text: string, kind?: string): void;
  // The finish guard (BE nsws_cup.js); null when the editor can't answer.
  guard?(op: 'status' | 'lock' | 'unlock' | 'fill', extra?: Record<string, unknown>, ms?: number): Promise<GuardReply | null>;
  cupAlert?(text: string): void;
  // Watching another builder (BE nsws_watch.js, bridge 8); null when the editor can't answer.
  watch?(op: 'show' | 'stop' | 'cam' | 'view' | 'status', extra?: Record<string, unknown>, ms?: number): Promise<WatchReply | null>;
  // Whether the loaded editor can watch builders; null while it is still loading.
  canWatch?(): boolean | null;
}
interface GuardReply {
  ok?: boolean;
  start?: boolean;
  finish?: boolean;
  locked?: boolean;
  placed?: { start: boolean; finish: boolean };
}
interface WatchReply {
  ok?: boolean;
  watching?: boolean;
  follow?: boolean;
  v?: number[];
  // The part in hand: [id, x, y, z, rotation, axis, colour].
  hand?: number[] | null;
}

const moved = (a: number[] | null, b: number[]) => !a || a.some((x, i) => Math.abs(x - b[i]) > 0.05);
const handKey = (h: number[] | null | undefined) => (Array.isArray(h) && h.length === 7 && h.every(Number.isFinite) ? h.join(',') : '');

export class BuildDesk {
  #key = '';
  #closedFor = '';
  #opened = false;
  #busy = false;
  #barKey = '';
  #sent = '';
  // The empty track the editor started the build with: sending it unchanged means nothing was built.
  #blank = '';
  #blankWatch = 0;
  // The finish guard: a warning in the last 15 s with no finish, then only a finish can be placed in the last 3 s.
  #guardTimer = 0;
  #guardBusy = false;
  #locked = false;

  // The builder this page watches (their uid), the copy of their track on screen, and the latest copies received.
  watching: number | null = null;
  #shown = '';
  #showing = false;
  #follow = true;
  #snaps = new Map<number, string>();
  #cams = new Map<number, { v: number[]; h: number[] | null }>();
  // The editor was opened only to watch (someone not building): it closes again with the watching.
  #watchOpened = false;
  #noEditorTold = false;
  // This page's own build as last sent to its watchers.
  #streamCode = '';
  #streamAt = 0;
  #streamBusy = false;
  #camSent: number[] | null = null;
  #handSent = '';
  #camBusy = false;
  #statusBusy = false;

  constructor(private app: App) {
    window.setInterval(() => {
      try {
        this.#tick();
      } catch (error) {
        console.error('[Cuppa]', error);
      }
    }, TICK_MS);
  }

  get editor() {
    return site.__nswsEditor as Editor | undefined;
  }

  get available() {
    return !!this.editor?.current;
  }

  // Racers build; so does the organizer, even when only organizing.
  canBuild() {
    const app = this.app,
      me = app.self;
    return !!me && !me.bot && !me.out && (me.role === 'racer' || app.isHost);
  }

  // Watching builders: anyone not building, a builder once the cup has their track, and the organizer (host.ts mayWatch).
  canWatch() {
    const s = this.app.state,
      me = this.app.self;
    if (!s || s.phase !== 'build' || !s.build || s.build.closing || !me || me.bot || !this.editor?.watch) return false;
    return this.app.isHost || me.role !== 'racer' || !!me.out || !!this.mine();
  }

  // Everyone building in this cup, this page's player included.
  builders() {
    const s = this.app.state;
    if (!s) return [];
    const sent = new Set((s.custom ?? []).map((t) => t.by));
    return s.players.filter((p) => !p.bot && !p.away && (p.role === 'racer' || sent.has(p.u)));
  }

  watchersOf(u: number) {
    return this.app.state?.players.filter((p) => p.watch === u && p.u !== u && !p.away).length ?? 0;
  }

  // The track this page's player has in the cup, if any.
  mine() {
    const s = this.app.state;
    return s?.custom?.find((t) => t.by === this.app.me) ?? null;
  }

  update() {
    const s = this.app.state;
    const ed = this.editor;
    const building = !!s && s.phase === 'build' && !!s.build && this.canBuild();
    if (!building) {
      if (this.#key) {
        this.#key = '';
        this.#barKey = '';
        this.#stopGuard();
        if (this.watching == null) {
          ed?.cup?.(null);
          if (this.#opened && ed?.isOpen?.()) ed.close();
        }
        this.#opened = false;
      }
      if (this.watching != null) this.#pushBar();
      return;
    }
    const key = `${s.id}:${s.phaseAt}`;
    if (key !== this.#key) {
      this.#key = key;
      this.#sent = '';
      this.#blank = '';
      this.open(true);
      this.#watchBlank(key);
      this.#startGuard();
    }
    if (s.build!.closing && this.#closedFor !== key) {
      this.#closedFor = key;
      void this.#timeUp();
    }
    this.#pushBar();
  }

  open(fresh = false) {
    const ed = this.editor;
    if (!ed) return this.app.notify("The editor isn't available on this page.", 'bad');
    ed.open();
    if (fresh) ed.fresh?.();
    this.#opened = true;
    this.#barKey = '';
    this.#pushBar();
  }

  // ---- Watching ----

  watch(u: number) {
    const ed = this.editor;
    if (u === this.app.me) return;
    if (!ed?.watch) return this.app.notify("The editor isn't available on this page.", 'bad');
    if (!this.canWatch()) return this.app.notify(this.canBuild() ? 'Send your track to the cup first, then you can watch the others build.' : "Building is over.", 'bad');
    if (ed.canWatch?.() === false) return this.app.notify('The editor on this page is too old to watch builders. Reload the page.', 'bad');
    const was = this.watching;
    this.watching = u;
    this.#shown = '';
    this.#follow = true;
    if (!ed.isOpen?.()) {
      if (was == null && !this.#opened && !this.canBuild()) this.#watchOpened = true;
      ed.open();
    }
    this.#barKey = '';
    this.#pushBar();
    this.app.changed();
    const code = this.#snaps.get(u);
    if (code) void this.#show(u, code);
  }

  async stopWatching() {
    if (this.watching == null) return;
    this.watching = null;
    this.#shown = '';
    const ed = this.editor;
    await ed?.watch?.('stop', undefined, 8000).catch(() => null);
    this.#barKey = '';
    const s = this.app.state;
    const building = !!s && s.phase === 'build' && !!s.build && this.canBuild();
    if (!building) {
      ed?.cup?.(null);
      if (this.#watchOpened && ed?.isOpen?.()) ed.close();
    } else this.#pushBar();
    this.#watchOpened = false;
    this.app.changed();
  }

  // The builder before or after the one watched, in the cup's order.
  #step(dir: 1 | -1) {
    const list = this.builders().filter((p) => p.u !== this.app.me);
    if (list.length < 2 || this.watching == null) return null;
    const at = list.findIndex((p) => p.u === this.watching);
    return list[(at + dir + list.length) % list.length].u;
  }

  #setFollow(on: boolean) {
    this.#follow = on;
    const cam = this.watching != null ? this.#cams.get(this.watching) : undefined;
    void this.editor?.watch?.('view', { follow: on, ...(cam ? { v: cam.v } : {}) });
    this.#barKey = '';
    this.#pushBar();
  }

  onSnap(u: number, code: string) {
    if (typeof code !== 'string' || !code) return;
    this.#snaps.set(u, code);
    if (u === this.watching) void this.#show(u, code);
  }

  // The watched builder's camera (followed unless the player looks around) and the part in their hand (always shown).
  onCam(u: number, v: number[], h: number[] | null = null) {
    if (v.length !== 6 || !v.every(Number.isFinite)) return;
    const hand = handKey(h) ? h : null;
    this.#cams.set(u, { v, h: hand });
    if (u !== this.watching || !this.#shown) return;
    void this.editor?.watch?.('view', { v, hand }).then((r) => this.#followFrom(r));
  }

  #followFrom(r: WatchReply | null) {
    if (!r?.ok || r.follow == null || r.follow === this.#follow || this.watching == null) return;
    this.#follow = r.follow;
    this.#barKey = '';
    this.#pushBar();
  }

  // Puts a builder's track on screen. The first time, the editor must have this player's own track open, which it keeps.
  async #show(u: number, code: string) {
    if (this.#showing) return;
    const ed = this.editor;
    if (!ed?.watch) return;
    this.#showing = true;
    try {
      const own = await ed.current?.().catch(() => null);
      if (!own || this.watching !== u) return;
      const r = await ed.watch('show', { code }, 10_000);
      if (!r?.ok || this.watching !== u) return;
      this.#shown = code;
      this.#barKey = '';
      this.#pushBar();
      const cam = this.#cams.get(u);
      if (cam) void ed.watch('view', { v: cam.v, hand: cam.h, ...(this.#follow ? { follow: true } : {}) }).then((x) => this.#followFrom(x));
    } finally {
      this.#showing = false;
    }
  }

  #tick() {
    const s = this.app.state,
      ed = this.editor;
    if (!ed) return;
    if (this.watching != null) {
      const target = s ? player(s, this.watching) : undefined;
      if (!this.canWatch() || !target || target.away) void this.stopWatching();
      else {
        if (ed.canWatch?.() === false) {
          if (!this.#noEditorTold) this.app.notify('The editor on this page is too old to watch builders. Reload the page.', 'bad');
          this.#noEditorTold = true;
          void this.stopWatching();
          return;
        }
        const code = this.#snaps.get(this.watching);
        if (code && code !== this.#shown) void this.#show(this.watching, code);
        else if (this.#shown && !this.#statusBusy) {
          // Put away (Back, Esc) or reloaded: the editor stopped watching on its own.
          this.#statusBusy = true;
          void ed
            .watch?.('status')
            .then((r) => {
              if (r?.ok && !r.watching && this.watching != null && this.#shown) void this.stopWatching();
              else this.#followFrom(r ?? null);
            })
            .finally(() => (this.#statusBusy = false));
        }
      }
    }
    this.#stream();
  }

  // While someone watches this page's player build: their track (when it changed) and their camera.
  #stream() {
    const s = this.app.state,
      me = this.app.me,
      ed = this.editor;
    const watched = !!s && !!ed && me != null && s.phase === 'build' && !!s.build && !s.build.closing && this.canBuild() && this.watchersOf(me) > 0;
    if (!watched) {
      this.#streamCode = '';
      this.#camSent = null;
      this.#handSent = '';
      return;
    }
    const now = Date.now();
    if (now - this.#streamAt >= SNAP_MS && !this.#streamBusy && ed.current) {
      this.#streamAt = now;
      this.#streamBusy = true;
      void ed
        .current()
        .catch(() => null)
        .then((t) => {
          if (t?.code && t.code !== this.#streamCode && this.app.state?.phase === 'build') {
            this.#streamCode = t.code;
            this.app.sendBuildSnap(t.code);
          }
        })
        .finally(() => (this.#streamBusy = false));
    }
    // The camera and the part in hand only while this player looks at their own track.
    if (this.watching == null && !this.#camBusy && ed.isOpen?.() && ed.watch) {
      this.#camBusy = true;
      void ed
        .watch('cam')
        .then((r) => {
          const v = r?.ok && Array.isArray(r.v) && r.v.length === 6 && r.v.every(Number.isFinite) ? r.v : null;
          const hand = handKey(r?.hand);
          if (v && (moved(this.#camSent, v) || hand !== this.#handSent)) {
            this.#camSent = v;
            this.#handSent = hand;
            this.app.sendBuildCam(v, hand ? r!.hand! : null);
          }
        })
        .finally(() => (this.#camBusy = false));
    }
  }

  // ---- Building ----

  #watchBlank(key: string) {
    clearInterval(this.#blankWatch);
    const started = Date.now();
    this.#blankWatch = window.setInterval(async () => {
      if (this.#key !== key || Date.now() - started > 180_000) return clearInterval(this.#blankWatch);
      const t = await this.editor?.current?.().catch(() => null);
      if (this.#key !== key || !t?.code || !/^unnamed/i.test(t.name)) return;
      clearInterval(this.#blankWatch);
      this.#blank = this.#idOf(t.code) ?? '';
    }, 1000);
  }

  #idOf(code: string) {
    try {
      return this.app.native.parse(code)?.trackData?.getId() ?? null;
    } catch {
      return null;
    }
  }

  #pushBar() {
    const app = this.app,
      s = app.state,
      ed = this.editor;
    if (!s?.build || !ed?.cup) return;
    const mine = this.mine();
    const closing = !!s.build.closing;
    const canSend = this.canBuild();
    const target = this.watching != null ? player(s, this.watching) : undefined;
    const sent = new Set((s.custom ?? []).map((t) => t.by));
    const canWatch = this.canWatch();
    const builders = this.builders().map((p) => {
      const me = p.u === app.me;
      return {
        name: p.name,
        done: sent.has(p.u),
        me,
        watched: p.u === this.watching,
        watchers: this.watchersOf(p.u),
        onWatch: canWatch && !me ? () => (p.u === this.watching ? void this.stopWatching() : this.watch(p.u)) : undefined,
      };
    });
    const watchers = app.me != null ? this.watchersOf(app.me) : 0;
    let status: string;
    if (target) status = this.#shown ? `Watching ${target.name} build. Your own track is kept and comes back when you stop.` : `Waiting for ${target.name}'s track…`;
    else if (!canSend) status = closing ? "Time's up. Collecting the tracks…" : 'Click a builder above to watch them build.';
    else if (closing) status = mine ? `Time's up. The cup has "${mine.name}".` : "Time's up. Sending your track…";
    else if (mine) status = `The cup has "${mine.name}". Send again after more changes, or click a builder to watch them.`;
    else status = 'Build a track with a start and a finish, then send it. It goes by itself when time runs out.';
    const per = s.rules.perTrack;
    const phase = closing ? 'Collecting the tracks' : `Build Off · then ${per} round${per === 1 ? '' : 's'} on every track`;
    const org = !!app.org;
    const follow = this.#follow;
    const key = JSON.stringify([status, !!mine, closing, canSend, phase, s.name, builders.map((b) => [b.name, b.done, b.me, b.watched, b.watchers, !!b.onWatch]), watchers, this.watching, follow]);
    if (key === this.#barKey) return;
    this.#barKey = key;
    ed.cup({
      title: s.name || 'Cup',
      phase,
      status,
      sent: !!mine,
      closed: closing,
      canSend,
      builders,
      watchers,
      watching: target
        ? {
            name: target.name,
            follow,
            onFollow: () => this.#setFollow(!this.#follow),
            onPrev: this.#step(-1) != null ? () => this.watch(this.#step(-1)!) : null,
            onNext: this.#step(1) != null ? () => this.watch(this.#step(1)!) : null,
            onStop: () => void this.stopWatching(),
          }
        : null,
      left: () => (this.app.state?.build?.until ?? 0) - this.app.now(),
      onSubmit: () => void this.submit(false),
      onBack: () => {
        void this.stopWatching();
        ed.close();
        this.app.onOpenPanel();
      },
      onLeave: () => {
        void this.stopWatching();
        ed.close();
        this.app.onLeave(org ? 'You closed the cup.' : '');
      },
      leaveLabel: org ? 'Close the cup' : 'Leave cup',
      more: org && !closing ? () => this.app.org?.buildMore(120) : undefined,
      endNow: org && !closing ? () => this.app.org?.buildNow() : undefined,
    });
  }

  // The cup layer is hidden while the editor covers the screen, so its notes go to the editor's bar then.
  #say(text: string, tone: 'info' | 'bad' | 'good' = 'info') {
    const ed = this.editor;
    if (ed?.note && ed.isOpen?.() && !this.app.state?.build?.closing) ed.note(text, tone === 'info' ? '' : tone);
    else this.app.notify(text, tone);
  }

  // Sends the editor's open track; auto is the send when time runs out. While watching, the editor answers with this
  // player's own track (BE nsws_bridge.js), never the one on screen.
  async submit(auto: boolean) {
    const app = this.app,
      ed = this.editor;
    if (this.#busy || !ed?.current) return;
    this.#busy = true;
    try {
      const t = await ed.current().catch(() => null);
      if (!t?.code) {
        this.#say(auto ? "Your editor had no track open, so nothing was sent." : 'Open or build a track in the editor first.', 'bad');
        return;
      }
      if (t.code === this.#sent && this.mine()) {
        if (!auto) this.#say('The cup already has this version of your track.', 'info');
        return;
      }
      if (isBE(t.code) && !beReady()) {
        const error = await ensureBE();
        if (error) return this.#say(error, 'bad');
      }
      if (this.#blank && this.#idOf(t.code) === this.#blank) {
        this.#say(auto ? "You didn't build anything, so no track was sent." : 'Build something first: this is still the empty track.', 'bad');
        return;
      }
      const error = app.uploadTrack(t.code, t.mode as TrackMode);
      if (error) {
        this.#say(auto ? `Your track wasn't sent: ${error}` : error, 'bad');
        return;
      }
      this.#sent = t.code;
      if (!app.org) this.#say('Sending your track…', 'info');
    } finally {
      this.#busy = false;
    }
  }

  async #timeUp() {
    // The player's own track back on screen first: the start and finish are filled in on it.
    await this.stopWatching();
    // A send already on its way finishes first.
    while (this.#busy) await new Promise((r) => setTimeout(r, 100));
    this.#guardOff();
    if (this.editor?.isOpen?.() || this.#opened) {
      await this.#complete();
      await this.submit(true);
    }
    if (this.editor?.isOpen?.()) this.editor.close();
  }

  // A track sent at time up with no start or no finish gets them first, at the ends of its road, so the cup can race it.
  // Anything going wrong leaves the track as it is.
  async #complete() {
    const ed = this.editor;
    if (!ed?.guard || !ed.current) return;
    try {
      const t = await ed.current().catch(() => null);
      if (!t?.code || (this.#blank && this.#idOf(t.code) === this.#blank)) return;
      const r = await ed.guard('fill', undefined, 6000);
      const p = r?.ok ? r.placed : null;
      if (!p || (!p.start && !p.finish)) return;
      this.app.notify(p.start && p.finish ? 'Your track had no start or finish, so both were added.' : p.finish ? 'Your track had no finish, so one was added at the end of your road.' : 'Your track had no start, so one was added at the start of your road.', 'info');
    } catch {}
  }

  #startGuard() {
    clearInterval(this.#guardTimer);
    this.#guardTimer = window.setInterval(() => void this.#guardTick(), 500);
  }

  #stopGuard() {
    clearInterval(this.#guardTimer);
    this.#guardTimer = 0;
    this.#guardOff();
  }

  #guardOff() {
    const ed = this.editor;
    ed?.cupAlert?.('');
    if (this.#locked) void ed?.guard?.('unlock');
    this.#locked = false;
  }

  #left() {
    const b = this.app.state?.build;
    return b && !b.closing && this.app.state?.phase === 'build' ? b.until - this.app.now() : null;
  }

  async #guardTick() {
    const ed = this.editor;
    const left = this.#left();
    if (left == null || !ed?.guard || this.#guardBusy) return;
    // The guard looks at the player's own track, which isn't on screen while they watch someone.
    if (left > 15_000 || this.watching != null) return this.#guardOff();
    if (left <= 0) return;
    this.#guardBusy = true;
    try {
      const r = await ed.guard('status');
      const now = this.#left();
      if (!r?.ok || now == null) return;
      if (r.finish) return this.#guardOff();
      const open = !!ed.isOpen?.();
      // The editor lets go by itself when it is put away.
      if (!open) this.#locked = false;
      else if (now <= 3000 && !this.#locked) this.#locked = !!(await ed.guard('lock', { ms: now + 1500 }))?.locked;
      if (this.#left() == null) return this.#guardOff();
      const secs = Math.max(1, Math.ceil(now / 1000));
      ed.cupAlert?.(this.#locked ? `Place a finish! ${secs} s left. Only the finish can be placed now.` : `Place a finish! ${secs} s left.`);
    } finally {
      this.#guardBusy = false;
    }
  }
}
