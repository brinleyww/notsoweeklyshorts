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
    if (this.editor?.isOpen?.() || this.#opened) await this.submit(true);
    if (this.editor?.isOpen?.()) this.editor.close();
  }
}
