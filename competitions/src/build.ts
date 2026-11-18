// A Build Off's build time on this page: the editor (mod/nsws_editor.js) opens on a new track with a
// countdown bar, and once time is up the track open in it goes to the organizer by itself.
import type { App } from './app.ts';
import { beReady, ensureBE, isBE, site } from './game.ts';
import type { TrackMode } from './state.ts';

interface EditorTrack {
  name: string;
  code: string;
  mode?: string;
}
interface CupBar {
  title: string;
  phase: string;
  status: string;
  sent: boolean;
  closed: boolean;
  builders: { name: string; done: boolean; me: boolean }[];
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
}
interface GuardReply {
  ok?: boolean;
  start?: boolean;
  finish?: boolean;
  locked?: boolean;
  placed?: { start: boolean; finish: boolean };
}

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

  constructor(private app: App) {}

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
        ed?.cup?.(null);
        if (this.#opened && ed?.isOpen?.()) ed.close();
        this.#opened = false;
      }
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
    const s = this.app.state,
      ed = this.editor;
    if (!s?.build || !ed?.cup) return;
    const mine = this.mine();
    const closing = !!s.build.closing;
    const status = closing ? (mine ? `Time's up. The cup has "${mine.name}".` : "Time's up. Sending your track…") : mine ? `The cup has "${mine.name}". Send again after more changes.` : 'Build a track with a start and a finish, then send it. It goes by itself when time runs out.';
    const sent = new Set((s.custom ?? []).map((t) => t.by));
    const builders = s.players
      .filter((p) => !p.bot && !p.away && (p.role === 'racer' || sent.has(p.u)))
      .map((p) => ({ name: p.name, done: sent.has(p.u), me: p.u === this.app.me }));
    const per = s.rules.perTrack;
    const phase = closing ? 'Collecting the tracks' : `Build Off · then ${per} round${per === 1 ? '' : 's'} on every track`;
    const org = !!this.app.org;
    const key = JSON.stringify([status, !!mine, closing, phase, s.name, builders]);
    if (key === this.#barKey) return;
    this.#barKey = key;
    ed.cup({
      title: s.name || 'Cup',
      phase,
      status,
      sent: !!mine,
      closed: closing,
      builders,
      left: () => (this.app.state?.build?.until ?? 0) - this.app.now(),
      onSubmit: () => void this.submit(false),
      onBack: () => {
        ed.close();
        this.app.onOpenPanel();
      },
      onLeave: () => {
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

  // Sends the editor's open track; auto is the send when time runs out.
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
    if (left > 15_000) return this.#guardOff();
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
