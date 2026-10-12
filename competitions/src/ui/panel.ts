// The cup panel (Tab): overview and setup, standings, rounds, players, tracks (organizer) and rules,
// with the cup chat alongside.
import type { App } from '../app.ts';
import { canRace, racers } from '../engine.ts';
import { cleanRules, deletePreset, fmtDuration, FORMATS, formatById, MAX_RACERS, NEXT_LABEL, PRODUCT, rulesSummary, savedPresets, savePreset, type Rules } from '../rules.ts';
import { player, standings, type CupState } from '../state.ts';
import { btn, click, flag, fmtTime, h, icon, ordinal, fill } from './dom.ts';
import { nameColor } from './hud.ts';

type Tab = 'cup' | 'standings' | 'rounds' | 'players' | 'tracks' | 'rules';

const PHASE_TEXT: Record<CupState['phase'], string> = {
  lobby: 'Lobby',
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
  #msgs: HTMLElement | null = null;
  #side = h('aside', { class: 'side' });
  // Built once: only the header and the main column are rebuilt, so the chat keeps its focus.
  #head = h('header');
  #main = h('div', { class: 'main' });
  #mounted = false;
  #draft: { format: string; rules: Rules } | null = null;
  #search = '';
  onKeys: () => void = () => {};
  #shoutInput = (() => {
    const input = h('input', { class: 'text', placeholder: 'Message everyone…', maxlength: 140, style: 'width:200px;font-size:15px' }) as HTMLInputElement;
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

  constructor(private app: App) {}

  get open() {
    return !this.el.hidden;
  }

  setOpen(open: boolean) {
    if (open === this.open) return;
    this.el.hidden = !open;
    this.app.panelOpen = open;
    this.#key = '';
    this.#chatKey = '';
    if (!open) this.app.chatTyping = false;
    this.app.changed();
  }

  render(force = false) {
    const app = this.app,
      s = app.state;
    if (!this.open || !s) {
      if (!s) this.el.hidden = true;
      return;
    }
    if (this.tab === 'tracks' && !app.isHost) this.tab = 'cup';
    // Never rebuild under someone typing (or dragging a slider) in the main column.
    const active = (this.el.getRootNode() as ShadowRoot).activeElement;
    if (!force && active && this.#main.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) {
      this.#renderChat();
      return;
    }
    const key = JSON.stringify([
      this.tab,
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
        h('h1', { class: 'ell' }, s.official ? [icon('star', 'amber'), ' '] : null, s.name),
        h(
          'div',
          { class: 'meta' },
          h('span', { class: 'chip ' + (['racing', 'countdown'].includes(s.phase) ? 'live' : 'amber') }, PHASE_TEXT[s.phase]),
          h('span', { class: 'ell' }, `${formatById(s.format)?.name ?? s.format} · ${rulesSummary(s.rules)}`),
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
      btn(icon('keyboard'), () => this.onKeys(), 'small ghost icon', 'Keys'),
      btn(icon('x'), () => this.setOpen(false), 'small ghost icon', 'Close (Tab or Esc)'),
    ];
    const tabs: [Tab, string, string, string | number | null][] = [
      ['cup', 'Cup', 'cuppa', null],
      ['standings', 'Standings', 'trophy', null],
      ['rounds', 'Rounds', 'flag', app.history.filter((x) => !x.void).length || null],
      ['players', 'Players', 'users', s.players.filter((p) => !p.away).length],
    ];
    if (app.isHost) tabs.push(['tracks', 'Tracks', 'search', null]);
    tabs.push(['rules', 'Rules', 'gear', null]);
    const tabBar = h(
      'div',
      { class: 'tabs' },
      tabs.map(([id, label, ic, count]) =>
        h('button', { class: 'tab' + (this.tab === id ? ' on' : ''), onclick: click(() => ((this.tab = id), (this.#key = ''), this.render())) }, icon(ic), label, count != null ? h('span', { class: 'count' }, String(count)) : null),
      ),
    );
    const content = h('div', { class: 'content' }, this.#content(s));
    if (!this.#mounted) {
      this.#mounted = true;
      fill(this.el, h('div', { class: 'scrim', onclick: () => this.setOpen(false) }), h('div', { class: 'panel' }, this.#head, this.#main, this.#side));
    }
    fill(this.#head, ...header);
    fill(this.#main, tabBar, content, this.#controls(s));
    content.scrollTop = scroll;
  }

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
      case 'rules':
        return this.#rulesTab(s);
    }
  }

  // ---- Cup tab ----

  #cupTab(s: CupState) {
    const app = this.app;
    const out: (HTMLElement | null)[] = [];
    const me = app.self;
    if (s.phase === 'lobby') {
      const count = racers(s).length;
      out.push(
        h(
          'div',
          { class: 'hero' },
          h('span', { class: 'big amber' }, icon('flag')),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'big' }, app.isHost ? (count < 2 ? 'Invite some racers' : `${count} racers on the grid`) : 'Waiting for the organizer'),
            h('p', null, app.isHost ? `Share the code ${app.code ?? '…'} or the invite link. Everyone can practise on this track until you start.` : 'Practise on this track while you wait. The cup starts when the organizer is ready.'),
          ),
          app.isHost && app.code ? btn([icon('link'), 'Copy invite link'], () => this.#copy(this.#link(), 'Invite link copied'), 'primary') : null,
          app.isHost && !app.code && app.connection
            ? h('span', { class: app.native.inviteError(app.connection) ? 'bad' : 'dim' }, app.native.inviteError(app.connection) ?? 'Getting a code…')
            : null,
        ),
      );
      out.push(this.#roleChooser(s));
      out.push(this.#formatSection(s));
    } else {
      out.push(this.#statusHero(s));
      if (me) out.push(this.#roleChooser(s));
      out.push(this.#leaders(s));
    }
    return out;
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
        { class: 'tile', style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap' },
        h('span', { style: 'font-size:20px;flex:1' }, me.out ? `Knocked out in round ${me.out}` : racing ? 'You are on the grid' : 'You are spectating'),
        me.out
          ? null
          : h(
              'div',
              { class: 'seg' },
              h('button', { class: racing ? 'on' : '', disabled: !allowed, onclick: click(() => set('racer')) }, 'Race'),
              h('button', { class: racing ? '' : 'on', onclick: click(() => set('spectator')) }, 'Watch'),
            ),
        !allowed && !racing ? h('span', { class: 'dim', style: 'font-size:14px;width:100%' }, s.rules.mode === 'knockout' ? 'Knockout cups lock the grid once they start.' : 'The grid is closed or full.') : null,
        racing && s.phase !== 'lobby' ? h('span', { class: 'dim', style: 'font-size:14px;width:100%' }, 'Switching to Watch during a round retires you from it.') : null,
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
      FORMATS.map((f) =>
        h(
          'button',
          {
            class: 'fmt' + (draft.format === f.id ? ' on' : ''),
            disabled: !host,
            onclick: click(() => this.#apply(f.id, { ...cleanRules(f.rules), customTracks: s.rules.customTracks, uploads: s.rules.uploads })),
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
      h('h3', null, 'Format', h('span', { class: 'grow' }), host ? h('span', { class: 'dim', style: 'text-transform:none;letter-spacing:0;font-size:13px' }, 'Fine-tune it in Rules') : null),
      formats,
      presets.length
        ? h(
            'div',
            { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center' },
            h('span', { class: 'dim', style: 'font-size:14px' }, 'Your presets:'),
            presets.map((p) =>
              h('span', { class: 'chip', style: 'pointer-events:auto;cursor:pointer', onclick: click(() => this.#apply('custom:' + p.name, p.rules)) }, p.name, h('span', { style: 'opacity:.6', title: 'Delete', onclick: click(() => (deletePreset(p.name), (this.#key = ''), this.render())) }, ' ×')),
            ),
          )
        : null,
      h('div', { class: 'tile', style: 'margin-top:10px;font-size:15px;line-height:1.4' }, rulesSummary(s.rules)),
    );
  }

  #apply(format: string, rules: Rules) {
    const org = this.app.org;
    if (!org) return;
    org.configure(format.startsWith('custom:') ? format.slice(7) : format, rules);
    this.#draft = null;
  }

  #statusHero(s: CupState) {
    const app = this.app,
      r = s.round;
    const table = standings(s, app.history);
    const myPos = table.findIndex((p) => p.u === app.me) + 1;
    const me = app.self;
    const goal =
      s.rules.mode === 'rounds'
        ? `Round ${s.rounds} of ${s.rules.rounds}`
        : s.rules.mode === 'knockout'
          ? `${racers(s).length} racers left`
          : s.rules.mode === 'finals'
            ? `Finalist at ${s.rules.target} pts`
            : `First to ${s.rules.target} pts`;
    return h(
      'div',
      { class: 'grid2', style: 'margin-bottom:18px;grid-template-columns:repeat(4,1fr)' },
      h('div', { class: 'tile stat' }, h('small', null, 'Now'), h('b', null, PHASE_TEXT[s.phase])),
      h('div', { class: 'tile stat' }, h('small', null, 'Track'), h('b', { class: 'ell' }, r?.track.name ?? '—')),
      h('div', { class: 'tile stat' }, h('small', null, 'Goal'), h('b', { class: 'ell' }, goal)),
      h('div', { class: 'tile stat' }, h('small', null, 'You'), h('b', null, me?.role === 'racer' || me?.pts ? (myPos ? `${ordinal(myPos)} · ${me?.pts ?? 0} pts` : '—') : 'Watching')),
    );
  }

  #leaders(s: CupState) {
    const app = this.app;
    const table = standings(s, app.history).slice(0, 5);
    const best = app.bestRun();
    return h(
      'div',
      { class: 'sect' },
      h('h3', null, 'Top of the table', h('span', { class: 'grow' }), best ? btn([icon('clip'), 'Clip my best run'], () => this.#clip(), 'small ghost') : null),
      table.length ? h('div', { class: 'list' }, table.map((p, i) => this.#standRow(s, p.u, i + 1))) : h('div', { class: 'empty' }, 'No results yet.'),
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
      p.fin ? 'finalist' : '',
      p.away ? 'disconnected' : '',
    ].filter(Boolean);
    return h(
      'div',
      { class: 'prow' + (u === this.app.me ? ' me' : '') + (p.away ? ' away' : '') },
      h('span', { class: 'pos mono ' + (pos === 1 ? 'amber' : '') }, String(pos)),
      h('div', { class: 'grow' }, h('div', { class: 'ell' }, `${flag(p.cc)} ${p.name}`), sub.length ? h('div', { class: 'sub ell' }, sub.join(' · ')) : null),
      h('span', { class: 'pts mono' }, s.rules.mode === 'knockout' ? (p.out ? '—' : 'IN') : String(p.pts)),
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
                  h('td', { class: 'amber' }, s.rules.mode === 'knockout' ? (p.out ? `R${p.out}` : 'IN') : String(p.pts)),
                ),
              ),
            ),
          ),
        )
      : null;
    return [h('div', { class: 'sect' }, h('h3', null, 'Standings'), h('div', { class: 'list' }, table.map((p, i) => this.#standRow(s, p.u, i + 1)))), matrix];
  }

  // ---- Rounds ----

  #roundsTab(s: CupState) {
    const hist = [...this.app.history].reverse();
    if (!hist.length) return h('div', { class: 'empty' }, 'Rounds show up here as they finish.');
    return h(
      'div',
      { class: 'history' },
      hist.map((r) =>
        h(
          'div',
          { class: 'round' },
          h('div', null, h('span', { class: 'amber' }, `Round ${r.n}`), h('span', { class: 'ell', style: 'flex:1' }, r.track), r.void ? h('span', { class: 'chip' }, 'Voided') : null),
          r.void
            ? null
            : h(
                'div',
                { class: 'rows' },
                r.rows.map((row) => [
                  h('span', { class: 'mono ' + (row[2] === 1 ? 'amber' : 'dim') }, row[2] ? String(row[2]) : '–'),
                  h('span', { class: 'ell' }, player(s, row[0])?.name ?? 'Left', row[4] ? h('span', { class: 'bad', style: 'font-size:12px' }, '  OUT') : null),
                  h('span', { class: 'mono' + (row[1] == null ? ' bad' : '') }, row[1] != null ? fmtTime(row[1]) : 'DNF'),
                  h('span', { class: 'mono amber' }, row[3] ? `+${row[3]}` : ''),
                ]),
              ),
        ),
      ),
    );
  }

  // ---- Players ----

  #playersTab(s: CupState) {
    const app = this.app;
    const host = app.isHost;
    const row = (p: CupState['players'][number]) => {
      // Pages that aren't driving send in one-second batches, so ping is only a rough link check.
      const ping = app.ping(p.pid);
      const pingCls = ping == null ? '' : ping < 1600 ? '' : ping < 3000 ? 'mid' : 'bad';
      const pingText = ping == null ? '…' : ping < 1600 ? 'good link' : ping < 3000 ? 'slow link' : 'poor link';
      return h(
        'div',
        { class: 'prow' + (p.u === app.me ? ' me' : '') + (p.away ? ' away' : '') },
        h('span', { class: 'dot' + (p.away ? ' off' : '') }),
        h('div', { class: 'grow' }, h('div', { class: 'ell' }, `${flag(p.cc)} ${p.name}`, p.u === s.host ? h('span', { class: 'chip amber', style: 'margin-left:8px' }, 'Organizer') : null), h('div', { class: 'sub' }, p.away ? 'Disconnected · can rejoin with the same link' : p.out ? `Knocked out in round ${p.out}` : p.role === 'racer' ? 'Racing' : 'Watching')),
        h('span', { class: 'ping ' + pingCls }, p.pid == null || p.u === app.me ? '' : pingText),
        host && p.u !== app.me
          ? h(
              'div',
              { class: 'acts' },
              p.role === 'racer'
                ? btn([icon('eye')], () => app.org!.setRole(p.u, 'spectator'), 'small ghost icon', 'Move to spectators')
                : btn([icon('flag')], () => app.org!.setRole(p.u, 'racer'), 'small ghost icon', 'Put on the grid'),
              btn([icon('x')], () => app.org!.kick(p.u), 'small danger icon', 'Remove from the cup'),
            )
          : null,
      );
    };
    const racersList = s.players.filter((p) => p.role === 'racer');
    const watchers = s.players.filter((p) => p.role !== 'racer');
    const known = new Set(s.players.map((p) => p.pid));
    const joining = app.lobby.filter((l) => !known.has(l.id));
    return [
      h('div', { class: 'sect' }, h('h3', null, `On the grid · ${racersList.length}/${MAX_RACERS}`), racersList.length ? h('div', { class: 'list' }, racersList.map(row)) : h('div', { class: 'empty' }, 'Nobody is racing yet.')),
      h('div', { class: 'sect' }, h('h3', null, `Watching · ${watchers.length}`), watchers.length ? h('div', { class: 'list' }, watchers.map(row)) : h('div', { class: 'empty' }, 'No spectators.')),
      joining.length ? h('div', { class: 'sect' }, h('h3', null, 'Joining'), h('div', { class: 'list' }, joining.map((l) => h('div', { class: 'prow away' }, h('span', { class: 'spinner', style: 'width:16px;height:16px;border-width:3px' }), h('span', { class: 'grow ell' }, l.nickname))))) : null,
    ];
  }

  // ---- Tracks (organizer) ----

  #tracksTab(s: CupState) {
    const org = this.app.org!;
    const pool = org.pool();
    const q = this.#search.trim().toLowerCase();
    const list = pool.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.author ?? '').toLowerCase().includes(q)).slice(0, 120);
    const input = h('input', { class: 'text', placeholder: `Search ${pool.length} tracks…`, value: this.#search, style: 'width:100%' }) as HTMLInputElement;
    input.addEventListener('input', () => {
      this.#search = input.value;
      const pos = input.selectionStart;
      this.render(true);
      const again = this.el.querySelector<HTMLInputElement>('.content input.text');
      again?.focus();
      if (pos != null) again?.setSelectionRange(pos, pos);
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const voting = s.phase === 'vote' && s.vote?.kind === 'host';
    const queued = org.queued;
    return [
      h(
        'div',
        { class: 'sect' },
        h('h3', null, voting ? 'Pick the next track' : 'Play a track next'),
        h('p', { class: 'dim', style: 'margin:0 0 10px;font-size:15px;line-height:1.35' }, voting ? 'Choose any track below, or one of the options on screen.' : 'The track you pick replaces the next track change (vote, picks or random).'),
        queued ? h('div', { class: 'tile', style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px' }, h('span', { class: 'grow' }, 'Up next: ', h('span', { class: 'amber' }, queued.name)), btn('Clear', () => org.queue(null), 'small ghost')) : null,
        input,
      ),
      h(
        'div',
        { class: 'list' },
        list.map((t) =>
          h(
            'div',
            { class: 'prow' },
            h('div', { class: 'grow' }, h('div', { class: 'ell' }, t.name), h('div', { class: 'sub' }, [t.author ? `by ${t.author}` : '', t.cat].filter(Boolean).join(' · '))),
            btn(voting ? 'Pick' : queued?.id === t.id ? 'Queued' : 'Play next', () => org.hostPick({ id: t.id, name: t.name, author: t.author, cat: t.cat }), 'small ' + (voting ? 'primary' : 'ghost')),
          ),
        ),
        list.length ? null : h('div', { class: 'empty' }, 'No tracks match.'),
      ),
    ];
  }

  // ---- Rules ----

  #rulesTab(s: CupState) {
    const app = this.app;
    const host = app.isHost;
    const lobby = s.phase === 'lobby';
    const editable = host && lobby;
    const r = s.rules;
    const set = (change: Partial<Rules>) => {
      if (!app.org) return;
      if (lobby) app.org.configure(s.format, { ...r, ...change });
      else app.org.adjust(change as never);
    };
    const live = (field: keyof Rules) => host && (lobby || ['breakSeconds', 'freecam', 'lateJoin', 'finishWindow', 'next'].includes(field));
    const toggleRow = (field: keyof Rules, label: string, hint: string) =>
      h('div', { class: 'rule' }, h('label', null, label, h('small', null, hint)), h('button', { class: 'switch' + (r[field] ? ' on' : ''), disabled: !live(field), onclick: click(() => set({ [field]: !r[field] } as Partial<Rules>)) }));
    const seg = <T extends string>(field: keyof Rules, label: string, hint: string, options: [T, string][]) =>
      h(
        'div',
        { class: 'rule' },
        h('label', null, label, h('small', null, hint)),
        h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { class: r[field] === v ? 'on' : '', disabled: !live(field), onclick: click(() => set({ [field]: v } as Partial<Rules>)) }, l))),
      );
    const num = (field: keyof Rules, label: string, hint: string, min: number, max: number, step: number, fmt: (n: number) => string) => {
      const value = r[field] as number;
      const out = h('span', { class: 'val mono' }, fmt(value));
      const range = h('input', { type: 'range', min, max, step, value: String(value), disabled: !live(field) }) as HTMLInputElement;
      range.addEventListener('input', () => (out.textContent = fmt(Number(range.value))));
      range.addEventListener('change', () => set({ [field]: Number(range.value) } as Partial<Rules>));
      return h('div', { class: 'rule' }, h('label', null, label, h('small', null, hint)), range, out);
    };
    const sec = (n: number) => (n ? fmtDuration(n) : 'off');
    const rows: HTMLElement[] = [
      seg('mode', 'Winning', 'How the cup is decided', [
        ['points', 'Points'],
        ['rounds', 'Rounds'],
        ['finals', 'Finals'],
        ['knockout', 'Knockout'],
      ]),
    ];
    if (r.mode === 'points' || r.mode === 'finals') rows.push(num('target', r.mode === 'finals' ? 'Finalist at' : 'Points to win', 'Points needed', 200, 5000, 100, (n) => `${n}`));
    if (r.mode === 'rounds') rows.push(num('rounds', 'Rounds', 'Length of the season', 1, 30, 1, (n) => `${n}`));
    if (r.mode === 'knockout') rows.push(num('knockout', 'Knocked out', 'Racers out per round', 1, 8, 1, (n) => `${n}`));
    rows.push(
      num('perTrack', 'Rounds per track', 'Before the track changes', 1, 10, 1, (n) => `${n}`),
      seg('next', 'Next track', 'Who chooses', [
        ['random', 'Random'],
        ['vote', 'Vote'],
        ['winner', 'Winner'],
        ['last', 'Last'],
        ['host', 'Me'],
      ]),
      seg('style', 'Round style', 'One run, or best of many', [
        ['race', 'One run'],
        ['timeattack', 'Time attack'],
      ]),
    );
    if (r.style === 'timeattack') rows.push(num('taSeconds', 'Time attack length', 'Per round', 60, 900, 30, sec));
    else {
      rows.push(
        seg('limit', 'Time limit', 'Auto = 3× the best time seen', [
          ['auto', 'Auto'],
          ['fixed', 'Fixed'],
          ['off', 'Off'],
        ]),
      );
      if (r.limit !== 'off') rows.push(num('limitSeconds', r.limit === 'auto' ? 'Limit before a time is known' : 'Time limit', 'Per round', 60, 900, 30, sec));
      rows.push(num('finishWindow', 'Finish window', 'After the first finish', 0, 120, 5, sec));
      rows.push(num('warmup', 'Warm-up', 'Practice on each new track', 0, 300, 15, sec));
    }
    rows.push(
      num('breakSeconds', 'Break', 'Results shown between rounds', 4, 30, 1, (n) => `${n} s`),
      toggleRow('collisions', 'Bumper cars', 'Cars collide (no times uploaded)'),
      toggleRow('lateJoin', 'Late joiners race', 'Newcomers can take a grid slot'),
      toggleRow('freecam', 'Spectator free camera', 'Let spectators fly around'),
      toggleRow('customTracks', 'My custom tracks', 'Add your own saved tracks to the pool'),
      toggleRow('uploads', 'Upload PBs', 'Cup PBs go to the leaderboards (held for review)'),
    );
    const pts = h('div', { class: 'tile', style: 'font-size:14px;line-height:1.6;color:var(--dim)' }, 'Points by place: ', r.points.slice(0, 10).join(', '), r.points.length > 10 ? ` … ${r.points[r.points.length - 1]}` : '');
    const saveRow = editable
      ? h(
          'div',
          { style: 'display:flex;gap:8px;margin-top:14px' },
          (() => {
            const input = h('input', { class: 'text', placeholder: 'Preset name', maxlength: 40, style: 'flex:1' }) as HTMLInputElement;
            input.addEventListener('keydown', (e) => e.stopPropagation());
            return [
              input,
              btn([icon('plus'), 'Save as preset'], () => {
                if (!input.value.trim()) throw new Error('Give the preset a name.');
                savePreset(input.value.trim(), r);
                app.notify(`Saved preset "${input.value.trim()}"`, 'good');
                this.#key = '';
              }, 'small ghost'),
            ];
          })(),
        )
      : null;
    return [
      h('div', { class: 'sect' }, h('h3', null, editable ? 'Rules' : host ? 'Rules · some can change mid-cup' : 'Rules'), h('div', { class: 'rules' }, rows)),
      h('div', { class: 'sect' }, h('h3', null, 'Points'), pts),
      saveRow,
      !host ? h('p', { class: 'dim', style: 'font-size:14px' }, `Tracks: ${NEXT_LABEL[r.next]}.`) : null,
    ];
  }

  // ---- Controls ----

  #controls(s: CupState) {
    const app = this.app;
    const items: (HTMLElement | null)[] = [];
    if (app.isHost) {
      const org = app.org!;
      const live = ['countdown', 'racing', 'warmup'].includes(s.phase);
      if (s.phase === 'lobby') items.push(btn([icon('play'), 'Start the cup'], () => (org.start(), this.setOpen(false)), 'primary big'));
      if (s.phase === 'podium') {
        items.push(btn([icon('restart'), 'Race again'], () => (org.raceAgain(false), this.setOpen(false)), 'primary'));
        items.push(btn([icon('exit'), 'Close the cup'], () => app.onLeave('You closed the cup.'), 'small danger'));
      }
      if (s.phase === 'racing') {
        items.push(btn([icon('stop'), 'End round'], () => org.endRoundNow(), 'small ghost'));
        items.push(btn([icon('clock'), '+30 s'], () => org.extend(30), 'small ghost'));
      }
      if (live) {
        items.push(btn([icon('restart'), 'Restart round'], () => org.restartRound(), 'small ghost'));
        items.push(btn([icon('x'), 'Void round'], () => org.voidRound(), 'small ghost'));
      }
      if (s.phase !== 'lobby' && s.phase !== 'podium') {
        items.push(btn([icon('skip'), 'Skip track'], () => org.skipTrack(), 'small ghost'));
        items.push(btn([icon(s.hold ? 'play' : 'pause'), s.hold ? 'Resume' : 'Pause breaks'], () => org.setHold(!s.hold), 'small ' + (s.hold ? 'on' : 'ghost')));
      }
      items.push(h('span', { style: 'flex:1' }));
      const shout = this.#shoutInput;
      items.push(shout, btn([icon('megaphone')], () => shout.value.trim() && (org.shout(shout.value), (shout.value = '')), 'small ghost icon', 'Show a message to everyone'));
      if (s.phase !== 'lobby' && s.phase !== 'podium') items.push(btn([icon('trophy'), 'End cup'], () => org.endCup(), 'small danger'));
    } else {
      items.push(h('span', { style: 'flex:1' }));
      items.push(btn([icon('exit'), 'Leave cup'], () => app.onLeave(''), 'small danger'));
    }
    return h('div', { class: 'ctl' }, items);
  }

  // ---- Chat ----

  #renderChat() {
    const app = this.app,
      chat = app.chat;
    const room = chat.room;
    const key = JSON.stringify([chat.tab, room.status, room.messages.length, room.messages.at(-1)?.id, room.mutes.size, chat.cup.unread, chat.global.unread, room.muted]);
    if (key === this.#chatKey && this.#side.isConnected) return;
    this.#chatKey = key;
    const tab = (id: 'cup' | 'global', label: string) => {
      const unread = chat[id].unread;
      return h('button', { class: 'tab' + (chat.tab === id ? ' on' : ''), onclick: click(() => chat.select(id)) }, label, unread && chat.tab !== id ? h('span', { class: 'count' }, String(unread)) : null);
    };
    const atBottom = !this.#msgs || this.#msgs.scrollHeight - this.#msgs.scrollTop - this.#msgs.clientHeight < 40;
    const msgs = h(
      'div',
      { class: 'msgs' },
      room.messages.length
        ? room.messages.map((m) =>
            h(
              'div',
              { class: 'msg' },
              chat.tab === 'cup' && chat.isHost && m.uid !== room.uid
                ? h('button', { class: 'mute', onclick: click(() => room.mute(m.uid, !room.mutes.has(m.uid))) }, room.mutes.has(m.uid) ? 'unmute' : 'mute')
                : null,
              h('b', { style: `color:${nameColor(m.uid)}` }, m.nick, room.mutes.has(m.uid) ? ' (muted)' : ''),
              m.text,
            ),
          )
        : h('div', { class: 'empty' }, room.status === 'on' ? 'No messages yet. Say hi!' : 'Connecting to chat…'),
    );
    room.unread = 0;
    const input = h('input', { class: 'text', maxlength: 200, placeholder: room.muted ? 'The organizer muted you' : chat.tab === 'cup' ? 'Message the cup' : 'Message everyone online', disabled: room.muted }) as HTMLInputElement;
    const prev = this.#side.querySelector<HTMLInputElement>('form input');
    if (prev) input.value = prev.value;
    const hadFocus = prev && this.el.getRootNode() instanceof ShadowRoot && (this.el.getRootNode() as ShadowRoot).activeElement === prev;
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('focus', () => (app.chatTyping = true));
    input.addEventListener('blur', () => (app.chatTyping = false));
    const form = h(
      'form',
      {
        onsubmit: (e: Event) => {
          e.preventDefault();
          const text = input.value;
          if (!text.trim()) return;
          input.disabled = true;
          room
            .post(text)
            .then(() => (input.value = ''))
            .catch((err) => app.notify(err instanceof Error ? err.message : String(err), 'bad'))
            .finally(() => {
              input.disabled = false;
              input.focus();
            });
        },
      },
      input,
      h('button', { class: 'btn small primary', type: 'submit' }, 'Send'),
    );
    this.#msgs = msgs;
    fill(this.#side, h('div', { class: 'chat' }, h('div', { class: 'ctabs' }, tab('cup', 'Cup chat'), tab('global', 'Everyone')), msgs, form));
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
    if (hadFocus) input.focus();
  }

  #link() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('cup', this.app.code ?? '');
    return url.toString();
  }

  #copy(text: string, done: string) {
    navigator.clipboard?.writeText(text).then(
      () => this.app.notify(done, 'good'),
      () => this.app.notify(text, 'info'),
    );
  }
}
