// The cup panel (Tab): overview and setup, standings, rounds, players, tracks and rules,
// with the cup chat alongside.
import type { App } from '../app.ts';
import { canRace, humanRacers, leaderPoints, racers } from '../engine.ts';
import { cleanRules, deletePreset, fmtDuration, FORMATS, formatById, MAX_BOTS, MAX_RACERS, parsePresetText, pointsCurve, presetText, PRODUCT, rulesSummary, savedPresets, savePreset, type PointsCurve, type Rules } from '../rules.ts';
import { player, standings, type Category, type CupState, type CustomTrack, type Player, type TrackMode, type TrackRef, isFinalist } from '../state.ts';
import { btn, click, confirmBtn, range, flag, fmtClock, fmtTime, h, icon, ordinal, fill, toggle } from './dom.ts';
import { poolLabel, type MapPool } from './hub.ts';
import { nameColor } from './hud.ts';
import { isPhone, isTouch } from './touch.ts';
import { beReady, ensureBE, isBE, site } from '../game.ts';
import { UPLOAD_CHUNK } from '../protocol.ts';

const MODE_LABEL: Record<TrackMode, string> = { normal: '', rocket: 'Rocket League', royale: 'Royale' };

// chat: only on a phone, where the panel is one column.
type Tab = 'cup' | 'standings' | 'rounds' | 'players' | 'tracks' | 'chat';

const botTag = (p: Player | undefined) => (p?.bot ? h('span', { class: 'badge', style: 'color:var(--dim)', title: `Computer racer · skill ${p.bot.s}` }, 'BOT') : null);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
// "3 racers + 2 bots": people and bots on the grid, counted apart.
function gridCount(s: CupState) {
  const people = humanRacers(s).length,
    bots = racers(s).length - people;
  return plural(people, 'racer') + (bots ? ` + ${plural(bots, 'bot')}` : '');
}

const PHASE_TEXT: Record<CupState['phase'], string> = {
  lobby: 'Lobby',
  build: 'Building',
  draft: 'Pick & ban',
  loading: 'Loading',
  warmup: 'Warm-up',
  countdown: 'Starting',
  racing: 'Racing',
  checking: 'Checking',
  results: 'Results',
  vote: 'Track vote',
  podium: 'Finished',
};

export class Panel {
  el = h('div', { class: 'panel-wrap', hidden: true });
  tab: Tab = 'cup';
  #key = '';
  #chatKey = '';
  #side = h('aside', { class: 'side' });
  // Built once: only the header and the main column are rebuilt, so the chat keeps its focus.
  #head = h('header');
  #main = h('div', { class: 'main' });
  #frame = h('div', { class: 'panel' });
  #mounted = false;
  #draft: { format: string; rules: Rules } | null = null;
  #search = '';
  onKeys: () => void = () => {};
  #shoutInput = (() => {
    const input = h('input', { class: 'text', placeholder: 'Announce to everyone…', maxlength: 140, style: 'width:190px;font-size:15px' }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) {
        this.app.org?.shout(input.value);
        input.value = '';
      }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    return input;
  })();

  // Only the site's owner may save a bot's inputs (checked once, on the organizer's page).
  #owner = false;
  #ownerAsked = false;

  constructor(private app: App) {}

  get open() {
    return !this.el.hidden;
  }

  openChat() {
    this.setOpen(true);
    if (isPhone()) this.tab = 'chat';
    this.render(true);
    this.#chatUi?.input.focus();
  }

  setOpen(open: boolean) {
    if (open === this.open) return;
    if (open && this.tab === 'chat') this.tab = 'cup';
    this.el.hidden = !open;
    this.app.panelOpen = open;
    this.#key = '';
    this.#chatKey = '';
    const active = (this.el.getRootNode() as ShadowRoot).activeElement;
    if (!open && active instanceof HTMLElement && this.el.contains(active)) active.blur();
    this.app.changed();
  }

  render(force = false) {
    const app = this.app,
      s = app.state;
    if (!this.open || !s) {
      if (!s) this.el.hidden = true;
      return;
    }
    // Never rebuild under someone typing (or dragging a slider) in the main column.
    const active = (this.el.getRootNode() as ShadowRoot).activeElement;
    if (!force && active && this.#main.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) {
      this.#renderChat();
      return;
    }
    const phone = isPhone();
    if (!phone && this.tab === 'chat') this.tab = 'cup';
    const key = JSON.stringify([
      this.tab,
      phone,
      isTouch(),
      phone && this.tab !== 'chat' ? app.chat.cup.unread + app.chat.unreadAll : 0,
      s.seq,
      s.phase,
      app.history.length,
      app.lobby.map((p) => p.id),
      app.me,
      this.#draft,
      this.#search,
      app.org?.queued?.id,
      app.code,
      this.tab === 'players' ? Math.floor(Date.now() / 2000) : 0,
      s.phase === 'build' && this.tab === 'cup' ? Math.floor(app.now() / 1000) : 0,
      app.saved.size,
      [...this.#saving],
    ]);
    if (key !== this.#key) {
      this.#key = key;
      this.#build(s);
    }
    this.#renderChat();
  }

  #build(s: CupState) {
    const app = this.app;
    const scroll = this.el.querySelector('.content')?.scrollTop ?? 0;
    const header = [
      h('div', { class: 'brand' }, h('span', { class: 'bolt' }, icon('cuppa')), h('b', null, PRODUCT)),
      h(
        'div',
        { class: 'titles' },
        h('h1', { class: 'ell' }, s.name),
        h(
          'div',
          { class: 'meta' },
          h('span', { class: 'chip ' + (['racing', 'countdown'].includes(s.phase) ? 'live' : 'amber') }, PHASE_TEXT[s.phase]),
          h('span', { class: 'ell' }, `${formatById(s.format)?.name ?? s.format} · ${rulesSummary(s.rules)}${s.rules.bots ? ` · ${plural(s.rules.bots, 'bot')}` : ''}`),
        ),
      ),
      app.code
        ? h(
            'div',
            { class: 'code' },
            h('span', { class: 'c mono' }, app.code),
            btn(icon('copy'), () => this.#copy(app.code!, 'Code copied'), 'small ghost icon', 'Copy the code'),
            btn(icon('link'), () => this.#copy(this.#link(), 'Invite link copied'), 'small ghost icon', 'Copy an invite link'),
          )
        : null,
      btn(icon('keyboard'), () => this.onKeys(), 'small ghost icon keysbtn', 'Keys'),
      btn(icon('x'), () => this.setOpen(false), 'small ghost icon', 'Close (Tab or Esc)'),
    ];
    if (s.rules.casual && this.tab === 'standings') this.tab = 'cup';
    const tabs: [Tab, string, string, string | number | null][] = [
      ['cup', 'Cup', 'cuppa', null],
      ...(s.rules.casual ? [] : [['standings', 'Standings', 'trophy', null] as [Tab, string, string, null]]),
      ['rounds', 'Rounds', 'flag', app.history.filter((x) => !x.void).length || null],
      ['players', 'Players', 'users', s.players.filter((p) => !p.away && !(p.bot && p.role !== 'racer')).length],
    ];
    tabs.push(['tracks', 'Tracks', 'search', null]);
    const phone = isPhone();
    if (phone) tabs.push(['chat', 'Chat', 'chat', this.tab === 'chat' ? null : app.chat.cup.unread + app.chat.unreadAll || null]);
    const chatting = phone && this.tab === 'chat';
    // On a phone only the Start button stays pinned; the other controls scroll with the Cup tab.
    const pinned = !phone || (app.isHost && s.phase === 'lobby');
    const controls = pinned || this.tab === 'cup' ? this.#controls(s) : null;
    const tabBar = h(
      'div',
      { class: 'tabs' },
      tabs.map(([id, label, ic, count]) =>
        h('button', { class: 'tab' + (this.tab === id ? ' on' : ''), onclick: click(() => ((this.tab = id), (this.#key = ''), this.render())) }, icon(ic), label, count != null ? h('span', { class: 'count' }, String(count)) : null),
      ),
    );
    const inline = pinned ? null : controls;
    const content = h('div', { class: 'content' }, app.isHost ? inline : null, chatting ? null : this.#content(s), app.isHost ? null : inline);
    if (!this.#mounted) {
      this.#mounted = true;
      fill(this.el, h('div', { class: 'scrim', onclick: () => this.setOpen(false) }), this.#frame);
      fill(this.#frame, this.#head, this.#main, this.#side);
    }
    const wasChatting = this.#frame.classList.contains('chatting');
    toggle(this.#frame, 'phone', phone);
    toggle(this.#frame, 'chatting', chatting);
    fill(this.#head, ...header);
    fill(this.#main, tabBar, chatting ? null : content, !chatting && pinned ? controls : null);
    content.scrollTop = this.tab === this.#builtTab ? scroll : 0;
    this.#builtTab = this.tab;
    // The chat couldn't scroll while it was hidden behind another tab.
    if (chatting && !wasChatting) {
      this.#chatKey = '';
      this.#chatToEnd = true;
    }
  }
  #builtTab: Tab = 'cup';
  #chatToEnd = false;

  #content(s: CupState) {
    switch (this.tab) {
      case 'cup':
        return this.#cupTab(s);
      case 'standings':
        return this.#standingsTab(s);
      case 'rounds':
        return this.#roundsTab(s);
      case 'players':
        return this.#playersTab(s);
      case 'tracks':
        return this.#tracksTab(s);
      case 'chat':
        return null;
    }
  }

  // ---- Cup tab ----

  #cupTab(s: CupState) {
    const app = this.app;
    const out: (HTMLElement | null)[] = [];
    const me = app.self;
    if (s.phase === 'lobby') {
      out.push(this.#inviteHero(s));
      out.push(this.#roleChooser(s));
      out.push(this.#sourceSection(s));
      out.push(this.#modeSection(s));
      if (!s.rules.build && !s.rules.casual) out.push(this.#formatSection(s));
      // Every rule of the chosen format can be changed right here, one by one.
      out.push(...this.#rulesTab(s));
    } else {
      if (s.phase === 'podium') out.push(this.#saveSection(s));
      if (s.phase === 'build') out.push(this.#buildSection(s));
      out.push(this.#statusHero(s));
      if (me) out.push(this.#roleChooser(s));
      out.push(this.#skipVote(s));
      // The invite stays here all cup long; the table is a tab of its own.
      out.push(this.#inviteHero(s));
      out.push(this.#sourceSection(s));
      out.push(...this.#rulesTab(s));
    }
    return out;
  }

  // While everyone builds: the clock, who has sent a track, and the way into the editor.
  #buildSection(s: CupState) {
    const app = this.app,
      b = s.build;
    if (!b) return null;
    const desk = app.build;
    const mine = desk.mine();
    const sent = new Map((s.custom ?? []).map((t) => [t.by, t]));
    const builders = desk.builders();
    const canWatch = !b.closing && desk.canWatch();
    // A builder still building is told why they can't watch yet.
    const watchLater = !b.closing && !canWatch && desk.canBuild() && !mine;
    const acts: (HTMLElement | null)[] = [];
    if (!b.closing && desk.canBuild()) {
      acts.push(btn([icon('hammer'), mine ? 'Back to the editor' : 'Open the editor'], () => (this.setOpen(false), desk.open()), 'primary'));
      acts.push(btn('Send my track', () => desk.submit(false), 'ghost'));
    }
    if (!b.closing && app.org) {
      acts.push(btn([icon('clock'), '+2 min'], () => app.org!.buildMore(120), 'small ghost'));
      acts.push(confirmBtn('End building now', () => app.org!.buildNow(), 'small'));
    }
    return h(
      'div',
      { class: 'sect' },
      h('div', { class: 'hero' }, h('span', { class: 'mark' }, icon('hammer')), h('div', { class: 'grow' }, h('div', { class: 'big' }, b.closing ? "Time's up · collecting the tracks" : `Build time · ${fmtClock(b.until - app.now())} left`), h('p', null, mine ? `The cup has your track "${mine.name}". Send it again after more changes, or watch the others build meanwhile.` : desk.canBuild() ? 'Build a track with a start and a finish. Whatever is open in your editor goes to the cup when time runs out.' : canWatch ? 'The racers are building. Watch any of them below, or practice on the lobby track meanwhile.' : 'The racers are building. You can practice on the lobby track meanwhile.')), h('div', { class: 'share' }, acts)),
      h(
        'div',
        { class: 'list' },
        builders.map((p) => {
          const t = sent.get(p.u);
          const me = p.u === app.me;
          const eyes = desk.watchersOf(p.u);
          const on = desk.watching === p.u;
          const watch = me
            ? null
            : canWatch
              ? btn([icon('eye'), on ? 'Stop watching' : 'Watch'], () => (on ? void desk.stopWatching() : (this.setOpen(false), desk.watch(p.u))), on ? 'small' : 'small ghost')
              : watchLater
                ? h('span', { class: 'dim', style: 'font-size:14px', title: 'Send your track to the cup, then you can watch the others build' }, 'Watch after you send')
                : null;
          const sub = (t ? `Sent "${t.name}"` : 'Building…') + (eyes ? ` · ${eyes} watching` : '');
          return h('div', { class: 'prow' + (me ? ' me' : '') }, h('span', { class: 'mark' }, icon(t ? 'check' : 'hammer')), h('div', { class: 'grow' }, h('div', { class: 'ell' }, `${flag(p.cc)} ${p.name}`), h('div', { class: 'sub ell' }, sub)), watch);
        }),
      ),
    );
  }

  // After the cup: every uploaded track, to keep in My Tracks.
  #saveSection(s: CupState) {
    const app = this.app;
    const lib = site.__nswsTracks;
    const list = s.custom ?? [];
    if (!list.length || !lib?.add) return null;
    void app.checkSaved(list.map((t) => t.id));
    const played = new Set(s.played ?? []);
    const order = [...list.filter((t) => played.has(t.id)), ...list.filter((t) => !played.has(t.id))];
    const left = order.filter((t) => !app.saved.has(t.id));
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, list.length === 1 ? 'Save the track from this cup' : 'Save tracks from this cup', h('span', { class: 'grow' }), left.length > 1 ? btn([icon('save'), 'Save all'], () => this.#saveMany(left), 'small') : null),
      h('p', { class: 'dim', style: 'margin:0 0 10px;font-size:15px;line-height:1.35' }, 'Keep the ones you liked. They go to My Tracks, where you can race them again, edit them or share them.'),
      h('div', { class: 'list' }, order.map((t) => this.#trackRow(s, t, played.has(t.id) ? 'raced' : 'not raced'))),
    );
  }

  #saving = new Set<string>();
  #saveBtn(t: CustomTrack) {
    const app = this.app;
    if (!site.__nswsTracks?.add) return null;
    if (app.saved.has(t.id)) return h('span', { class: 'dim', style: 'font-size:15px;padding:0 6px' }, icon('check'), ' Saved');
    const busy = this.#saving.has(t.id);
    return btn([icon('save'), busy ? 'Saving…' : 'Save'], () => !busy && this.#saveMany([t]), 'small ghost', 'Save to My Tracks');
  }

  async #saveMany(list: CustomTrack[]) {
    const app = this.app;
    let ok = 0;
    for (const t of list) {
      if (this.#saving.has(t.id) || app.saved.has(t.id)) continue;
      this.#saving.add(t.id);
      this.render(true);
      try {
        await app.saveTrack(t);
        ok++;
      } catch (e) {
        app.notify((e as Error)?.message || `Couldn't save ${t.name}.`, 'bad');
      } finally {
        this.#saving.delete(t.id);
      }
    }
    this.render(true);
    if (ok) app.notify(ok === 1 ? (list.length === 1 ? `Saved ${list[0].name} to My Tracks` : 'Saved 1 track to My Tracks') : `Saved ${ok} tracks to My Tracks`, 'good');
  }

  // One uploaded track: who added it, and remove / save.
  #trackRow(s: CupState, t: CustomTrack, note = '') {
    const app = this.app,
      org = app.org;
    const mine = !!org || t.by === app.me;
    const canRemove = mine && (s.phase === 'lobby' || !s.rules.build);
    return h(
      'div',
      { class: 'prow' },
      h('div', { class: 'grow' }, h('div', { class: 'ell' }, t.name), h('div', { class: 'sub ell' }, [t.author ? `by ${t.author}` : '', `added by ${player(s, t.by)?.name ?? t.bn ?? 'a racer who left'}`, MODE_LABEL[t.mode ?? 'normal'], note].filter(Boolean).join(' · '))),
      this.#saveBtn(t),
      canRemove ? btn('Remove', () => (org ? org.removeTrack(org.me, t.id) : app.act({ k: 'act', a: 'untrack', v: t.id })), 'small ghost') : null,
    );
  }

  // Custom tracks (and adding them) or the Build Off clock. Where the tracks come from is picked when the room opens.
  #sourceSection(s: CupState) {
    const { app, host, lobby, r, seg, slider } = this.#ruleKit(s);
    if (!r.customTracks && !r.build) return null;
    const custom = r.customTracks && !r.build;
    // A Build Off lists only the tracks built in it.
    const uploads = r.build && !s.built ? [] : (s.custom ?? []);
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, 'Tracks', h('span', { class: 'grow' }), r.customTracks && uploads.length ? h('span', { class: 'dim', style: 'font-size:14px' }, `${uploads.length} ${r.build ? 'built' : 'added'}`) : null),
      h(
        'div',
        { class: 'rules' },
        custom
          ? seg('customPick', 'Who adds tracks', r.customPick === 'organizer' ? 'Only you, the organizer' : 'Everyone in the cup, and you without a limit', [
              ['organizer', 'Organizer only'],
              ['everyone', 'Everyone'],
            ])
          : null,
        custom && r.customPick === 'everyone' ? slider('customLimit', 'Tracks per player', 'The organizer has no limit', 1, 10, 1, (n) => `${n}`) : null,
        r.build ? slider('build', 'Build time', lobby ? 'How long everyone gets in the editor' : 'Set when the cup started', 1, 30, 1, (n) => `${n} min`) : null,
      ),
      custom ? this.#uploadSection(s, true) : null,
      r.build && lobby && !uploads.length ? h('p', { class: 'dim', style: 'margin:10px 0 0;font-size:15px;line-height:1.35' }, host ? 'When you start, the editor opens for every racer with a new track and a countdown. Tracks go to the cup by themselves when time runs out.' : 'When the organizer starts, the editor opens with a new track and a countdown. Build something with a start and a finish!') : null,
      r.build && lobby && uploads.length && host ? h('p', { class: 'dim', style: 'margin:10px 0 0;font-size:15px;line-height:1.35' }, 'Start races these tracks again. Race again on new tracks (on the podium) builds new ones.') : null,
      r.customTracks && uploads.length && app.state?.phase !== 'podium' ? h('div', { class: 'list', style: 'margin-top:10px' }, [...uploads].reverse().map((t) => this.#trackRow(s, t))) : null,
      custom && !uploads.length && r.customOnly ? h('div', { class: 'empty' }, 'No tracks yet. The cup needs at least one before it can start.') : null,
    );
  }

  #roleChooser(s: CupState) {
    const app = this.app,
      me = app.self;
    if (!me) return h('div', { class: 'sect' }, h('div', { class: 'tile dim' }, 'Connecting to the organizer…'));
    const racing = me.role === 'racer';
    const allowed = canRace(s, me.u) || racing;
    const set = (role: 'racer' | 'spectator') => (app.org ? app.org.setRole(me.u, role) : app.act({ k: 'act', a: 'role', v: role }));
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, 'You'),
      h(
        'div',
        { class: 'you' + (me.out ? ' out' : racing ? ' racing' : '') },
        h('span', { class: 'mark' }, icon(me.out ? 'skull' : racing ? 'flag' : 'eye')),
        h('span', { class: 'state' }, me.out ? `Knocked out in round ${me.out}` : racing ? 'You are on the grid' : 'You are spectating'),
        me.out
          ? null
          : h(
              'div',
              { class: 'seg' },
              h('button', { class: racing ? 'on' : '', disabled: !allowed, onclick: click(() => set('racer')) }, 'Race'),
              h('button', { class: racing ? '' : 'on', onclick: click(() => set('spectator')) }, 'Watch'),
            ),
        !allowed && !racing ? h('span', { class: 'dim', style: 'font-size:14px;width:100%' }, s.rules.mode === 'knockout' ? 'Knockout cups lock the grid once they start.' : 'The grid is closed or full.') : null,
        racing && s.phase !== 'lobby' && !s.rules.casual ? h('span', { class: 'dim', style: 'font-size:14px;width:100%' }, 'Switching to Watch during a round retires you from it.') : null,
        app.bestRun() ? h('div', { class: 'clip' }, btn([icon('clip'), 'Clip my best run'], () => this.#clip(), 'small ghost')) : null,
      ),
    );
  }

  // Competitive (formats, points, a winner) or Casual (no clock, no points, no winner).
  #modeSection(s: CupState) {
    const host = this.app.isHost;
    const casual = s.rules.casual;
    const pickMode = (v: boolean) => {
      if (v === casual) return;
      const id = v ? 'casual' : s.rules.build ? 'build' : 'quickplay';
      this.#apply(id, { ...cleanRules(formatById(id)!.rules), uploads: s.rules.uploads, bots: s.rules.bots, botSkill: s.rules.botSkill });
    };
    const about = casual
      ? 'No time limit and no winner. Drive each track as long as you like, join any time, and vote for a new track when you are ready.'
      : 'Rounds against the clock, points and a champion';
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, 'Mode'),
      h(
        'div',
        { class: 'rules' },
        h(
          'div',
          { class: 'rule' },
          h('label', null, casual ? 'Casual' : 'Competitive', h('small', null, about)),
          h(
            'div',
            { class: 'seg' },
            h('button', { class: casual ? '' : 'on', disabled: !host, onclick: click(() => pickMode(false)) }, 'Competitive'),
            h('button', { class: casual ? 'on' : '', disabled: !host, onclick: click(() => pickMode(true)) }, 'Casual'),
          ),
        ),
      ),
    );
  }

  #formatSection(s: CupState) {
    const app = this.app;
    const host = app.isHost;
    const draft = this.#draft ?? { format: s.format, rules: s.rules };
    const formats = h(
      'div',
      { class: 'formats' },
      FORMATS.filter((f) => f.id !== 'build' && f.id !== 'casual').map((f) =>
        h(
          'button',
          {
            class: 'fmt' + (draft.format === f.id ? ' on' : ''),
            disabled: !host,
            onclick: click(() => this.#apply(f.id, { ...cleanRules(f.rules), uploads: s.rules.uploads })),
          },
          icon(f.icon),
          h('b', null, f.name),
          h('span', null, f.blurb),
        ),
      ),
    );
    const presets = host ? savedPresets() : [];
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, 'Format', h('span', { class: 'grow' }), host ? h('span', { class: 'dim', style: 'font-size:14px' }, 'Pick one to start from, then change any rule below') : null),
      formats,
      presets.length
        ? h(
            'div',
            { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center' },
            h('span', { class: 'dim', style: 'font-size:14px' }, 'Your presets:'),
            presets.map((p) =>
              h('span', { class: 'chip', style: 'pointer-events:auto;cursor:pointer', onclick: click(() => this.#apply('custom:' + p.name, p.rules)) }, p.name, h('span', { class: 'del', title: 'Delete', onclick: click(() => (deletePreset(p.name), (this.#key = ''), this.render())) }, ' ×')),
            ),
          )
        : null,
    );
  }

  #apply(format: string, rules: Rules) {
    const org = this.app.org;
    if (!org) return;
    const preset = format.startsWith('custom:');
    // A format only sets the racing rules: where the tracks come from stays (the Build Off format turns building on).
    const cur = this.app.state?.rules;
    const keep = preset || !cur ? {} : { customTracks: cur.customTracks, customOnly: cur.customOnly, customPick: cur.customPick, customLimit: cur.customLimit, build: format === 'build' ? cur.build || rules.build : cur.build };
    org.configure(preset ? format.slice(7) : format, { ...rules, ...keep });
    this.#draft = null;
    // The next room starts on the format chosen here.
    try {
      const saved = JSON.parse(localStorage.getItem('nsws-sc-host') || '{}');
      if (format === 'casual') localStorage.setItem('nsws-sc-host', JSON.stringify({ ...saved, casual: true }));
      else if (!preset) localStorage.setItem('nsws-sc-host', JSON.stringify({ ...saved, casual: false, ...(format !== 'build' ? { format } : {}) }));
    } catch {}
  }

  #statusHero(s: CupState) {
    const app = this.app,
      r = s.round;
    const table = standings(s, app.history);
    const myPos = table.findIndex((p) => p.u === app.me) + 1;
    const me = app.self;
    const goal = s.rules.casual
      ? 'Just for fun'
      : s.rules.mode === 'rounds'
        ? `Round ${s.rounds} of ${s.rules.rounds}`
        : s.rules.mode === 'knockout'
          ? `${gridCount(s)} left`
          : s.rules.finalist
            ? `Finalist at ${s.rules.target} pts`
            : `First to ${s.rules.target} pts`;
    return h(
      'div',
      { class: 'grid2', style: 'margin-bottom:18px;grid-template-columns:repeat(4,1fr)' },
      h('div', { class: 'tile stat' }, h('small', null, 'Now'), h('b', null, PHASE_TEXT[s.phase])),
      h('div', { class: 'tile stat' }, h('small', null, 'Track'), h('b', { class: 'ell' }, r?.track.name ?? '—')),
      h('div', { class: 'tile stat' }, h('small', null, 'Goal'), h('b', { class: 'ell' }, goal)),
      h('div', { class: 'tile stat' }, h('small', null, 'You'), h('b', null, s.rules.casual ? (me?.role === 'racer' ? 'Driving' : 'Watching') : me?.role === 'racer' || me?.pts ? (myPos ? [`${ordinal(myPos)} · `, isFinalist(s, me) ? h('span', { class: 'finalist' }, 'Finalist') : `${me?.pts ?? 0} pts`] : '—') : 'Watching')),
    );
  }

  #skipVote(s: CupState) {
    const app = this.app,
      r = s.round;
    if (!s.rules.skipVotes || !r || app.me == null || !r.racers.includes(app.me) || !['warmup', 'countdown', 'racing'].includes(s.phase)) return null;
    const here = r.racers.filter((u) => !player(s, u)?.away && !player(s, u)?.bot).length;
    const mine = r.skip.includes(app.me);
    return h(
      'div',
      { class: 'tile', style: 'display:flex;align-items:center;gap:12px;margin-bottom:18px' },
      h('span', { style: 'flex:1;font-size:17px' }, s.rules.casual ? `Ready for a new track? ${r.skip.length} of ${here} racers are. Over half changes it.` : `Skip this track? ${r.skip.length} of ${here} racers want to. Over half skips it.`),
      btn(mine ? 'Take back my vote' : s.rules.casual ? 'Vote for a new track' : 'Vote to skip', () => app.act({ k: 'act', a: 'skip' }), 'small'),
    );
  }

  // The cup's code and invite link. It sits on the Cup tab for the whole cup, not only the lobby:
  // people are sent a link mid-cup as well, and whether they can still race depends on late joiners.
  #inviteHero(s: CupState) {
    const app = this.app;
    const lobby = s.phase === 'lobby';
    const count = racers(s).length;
    const open = s.rules.lateJoin && s.rules.mode !== 'knockout';
    const head = lobby && !app.isHost ? 'Waiting for the organizer' : lobby && count >= 2 ? `${gridCount(s)} on the grid` : 'Invite some racers';
    const body = lobby
      ? app.isHost
        ? 'Share the code or the invite link. Everyone can practice on this track until you start.'
        : 'Practice on this track while you wait. The cup starts when the organizer is ready.'
      : `Share the code or the invite link. ${open ? 'Newcomers can still take a grid slot.' : 'The grid is closed, so they come in to watch.'}`;
    return h(
      'div',
      { class: 'hero' },
      h('span', { class: 'mark' }, icon(lobby && !app.isHost ? 'clock' : 'users')),
      h('div', { class: 'grow' }, h('div', { class: 'big' }, head), h('p', null, body)),
      h(
        'div',
        { class: 'share' },
        app.code ? h('button', { class: 'joincode', type: 'button', title: 'Copy the code', onclick: click(() => this.#copy(app.code!, 'Code copied')) }, h('small', null, 'Code'), h('b', null, app.code)) : null,
        app.code ? btn([icon('link'), 'Copy invite link'], () => this.#copy(this.#link(), 'Invite link copied')) : null,
        app.isHost && !app.code && app.connection
          ? h('span', { class: app.native.inviteError(app.connection) ? 'bad' : 'dim' }, app.native.inviteError(app.connection) ?? 'Getting a code…')
          : null,
      ),
    );
  }

  async #clip() {
    const result = await this.app.saveBestRun();
    this.app.notify(result === 'duplicate' ? 'That run is already in your clips' : result ? 'Saved to your clips' : "Couldn't save the clip", result ? 'good' : 'bad');
  }

  #standRow(s: CupState, u: number, pos: number) {
    const p = player(s, u)!;
    const sub = [
      p.wins ? `${p.wins} win${p.wins > 1 ? 's' : ''}` : '',
      (p.places[0] ?? 0) + (p.places[1] ?? 0) + (p.places[2] ?? 0) ? `${(p.places[0] ?? 0) + (p.places[1] ?? 0) + (p.places[2] ?? 0)} podiums` : '',
      p.best ? `best ${fmtTime(p.best)}` : '',
      p.out ? `out in round ${p.out}` : '',
      p.away ? 'disconnected' : '',
    ].filter(Boolean);
    return h(
      'div',
      { class: 'prow' + (u === this.app.me ? ' me' : '') + (p.away ? ' away' : '') },
      h('span', { class: 'pos mono ' + (pos === 1 ? 'amber' : '') }, String(pos)),
      h('div', { class: 'grow' }, h('div', { class: 'ell' }, `${flag(p.cc)} ${p.name}`, botTag(p)), sub.length ? h('div', { class: 'sub ell' }, sub.join(' · ')) : null),
      h('span', { class: 'pts mono' }, s.rules.mode === 'knockout' ? (p.out ? '—' : 'IN') : isFinalist(s, p) ? h('span', { class: 'finalist' }, 'Finalist') : String(p.pts)),
    );
  }

  // ---- Standings ----

  #standingsTab(s: CupState) {
    const app = this.app;
    const table = standings(s, app.history);
    if (!table.length) return h('div', { class: 'empty' }, 'Nobody is racing yet.');
    const rounds = app.history.filter((x) => !x.void).slice(-12);
    const matrix = rounds.length
      ? h(
          'div',
          { class: 'sect', style: 'overflow-x:auto' },
          h('h3', null, 'Round by round'),
          h(
            'table',
            { class: 'matrix' },
            h('thead', null, h('tr', null, h('th', { style: 'text-align:left' }, 'Racer'), rounds.map((r) => h('th', { title: r.track }, `R${r.n}`)), h('th', null, 'Total'))),
            h(
              'tbody',
              null,
              table.map((p) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'n' }, p.name),
                  rounds.map((r) => {
                    const row = r.rows.find((x) => x[0] === p.u);
                    return h('td', { class: row?.[2] === 1 ? 'w' : '' }, row ? (row[2] ? (s.rules.mode === 'knockout' ? ordinal(row[2]) : String(row[3])) : 'DNF') : '');
                  }),
                  h('td', { class: 'amber' }, s.rules.mode === 'knockout' ? (p.out ? `R${p.out}` : 'IN') : isFinalist(s, p) ? h('span', { class: 'finalist' }, 'Finalist') : String(p.pts)),
                ),
              ),
            ),
          ),
        )
      : null;
    return [h('div', { class: 'sect' }, h('h3', null, 'Standings'), h('div', { class: 'list' }, table.map((p, i) => this.#standRow(s, p.u, i + 1)))), matrix];
  }

  // Whether this organizer is the site owner (the bot inputs export and the world record bot are theirs).
  #askOwner() {
    if (!this.app.isHost || this.#ownerAsked) return;
    this.#ownerAsked = true;
    site.__nswsOwner
      ?.check()
      .then((ok) => {
        this.#owner = ok;
        this.#key = '';
        this.render();
      })
      .catch(() => {});
  }

  // ---- Rounds ----

  #roundsTab(s: CupState) {
    const hist = [...this.app.history].reverse();
    this.#askOwner();
    if (!hist.length) return h('div', { class: 'empty' }, 'Rounds show up here as they finish.');
    return h(
      'div',
      { class: 'history' },
      hist.map((r) =>
        h(
          'div',
          { class: 'round' },
          h('div', null, h('span', { class: 'amber' }, `${s.rules.casual ? 'Track' : 'Round'} ${r.n}`), h('span', { class: 'ell', style: 'flex:1' }, r.track), r.void ? h('span', { class: 'chip' }, 'Voided') : null),
          r.void
            ? null
            : h(
                'div',
                { class: 'rows' },
                r.rows.map((row) => [
                  h('span', { class: 'mono ' + (row[2] === 1 ? 'amber' : 'dim') }, row[2] ? String(row[2]) : '–'),
                  h('span', { class: 'ell' }, player(s, row[0])?.name ?? 'Left', botTag(player(s, row[0])), row[4] ? h('span', { class: 'bad', style: 'font-size:12px' }, '  OUT') : null, this.#inputsBtn(r.n, r.track, row[0], row[1])),
                  h('span', { class: 'mono' + (row[1] == null && !s.rules.casual ? ' bad' : '') }, row[1] != null ? fmtTime(row[1]) : s.rules.casual ? '—' : 'DNF'),
                  h('span', { class: 'mono amber' }, row[3] ? `+${row[3]}` : ''),
                ]),
              ),
        ),
      ),
    );
  }

  // The owner's button to save a finished bot's run as TAS inputs (a .txt file).
  #inputsBtn(n: number, track: string, u: number, time: number | null) {
    const p = player(this.app.state!, u);
    const text = this.#owner && p?.bot && time != null ? this.app.org?.botInputs(n, u) : null;
    if (!text) return null;
    const save = () => {
      const name = `${track} - ${p!.name} - ${fmtTime(time!).replace(/:/g, '.')}.txt`.replace(/[\\/:*?"<>|]+/g, '_');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    };
    const b = btn('Inputs', save, 'small ghost', "Save this bot's inputs (TAS text)");
    b.style.marginLeft = '8px';
    return b;
  }

  // ---- Players ----

  #playersTab(s: CupState) {
    const app = this.app;
    const host = app.isHost;
    const row = (p: CupState['players'][number]) => {
      // Pages that aren't driving send in one-second batches, so ping is only a rough link check.
      const ping = p.u === s.host ? 0 : p.ping;
      const pingCls = ping == null ? '' : ping < 120 ? '' : ping < 250 ? 'mid' : 'bad';
      const pingText = p.u === s.host ? 'organizer' : ping == null ? '…' : `${ping} ms`;
      const sub = p.away ? 'Disconnected · can rejoin with the same link' : p.out ? `Knocked out in round ${p.out}` : p.bot ? `Computer racer · skill ${p.bot.s}` : p.role === 'racer' ? 'Racing' : 'Watching';
      return h(
        'div',
        { class: 'prow' + (p.u === app.me ? ' me' : '') + (p.away ? ' away' : '') },
        h('span', { class: 'dot' + (p.away ? ' off' : '') }),
        h('div', { class: 'grow' }, h('div', { class: 'ell' }, `${flag(p.cc)} ${p.name}`, p.u === s.host ? h('span', { class: 'chip amber', style: 'margin-left:8px' }, 'Organizer') : null, botTag(p)), h('div', { class: 'sub' }, sub)),
        h('span', { class: 'ping mono ' + pingCls, title: 'Round trip to the organizer' }, p.pid == null || p.bot ? '' : pingText),
        host && p.u !== app.me
          ? h(
              'div',
              { class: 'acts' },
              p.bot
                ? null
                : p.role === 'racer'
                  ? btn(isTouch() ? 'To watch' : [icon('eye')], () => app.org!.setRole(p.u, 'spectator'), isTouch() ? 'small ghost' : 'small ghost icon', 'Move to spectators')
                  : btn(isTouch() ? 'To race' : [icon('flag')], () => app.org!.setRole(p.u, 'racer'), isTouch() ? 'small ghost' : 'small ghost icon', 'Put on the grid'),
              p.bot ? confirmBtn('Remove', () => app.org!.removeBot(p.u), 'small danger', 'Take this bot off the grid (one bot fewer)') : confirmBtn('Remove', () => app.org!.kick(p.u), 'small danger', 'Remove from the cup'),
            )
          : null,
      );
    };
    const racersList = s.players.filter((p) => p.role === 'racer');
    // Bots taken off the grid aren't watching anything.
    const watchers = s.players.filter((p) => p.role !== 'racer' && !p.bot);
    const people = racersList.filter((p) => !p.bot).length,
      bots = racersList.length - people;
    const known = new Set(s.players.map((p) => p.pid));
    const joining = app.lobby.filter((l) => !known.has(l.id));
    return [
      h('div', { class: 'sect' }, h('h3', null, `On the grid · ${people}/${MAX_RACERS}${bots ? ` + ${plural(bots, 'bot')}` : ''}`), racersList.length ? h('div', { class: 'list' }, racersList.map(row)) : h('div', { class: 'empty' }, 'Nobody is racing yet.')),
      h('div', { class: 'sect' }, h('h3', null, `Watching · ${watchers.length}`), watchers.length ? h('div', { class: 'list' }, watchers.map(row)) : h('div', { class: 'empty' }, 'No spectators.')),
      joining.length ? h('div', { class: 'sect' }, h('h3', null, 'Joining'), h('div', { class: 'list' }, joining.map((l) => h('div', { class: 'prow away' }, h('span', { class: 'spinner', style: 'width:16px;height:16px;border-width:3px' }), h('span', { class: 'grow ell' }, l.nickname))))) : null,
    ];
  }

  // ---- Tracks (organizer) ----

  // The cup's maps: the pool picked in the Competitions menu. Every page's track library is already
  // filtered to that pool (hub.ts sets __nswsCupPool both when hosting and when joining), so a racer
  // sees the same list as the organizer, who alone gets to play one next.
  #tracksTab(s: CupState) {
    const app = this.app;
    const org = app.org;
    const uploads = new Map(s.rules.customTracks ? (s.custom ?? []).map((t) => [t.id, t]) : []);
    let pool: TrackRef[] = org ? org.pool() : s.rules.customOnly ? [] : cupTracks(app);
    if (!org) {
      const have = new Set(pool.map((t) => t.id));
      pool = [...pool, ...[...uploads.values()].filter((t) => !have.has(t.id))];
    }
    // Uploads first, newest on top.
    pool = [...[...uploads.keys()].reverse().map((id) => pool.find((t) => t.id === id)).filter((t): t is TrackRef => !!t), ...pool.filter((t) => !uploads.has(t.id))];
    const q = this.#search.trim().toLowerCase();
    const list = pool.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.author ?? '').toLowerCase().includes(q)).slice(0, 120);
    const input = h('input', { class: 'text search', placeholder: `Search ${pool.length} tracks…`, value: this.#search, style: 'width:100%' }) as HTMLInputElement;
    input.addEventListener('input', () => {
      this.#search = input.value;
      const pos = input.selectionStart;
      this.render(true);
      const again = this.el.querySelector<HTMLInputElement>('.content input.search');
      again?.focus();
      if (pos != null) again?.setSelectionRange(pos, pos);
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const voting = !!org && s.phase === 'vote' && s.vote?.kind === 'host';
    const queued = org?.queued;
    const picked = site.__nswsCupPool ? poolLabel(site.__nswsCupPool as MapPool) : '';
    const maps = s.rules.customOnly ? 'Uploaded tracks' : s.rules.customTracks ? `${picked || 'This cup’s maps'} + uploads` : picked;
    return [
      h(
        'div',
        { class: 'sect' },
        h('h3', null, org ? (voting ? 'Pick the next track' : 'Play a track next') : "The cup's tracks"),
        h('p', { class: 'dim', style: 'margin:0 0 10px;font-size:15px;line-height:1.35' }, org ? (voting ? 'Choose any track below, or one of the options on screen.' : 'The track you pick replaces the next track change (vote, picks or random).') : 'Every track this cup can land on. Votes, picks and random all come out of this list.'),
        h('div', { class: 'poolline' }, h('span', { class: 'dim' }, 'Maps'), h('span', { class: 'grow' }, maps || 'This cup’s maps'), h('span', { class: 'faint mono' }, `${pool.length} track${pool.length === 1 ? '' : 's'}`)),
        queued ? h('div', { class: 'tile', style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px' }, h('span', { class: 'grow' }, 'Up next: ', h('span', { class: 'amber' }, queued.name)), btn('Clear', () => org!.queue(null), 'small ghost')) : null,
        input,
      ),
      s.rules.customTracks && !s.rules.build ? this.#uploadSection(s) : null,
      h(
        'div',
        { class: 'list' },
        list.map((t) => {
          const up = uploads.get(t.id);
          const mine = !!up && (!!org || up.by === app.me);
          return h(
            'div',
            { class: 'prow' },
            h('div', { class: 'grow' }, h('div', { class: 'ell' }, t.name), h('div', { class: 'sub' }, [t.author ? `by ${t.author}` : '', up ? `added by ${player(s, up.by)?.name ?? up.bn ?? 'a racer who left'}` : t.cat, MODE_LABEL[t.mode ?? up?.mode ?? 'normal']].filter(Boolean).join(' · '))),
            up ? this.#saveBtn(up) : null,
            mine && (s.phase === 'lobby' || !s.rules.build) ? btn('Remove', () => (org ? org.removeTrack(org.me, t.id) : app.act({ k: 'act', a: 'untrack', v: t.id })), 'small ghost') : null,
            org ? btn(voting ? 'Pick' : queued?.id === t.id ? 'Queued' : 'Play next', () => org.hostPick({ id: t.id, name: t.name, author: t.author, cat: t.cat }), 'small ' + (voting ? 'primary' : 'ghost')) : null,
          );
        }),
        list.length ? null : h('div', { class: 'empty' }, pool.length ? 'No tracks match.' : s.rules.build ? 'The tracks show up here once they are built.' : s.rules.customOnly ? 'No tracks yet. Add one above.' : 'The track list is still loading.'),
        pool.length > list.length ? h('div', { class: 'empty' }, `Showing ${list.length} of ${pool.length}. Search for the rest.`) : null,
      ),
    ];
  }

  #trackCode = '';
  #adding = false;
  #uploadSection(s: CupState, bare = false) {
    const app = this.app;
    const r = s.rules;
    const lib = site.__nswsTracks;
    const intro = (text: string) => h('p', { class: 'dim', style: 'margin:0 0 10px;font-size:15px;line-height:1.35' }, text);
    const wrap = (...children: (HTMLElement | null)[]) => (bare ? h('div', { class: 'addbox' }, children) : h('div', { class: 'sect' }, h('h3', null, 'Add tracks'), children));
    if (!app.org && r.customPick === 'organizer') return wrap(intro('Only the organizer adds tracks in this cup.'));
    const mine = (s.custom ?? []).filter((t) => t.by === app.me).length;
    const full = !app.org && mine >= r.customLimit;
    const code = h('input', { class: 'text', placeholder: full ? 'You have added all your tracks' : 'Paste a track code, pack code or NSWS link', value: this.#trackCode, spellcheck: 'false', autocomplete: 'off', disabled: full || this.#adding }) as HTMLInputElement;
    const send = async () => {
      const text = code.value.trim();
      if (!text) return app.notify('Paste a track code first.', 'bad');
      // One plain code needs nothing from the library, so it works even without it.
      const single = /^PolyTrack\S*$/.test(text);
      if (single || !lib?.importText) {
        if (await this.#addTracks([{ code: text }])) this.#clearCode(code);
        return;
      }
      this.#adding = true;
      this.render(true);
      try {
        const got = await lib.importText(text);
        if (got.club && !got.tracks?.length) return app.notify('That is a club code. Join the club in Custom Tracks, then add its tracks from My Tracks.', 'bad');
        if (!got.tracks?.length) return app.notify((got as { failed?: { error?: string }[] }).failed?.[0]?.error || "That isn't a track code, pack code or NSWS link.", 'bad');
        if (await this.#addTracks(got.tracks)) this.#trackCode = '';
      } catch (e) {
        app.notify((e as Error)?.message || "That link couldn't be read.", 'bad');
      } finally {
        this.#adding = false;
        this.render(true);
      }
    };
    code.addEventListener('input', () => (this.#trackCode = code.value));
    code.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void send();
    });
    const fromLibrary = async () => {
      const picked = await lib?.pick?.({ multi: true });
      if (picked?.length) void this.#addTracks(picked);
    };
    const count = app.org ? 'As the organizer you have no limit.' : `${mine} of ${r.customLimit} added.`;
    return wrap(
      intro(`Pick from My Tracks, or paste a track's import code, a pack code or an NSWS track link. They join this cup for everyone, with their mode. ${count}`),
      h('div', { class: 'frow' }, lib?.pick && !full ? btn([icon('plus'), 'Add from My Tracks'], () => void fromLibrary(), 'small primary') : null),
      h('div', { class: 'frow' }, code, btn(this.#adding ? 'Adding...' : 'Add', () => !full && !this.#adding && void send(), 'small' + (full || this.#adding ? ' ghost' : ''))),
    );
  }

  #clearCode(code: HTMLInputElement) {
    this.#trackCode = '';
    code.value = '';
    code.blur();
  }

  // Sends tracks to the organizer one by one; true when at least one went.
  async #addTracks(items: { code: string; mode?: string }[]) {
    const app = this.app;
    if (!app.state) return false;
    if (items.some((t) => isBE(String(t.code ?? ''))) && !beReady()) {
      app.notify('Loading Better Editor blocks...', 'info');
      const error = await ensureBE();
      if (error) {
        app.notify(error, 'bad');
        return false;
      }
    }
    const s = app.state;
    if (!s) return false;
    const limit = s.rules.customLimit;
    let room = app.org ? Infinity : Math.max(0, limit - (s.custom ?? []).filter((t) => t.by === app.me).length);
    let sent = 0,
      over = 0,
      burst = 0,
      error: string | null = null;
    for (const t of items) {
      const c = String(t.code ?? '').trim();
      if (room <= 0) {
        over++;
        continue;
      }
      // The organizer reads at most 40 messages a second from each page and drops the rest.
      const parts = Math.ceil(c.length / UPLOAD_CHUNK);
      if (!app.org && burst && burst + parts > 24) {
        await new Promise((r) => setTimeout(r, 1500));
        burst = 0;
      }
      burst += parts;
      const e = app.uploadTrack(c, t.mode as TrackMode);
      if (e) {
        error = e;
        if (e.startsWith('Not connected') || e.startsWith('Only the organizer')) break;
        continue;
      }
      sent++;
      room--;
    }
    if (over) app.notify(`You can add up to ${limit} ${limit === 1 ? 'track' : 'tracks'}; ${over} left out.`, 'bad');
    if (error) app.notify(error, 'bad');
    if (sent && !app.org) app.notify(sent === 1 ? 'Uploading the track...' : `Uploading ${sent} tracks...`, 'info');
    return sent > 0;
  }

  // ---- Rules ----

  #ruleKit(s: CupState) {
    const app = this.app;
    const host = app.isHost;
    const lobby = s.phase === 'lobby';
    const r = s.rules;
    const set = (change: Partial<Rules>) => {
      if (!app.org) return;
      if (lobby) app.org.configure(s.format, { ...r, ...change });
      else app.org.adjust(change as never);
    };
    const MID_CUP: (keyof Rules)[] = ['breakSeconds', 'freecam', 'lateJoin', 'finishWindow', 'next', 'readyEnds', 'countdownSeconds', 'voteSeconds', 'skipVotes', 'target', 'bots', 'botSkill', 'customTracks', 'customOnly', 'customPick', 'customLimit', 'mode', 'finalist', 'rounds', 'knockout'];
    const live = (field: keyof Rules) => host && (lobby || MID_CUP.includes(field));
    const row = (label: string, hint: string, ...control: (HTMLElement | null)[]) => h('div', { class: 'rule' }, h('label', null, label, hint ? h('small', null, hint) : null), ...control);
    const toggle = (field: keyof Rules, label: string, hint: string) => {
      const sw = h('button', { class: 'switch' + (r[field] ? ' on' : ''), disabled: !live(field), 'aria-pressed': String(!!r[field]), onclick: click(() => set({ [field]: !r[field] } as Partial<Rules>)) });
      const el = row(label, hint, sw);
      if (live(field)) {
        el.classList.add('toggleable');
        el.querySelector('label')!.addEventListener('click', () => sw.click());
      }
      return el;
    };
    const seg = <T extends string>(field: keyof Rules, label: string, hint: string, options: [T, string][]) => {
      const el = row(label, hint, h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { class: r[field] === v ? 'on' : '', disabled: !live(field), onclick: click(() => set({ [field]: v } as Partial<Rules>)) }, l))));
      if (options.length >= 4) el.classList.add('wide');
      return el;
    };
    const slider = (field: keyof Rules, label: string, hint: string, min: number, max: number, step: number, fmt: (n: number) => string) => {
      const value = r[field] as number;
      const out = h('span', { class: 'val' }, fmt(value));
      const input = range({ min, max, step, value, disabled: !live(field) });
      input.addEventListener('input', () => (out.textContent = fmt(Number(input.value))));
      input.addEventListener('change', () => set({ [field]: Number(input.value) } as Partial<Rules>));
      return row(label, hint, input, out);
    };
    // A typed number, for values with a wide range (the points cap).
    const number = (field: keyof Rules, label: string, hint: string, min: number, max: number) => {
      const input = h('input', { class: 'text num', type: 'number', min, max, step: 1, value: String(r[field]), disabled: !live(field) }) as HTMLInputElement;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
      });
      input.addEventListener('change', () => {
        const n = Math.round(Number(input.value));
        if (!Number.isFinite(n)) return;
        const v = Math.min(max, Math.max(min, n));
        // Show the clamp straight away: the panel skips its rebuild while this box still has focus.
        input.value = String(v);
        set({ [field]: v } as Partial<Rules>);
      });
      return row(label, hint, input);
    };
    return { app, host, lobby, r, set, live, row, toggle, seg, slider, number };
  }

  #rulesTab(s: CupState) {
    const { app, host, lobby, r, set, live, row, toggle, seg, slider, number } = this.#ruleKit(s);
    const sec = (n: number) => fmtDuration(n);
    const sect = (title: string, ...rows: (HTMLElement | null)[]) => h('div', { class: 'sect' }, h('h3', null, title), h('div', { class: 'rules' }, rows));
    // A Build Off's rounds are counted from its tracks once they are built; after that they can be changed.
    const builtRounds = !lobby && s.phase !== 'build';
    const minRounds = lobby ? 1 : s.rounds + 1;

    const winning = sect(
      'Winning',
      seg('mode', 'Decided by', '', [
        ['points', 'Points'],
        ['rounds', 'Rounds'],
        ['knockout', 'Knockout'],
      ]),
      r.mode === 'points'
        ? number(
            'target',
            r.finalist ? 'Finalist at' : 'Points to win',
            lobby ? 'The points cap' : `The points cap, which has to stay above the leader's ${leaderPoints(s)}`,
            lobby ? 1 : leaderPoints(s) + 1,
            100000,
          )
        : null,
      r.mode === 'points' ? toggle('finalist', 'Finalist rule', 'Reaching the cap makes you a finalist; then win a round to take the cup') : null,
      r.mode === 'rounds' && (!r.build || builtRounds)
        ? slider('rounds', 'Rounds', lobby ? 'Length of the season' : `Length of the season; ${s.rounds} played so far`, minRounds, Math.max(50, r.rounds, minRounds), 1, (n) => `${n}`)
        : null,
      r.mode === 'rounds' && r.build && !builtRounds ? row('Rounds', 'Every built track, rounds per track times each', h('span', { class: 'val' }, 'Auto')) : null,
      r.mode === 'knockout' ? slider('knockout', 'Knocked out', 'Racers out per round', 1, 8, 1, (n) => `${n}`) : null,
    );
    const tracks = sect(
      'Tracks',
      slider('perTrack', 'Rounds per track', 'Before the track changes', 1, 30, 1, (n) => `${n}`),
      toggle('draft', 'Pick and ban', 'Before the first round everyone bans, then picks tracks'),
      r.draft ? slider('bans', 'Bans per racer', '', 0, 3, 1, (n) => `${n}`) : null,
      r.draft ? slider('picks', 'Picks per racer', '', 1, 3, 1, (n) => `${n}`) : null,
      seg('next', r.draft ? 'After the picks' : 'Next track', r.draft ? 'Picks repeat; a queued track goes first' : 'Who chooses', [
        ['random', 'Random'],
        ['vote', 'Vote'],
        ['winner', 'Winner'],
        ['last', 'Last'],
        ['host', 'Me'],
      ]),
      r.next !== 'random' || r.draft ? slider('voteSeconds', 'Choosing time', r.next === 'host' ? 'For votes and picks (you get 3x)' : 'For votes and picks', 5, 60, 1, (n) => `${n} s`) : null,
      r.draft ? slider('draftSeconds', 'Pick and ban time', 'For each step', 10, 120, 5, (n) => `${n} s`) : null,
      toggle('skipVotes', 'Skip votes', 'Racers can vote a track away'),
    );
    const rounds = sect(
      'Rounds',
      seg('style', 'Round style', 'One run, or best of many', [
        ['race', 'One run'],
        ['timeattack', 'Time attack'],
      ]),
      r.style === 'timeattack' ? slider('taSeconds', 'Time attack length', 'Per round', 30, 1800, 30, sec) : null,
      r.style === 'race'
        ? seg('limit', 'Time limit', 'Auto: 3x the best known time (world record or this cup)', [
            ['auto', 'Auto'],
            ['fixed', 'Fixed'],
            ['off', 'Off'],
          ])
        : null,
      r.style === 'race' && r.limit !== 'off' ? slider('limitSeconds', r.limit === 'auto' ? 'Limit with no time known' : 'Time limit', 'Per round', 30, 1800, 30, sec) : null,
      r.style === 'race' ? slider('finishWindow', 'Finish window', 'After the first finish (0 = off)', 0, 300, 5, (n) => (n ? sec(n) : 'off')) : null,
      slider('countdownSeconds', 'Countdown', 'Before GO', 3, 10, 1, (n) => `${n} s`),
      slider('breakSeconds', 'Break', 'Results between rounds', 3, 60, 1, (n) => `${n} s`),
    );
    const warm = r.style === 'timeattack' ? null : sect(
      'Warm-up',
      seg('warmupMode', 'Warm-up', 'Free practice before a track\'s first round', [
        ['off', 'Off'],
        ['first', 'First visit'],
        ['every', 'Every track'],
      ]),
      r.warmupMode !== 'off'
        ? seg('warmupTiming', 'Length', 'Fixed, or from the world record', [
            ['fixed', 'Fixed'],
            ['wr', 'World record'],
          ])
        : null,
      r.warmupMode !== 'off' ? slider('warmup', r.warmupTiming === 'wr' ? 'Without a record' : 'Length', '', 10, 600, 10, sec) : null,
      r.warmupMode !== 'off' && r.warmupTiming === 'wr' ? slider('warmupMult', 'Record multiplier', 'Warm-up = record x this', 0.5, 5, 0.1, (n) => `${n.toFixed(1)}x`) : null,
      r.warmupMode !== 'off' && r.warmupTiming === 'wr' ? slider('warmupMin', 'Shortest warm-up', '', 10, 300, 5, sec) : null,
      r.warmupMode !== 'off' ? toggle('readyEnds', 'Ready ends it', 'Starts once every racer is ready') : null,
    );
    // A knockout's grid is locked once it starts (bots can still be taken off in Players).
    const botsLocked = !lobby && r.mode === 'knockout';
    const botCount = row(
      'Bots',
      botsLocked ? 'Computer racers. Fixed once a knockout starts' : 'Computer racers',
      h(
        'div',
        { class: 'seg' },
        Array.from({ length: MAX_BOTS + 1 }, (_, n) => h('button', { class: r.bots === n ? 'on' : '', disabled: !live('bots') || botsLocked, onclick: click(() => set({ bots: n })) }, n ? String(n) : 'Off')),
      ),
    );
    botCount.classList.add('wide');
    this.#askOwner();
    const org = app.org;
    // The owner's alone, and not a rule: no one else in the cup sees it.
    let wrBot: HTMLElement | null = null;
    if (host && org && this.#owner && r.bots && !r.collisions) {
      const sw = h('button', { class: 'switch' + (org.wrBot ? ' on' : ''), 'aria-pressed': String(org.wrBot), onclick: click(() => (org.setWrBot(!org.wrBot), (this.#key = ''), this.render())) });
      wrBot = row('World record bot', 'Only you see this. The first expert starts from the record and searches it for a faster run', sw);
      wrBot.classList.add('toggleable');
      wrBot.querySelector('label')!.addEventListener('click', () => sw.click());
    }
    const skillHint =
      r.botSkill === 'match' ? "They start at medium and follow the humans' pace round by round" : r.botSkill === 'mixed' ? 'A quarter each of easy, medium, hard and expert' : 'How fast and how boldly they drive';
    const bots = sect(
      'Bots',
      botCount,
      r.bots
        ? seg('botSkill', 'Bot skill', skillHint, [
            ['easy', 'Easy'],
            ['medium', 'Medium'],
            ['hard', 'Hard'],
            ['expert', 'Expert'],
            ['mixed', 'Mixed'],
            ['match', 'Match the field'],
          ])
        : null,
      wrBot,
    );
    const players = sect(
      'Players',
      toggle('lateJoin', 'Late joiners race', 'Newcomers can take a grid slot'),
      toggle('freecam', 'Spectator free camera', 'Let spectators fly around'),
      toggle('collisions', 'Bumper cars', 'Cars collide (times never upload)'),
      toggle('uploads', 'Upload PBs', 'Cup PBs go on the leaderboards'),
    );
    const title = lobby ? null : h('h3', { class: 'rules-title' }, host ? 'Rules (the greyed-out ones are fixed once the cup starts)' : 'Rules');
    if (r.casual)
      return [
        title,
        bots,
        sect(
          'Tracks',
          r.build
            ? null
            : seg('next', 'Next track', 'Who chooses when the racers want a new one', [
                ['random', 'Random'],
                ['vote', 'Vote'],
                ['host', 'Me'],
              ]),
          !r.build && r.next !== 'random' ? slider('voteSeconds', 'Choosing time', r.next === 'host' ? 'You get 3x' : 'For the vote', 5, 60, 1, (n) => `${n} s`) : null,
          slider('countdownSeconds', 'Countdown', 'Before each new track', 3, 10, 1, (n) => `${n} s`),
          slider('breakSeconds', 'Break', 'Times shown between tracks', 3, 60, 1, (n) => `${n} s`),
        ),
        sect('Players', toggle('freecam', 'Spectator free camera', 'Let spectators fly around'), toggle('collisions', 'Bumper cars', 'Cars collide (times never upload)'), toggle('uploads', 'Upload PBs', 'Cup PBs go on the leaderboards')),
        host && lobby ? this.#presetSection(s) : null,
      ];
    return [
      title,
      bots,
      winning,
      r.mode === 'knockout' ? null : this.#pointsSection(s, lobby && host, set),
      tracks,
      rounds,
      warm,
      players,
      host && lobby ? this.#presetSection(s) : null,
    ];
  }

  // Points for every place, each editable, plus a formula that fills them all.
  #curve: { kind: PointsCurve; top: number; last: number } = { kind: 'log', top: 200, last: 10 };
  #pointsSection(s: CupState, editable: boolean, set: (change: Partial<Rules>) => void) {
    const r = s.rules;
    const cells = r.points.map((value, i) => {
      const input = h('input', { class: 'text num', type: 'number', min: 0, max: 10000, step: 1, value: String(value), disabled: !editable, 'aria-label': `Points for ${ordinal(i + 1)}` }) as HTMLInputElement;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
      });
      input.addEventListener('change', () => {
        const n = Math.max(0, Math.min(10000, Math.round(Number(input.value) || 0)));
        const points = [...r.points];
        points[i] = n;
        // A place never earns more than the one above it: raise the places above, lower the ones below.
        for (let j = i - 1; j >= 0; j--) points[j] = Math.max(points[j], n);
        for (let j = i + 1; j < points.length; j++) points[j] = Math.min(points[j], n);
        if (points[0] <= 0) points[0] = 1;
        set({ points });
      });
      return h('label', { class: 'pcell' }, h('span', null, ordinal(i + 1)), input);
    });
    const c = this.#curve;
    const kind = h('div', { class: 'seg' }, (
      [
        ['log', 'Curve'],
        ['f1', 'F1'],
        ['linear', 'Even'],
        ['flat', 'Same for all'],
      ] as [PointsCurve, string][]
    ).map(([k, l]) => h('button', { class: c.kind === k ? 'on' : '', disabled: !editable, onclick: click(() => ((c.kind = k), (this.#key = ''), this.render(true))) }, l)));
    const numIn = (v: number, onSet: (n: number) => void, label: string) => {
      const input = h('input', { class: 'text num', type: 'number', min: 0, max: 10000, value: String(v), disabled: !editable, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('change', () => onSet(Math.max(0, Math.round(Number(input.value) || 0))));
      return input;
    };
    const formula = h(
      'div',
      { class: 'formula' },
      h('span', null, 'Formula'),
      kind,
      h('span', { class: 'dim' }, '1st'),
      numIn(c.top, (n) => (c.top = Math.max(1, n)), 'Points for 1st'),
      c.kind === 'flat' ? null : h('span', { class: 'dim' }, '25th'),
      c.kind === 'flat' ? null : numIn(c.last, (n) => (c.last = n), 'Points for 25th'),
      btn('Fill the table', () => set({ points: pointsCurve(c.kind, c.top, c.last) }), 'small'),
    );
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, 'Points per place'),
      editable ? formula : null,
      h('div', { class: 'pgrid' }, cells),
      editable ? h('p', { class: 'dim', style: 'font-size:14px;margin:8px 0 0' }, 'Type any value. A place never earns more than the place above it.') : null,
    );
  }

  #presetSection(s: CupState) {
    const app = this.app;
    const name = h('input', { class: 'text', placeholder: 'Preset name', maxlength: 40, style: 'flex:1' }) as HTMLInputElement;
    name.addEventListener('keydown', (e) => e.stopPropagation());
    const paste = h('input', { class: 'text', placeholder: 'Paste a preset here to import it', style: 'flex:1' }) as HTMLInputElement;
    paste.addEventListener('keydown', (e) => e.stopPropagation());
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, 'Presets'),
      h(
        'div',
        { class: 'presetrow' },
        name,
        btn('Save', () => {
          if (!name.value.trim()) throw new Error('Give the preset a name.');
          savePreset(name.value.trim(), s.rules);
          app.notify(`Saved "${name.value.trim()}"`, 'good');
          this.#key = '';
        }, 'small'),
        btn('Copy as text', () => this.#copy(presetText(name.value.trim() || s.format, s.rules), 'Preset copied. Share it with another organizer.'), 'small'),
      ),
      h(
        'div',
        { class: 'presetrow' },
        paste,
        btn('Import', () => {
          const p = parsePresetText(paste.value.trim());
          savePreset(p.name, p.rules);
          this.#apply('custom:' + p.name, p.rules);
          app.notify(`Imported "${p.name}"`, 'good');
        }, 'small'),
      ),
    );
  }

  // ---- Controls ----

  #controls(s: CupState) {
    const app = this.app;
    const items: (HTMLElement | null)[] = [];
    if (app.isHost) {
      const org = app.org!;
      const live = ['countdown', 'racing', 'warmup'].includes(s.phase);
      if (s.phase === 'lobby') {
        const why = !s.players.some((p) => p.role === 'racer' && !p.bot && !p.away)
          ? 'Nobody is on the grid yet'
          : s.rules.customOnly && !s.rules.build && !(s.custom ?? []).length
            ? 'Add at least one track first'
            : '';
        const building = !!s.rules.build && !(s.built && (s.custom ?? []).length);
        items.push(btn([icon(building ? 'hammer' : 'play'), building ? `Start building (${s.rules.build} min)` : 'Start the cup'], () => (org.start(), this.setOpen(false)), 'primary big' + (why ? ' ghost' : '')));
        if (why) items.push(h('span', { class: 'dim', style: 'font-size:15px' }, why));
      }
      if (s.phase === 'build' && s.build && !s.build.closing) {
        items.push(btn([icon('clock'), '+2 min'], () => org.buildMore(120), 'small ghost'));
        items.push(confirmBtn('End building now', () => org.buildNow(), 'small'));
      }
      if (s.phase === 'podium') {
        items.push(btn('Race again', () => (org.raceAgain(false), this.setOpen(false))));
        items.push(btn('Race again on new tracks', () => (org.raceAgain(true), this.setOpen(false))));
        items.push(btn([icon('exit'), 'Close the cup'], () => app.onLeave('You closed the cup.'), 'small danger'));
      }
      if (s.rules.casual && s.phase !== 'lobby' && s.phase !== 'podium' && s.phase !== 'build') {
        items.push(btn([icon('skip'), 'New track'], () => org.skipTrack(), 'small ghost'));
        items.push(btn([icon(s.hold ? 'play' : 'pause'), s.hold ? 'Resume' : 'Pause breaks'], () => org.setHold(!s.hold), 'small ' + (s.hold ? 'on' : 'ghost')));
      } else if (s.phase === 'racing') {
        items.push(btn([icon('stop'), 'End round'], () => org.endRoundNow(), 'small ghost'));
        items.push(btn([icon('clock'), '+30 s'], () => org.extend(30), 'small ghost'));
      }
      if (live && !s.rules.casual) {
        items.push(btn([icon('restart'), 'Restart round'], () => org.restartRound(), 'small ghost'));
        items.push(confirmBtn('Void round', () => org.voidRound(), 'small'));
      }
      if (s.phase !== 'lobby' && s.phase !== 'podium' && s.phase !== 'build' && !s.rules.casual) {
        items.push(btn([icon('skip'), 'Skip track'], () => org.skipTrack(), 'small ghost'));
        items.push(btn([icon(s.hold ? 'play' : 'pause'), s.hold ? 'Resume' : 'Pause breaks'], () => org.setHold(!s.hold), 'small ' + (s.hold ? 'on' : 'ghost')));
      }
      items.push(h('span', { style: 'flex:1' }));
      const shout = this.#shoutInput;
      items.push(h('div', { class: 'announce' }, shout, btn([icon('megaphone')], () => shout.value.trim() && (org.shout(shout.value), (shout.value = '')), 'small ghost icon', 'Show it on every screen')));
      if (s.phase !== 'lobby' && s.phase !== 'podium') items.push(confirmBtn(s.rules.casual ? 'End session' : 'End cup', () => org.endCup(), 'small danger'));
    } else {
      items.push(h('span', { style: 'flex:1' }));
      items.push(btn([icon('exit'), 'Leave cup'], () => app.onLeave(''), 'small danger'));
    }
    return h('div', { class: 'ctl' }, items);
  }

  // ---- Chat ----

  // Two tabs: the cup's own chat and everyone online. The box and its buttons are built once, so
  // typing (and a phone's keyboard) survives new messages.
  #renderChat() {
    const app = this.app,
      chat = app.chat,
      cup = chat.cup;
    const ui = (this.#chatUi ??= this.#buildChat());
    if (ui.box.parentElement !== this.#side) fill(this.#side, ui.box);
    const onCup = chat.target === 'cup';
    // What's on screen counts as read.
    if (!isPhone() || this.tab === 'chat') {
      if (onCup) cup.unread = 0;
      else chat.unreadAll = 0;
    }
    const off = !onCup && !chat.mainOn;
    const muted = onCup && cup.muted;
    ui.input.disabled = muted || off;
    ui.input.placeholder = muted ? 'The organizer muted you' : off ? 'The main chat is off' : onCup ? 'Message the cup' : 'Message everyone online';
    const lines = chat.lines();
    const key = JSON.stringify([chat.target, chat.mainOn, chat.isHost, cup.status, lines.length, lines.at(-1)?.key, [...cup.mutes], cup.unread, chat.unreadAll]);
    if (key === this.#chatKey) return;
    this.#chatKey = key;
    const tab = (el: HTMLElement, label: string, on: boolean, unread: number) => {
      toggle(el, 'on', on);
      fill(el, label, unread && !on ? h('span', { class: 'count' }, String(unread)) : null);
    };
    tab(ui.cupTab, 'Cup chat', onCup, cup.unread);
    tab(ui.allTab, 'Everyone', !onCup, chat.unreadAll);
    const msgs = ui.msgs;
    const atBottom = this.#chatToEnd || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    this.#chatToEnd = false;
    fill(
      msgs,
      off
        ? h('div', { class: 'empty' }, h('p', null, 'The main chat is off. Turn it on to talk to everyone online.'), btn('Turn it on', () => chat.turnMainOn(), 'small'))
        : lines.length
          ? lines.map(({ m }) =>
              h(
                'div',
                { class: 'msg' },
                onCup && chat.isHost && m.uid !== cup.uid
                  ? h('button', { class: 'mute', onclick: click(() => cup.mute(m.uid, !cup.mutes.has(m.uid))) }, cup.mutes.has(m.uid) ? 'unmute' : 'mute')
                  : null,
                h('b', { style: `color:${nameColor(m.uid)}` }, m.nick, onCup && cup.mutes.has(m.uid) ? ' (muted)' : ''),
                m.text,
              ),
            )
          : h('div', { class: 'empty' }, !onCup || cup.status === 'on' ? 'No messages yet. Say hi!' : 'Connecting to chat…'),
    );
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
  }

  #chatUi: { box: HTMLElement; msgs: HTMLElement; input: HTMLInputElement; cupTab: HTMLButtonElement; allTab: HTMLButtonElement } | null = null;
  #buildChat() {
    const app = this.app,
      chat = app.chat;
    const msgs = h('div', { class: 'msgs' });
    const input = h('input', { class: 'text', maxlength: 200, enterkeyhint: 'send', autocomplete: 'off' }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());
    // Buttons beside the box don't take its focus.
    const keep = (e: Event) => e.preventDefault();
    let sending = false;
    const form = h(
      'form',
      {
        onsubmit: (e: Event) => {
          e.preventDefault();
          const text = input.value;
          if (!text.trim() || sending) return;
          sending = true;
          chat
            .post(text)
            .then(() => {
              if (input.value === text) input.value = '';
            })
            .catch((err) => app.notify(err instanceof Error ? err.message : String(err), 'bad'))
            .finally(() => (sending = false));
        },
      },
      input,
      h('button', { class: 'btn small', type: 'submit', onmousedown: keep }, 'Send'),
    );
    const cupTab = h('button', { class: 'tab', type: 'button', onmousedown: keep, onclick: click(() => chat.setTarget('cup')) }) as HTMLButtonElement;
    const allTab = h('button', { class: 'tab', type: 'button', onmousedown: keep, onclick: click(() => chat.setTarget('all')) }) as HTMLButtonElement;
    const box = h('div', { class: 'chat' }, h('div', { class: 'ctabs' }, cupTab, allTab), msgs, form);
    return { box, msgs, input, cupTab, allTab };
  }

  #link() {
    const code = this.app.code ?? '';
    const url = new URL(site.__nswsShareBase || location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('cup', code);
    return url.toString();
  }

  #copy(text: string, done: string) {
    navigator.clipboard?.writeText(text).then(
      () => this.app.notify(done, 'good'),
      () => this.app.notify(text, 'info'),
    );
  }
}

// The cup's tracks read from this page's own library, for pages with no Organizer. The game filters
// the library by window.__nswsCupPool, which hub.ts sets both when hosting and when joining, so this
// is the same list the organizer's pool() returns.
function cupTracks(app: App): TrackRef[] {
  const custom = (site.__nswsCupPool as { custom?: boolean } | undefined)?.custom === true;
  const list: TrackRef[] = [];
  try {
    app.native.trackLibrary.forEachTrack((id, meta, category) => {
      if (category === 'custom' && !custom) return;
      list.push({ id, name: meta?.name ?? 'Track', author: meta?.author, cat: (['official', 'community', 'custom'].includes(category) ? category : 'custom') as Category });
    });
  } catch {}
  return list;
}
