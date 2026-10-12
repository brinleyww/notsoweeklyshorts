// The cup panel (Tab): overview and setup, standings, rounds, players, tracks (organizer) and rules,
// with the cup chat alongside.
import type { App } from '../app.ts';
import { canRace, racers } from '../engine.ts';
import { cleanRules, deletePreset, fmtDuration, FORMATS, formatById, MAX_RACERS, parsePresetText, pointsCurve, presetText, PRODUCT, rulesSummary, savedPresets, savePreset, type PointsCurve, type Rules } from '../rules.ts';
import { player, standings, type CupState, isFinalist } from '../state.ts';
import { btn, click, confirmBtn, range, flag, fmtTime, h, icon, ordinal, fill, toggle } from './dom.ts';
import { nameColor } from './hud.ts';

type Tab = 'cup' | 'standings' | 'rounds' | 'players' | 'tracks';

const PHASE_TEXT: Record<CupState['phase'], string> = {
  lobby: 'Lobby',
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
        h('h1', { class: 'ell' }, s.name),
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
      // Every rule of the chosen format can be changed right here, one by one.
      out.push(...this.#rulesTab(s));
    } else {
      out.push(this.#statusHero(s));
      if (me) out.push(this.#roleChooser(s));
      out.push(this.#skipVote(s));
      out.push(this.#leaders(s));
      out.push(...this.#rulesTab(s));
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
              h('span', { class: 'chip', style: 'pointer-events:auto;cursor:pointer', onclick: click(() => this.#apply('custom:' + p.name, p.rules)) }, p.name, h('span', { style: 'opacity:.6', title: 'Delete', onclick: click(() => (deletePreset(p.name), (this.#key = ''), this.render())) }, ' ×')),
            ),
          )
        : null,
    );
  }

  #apply(format: string, rules: Rules) {
    const org = this.app.org;
    if (!org) return;
    org.configure(format.startsWith('custom:') ? format.slice(7) : format, rules);
    this.#draft = null;
    // The next room starts on the format chosen here.
    try {
      const saved = JSON.parse(localStorage.getItem('nsws-sc-host') || '{}');
      if (!format.startsWith('custom:')) localStorage.setItem('nsws-sc-host', JSON.stringify({ ...saved, format }));
    } catch {}
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
          : s.rules.finalist
            ? `Finalist at ${s.rules.target} pts`
            : `First to ${s.rules.target} pts`;
    return h(
      'div',
      { class: 'grid2', style: 'margin-bottom:18px;grid-template-columns:repeat(4,1fr)' },
      h('div', { class: 'tile stat' }, h('small', null, 'Now'), h('b', null, PHASE_TEXT[s.phase])),
      h('div', { class: 'tile stat' }, h('small', null, 'Track'), h('b', { class: 'ell' }, r?.track.name ?? '—')),
      h('div', { class: 'tile stat' }, h('small', null, 'Goal'), h('b', { class: 'ell' }, goal)),
      h('div', { class: 'tile stat' }, h('small', null, 'You'), h('b', null, me?.role === 'racer' || me?.pts ? (myPos ? [`${ordinal(myPos)} · `, isFinalist(s, me) ? h('span', { class: 'finalist' }, 'Finalist') : `${me?.pts ?? 0} pts`] : '—') : 'Watching')),
    );
  }

  #skipVote(s: CupState) {
    const app = this.app,
      r = s.round;
    if (!s.rules.skipVotes || !r || app.me == null || !r.racers.includes(app.me) || !['warmup', 'countdown', 'racing'].includes(s.phase)) return null;
    const here = r.racers.filter((u) => !player(s, u)?.away).length;
    const mine = r.skip.includes(app.me);
    return h(
      'div',
      { class: 'tile', style: 'display:flex;align-items:center;gap:12px;margin-bottom:18px' },
      h('span', { style: 'flex:1;font-size:17px' }, `Skip this track? ${r.skip.length} of ${here} racers want to. Over half skips it.`),
      btn(mine ? 'Take back my vote' : 'Vote to skip', () => app.act({ k: 'act', a: 'skip' }), 'small'),
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
      p.away ? 'disconnected' : '',
    ].filter(Boolean);
    return h(
      'div',
      { class: 'prow' + (u === this.app.me ? ' me' : '') + (p.away ? ' away' : '') },
      h('span', { class: 'pos mono ' + (pos === 1 ? 'amber' : '') }, String(pos)),
      h('div', { class: 'grow' }, h('div', { class: 'ell' }, `${flag(p.cc)} ${p.name}`), sub.length ? h('div', { class: 'sub ell' }, sub.join(' · ')) : null),
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
      const ping = p.u === s.host ? 0 : p.ping;
      const pingCls = ping == null ? '' : ping < 120 ? '' : ping < 250 ? 'mid' : 'bad';
      const pingText = p.u === s.host ? 'organizer' : ping == null ? '…' : `${ping} ms`;
      return h(
        'div',
        { class: 'prow' + (p.u === app.me ? ' me' : '') + (p.away ? ' away' : '') },
        h('span', { class: 'dot' + (p.away ? ' off' : '') }),
        h('div', { class: 'grow' }, h('div', { class: 'ell' }, `${flag(p.cc)} ${p.name}`, p.u === s.host ? h('span', { class: 'chip amber', style: 'margin-left:8px' }, 'Organizer') : null), h('div', { class: 'sub' }, p.away ? 'Disconnected · can rejoin with the same link' : p.out ? `Knocked out in round ${p.out}` : p.role === 'racer' ? 'Racing' : 'Watching')),
        h('span', { class: 'ping mono ' + pingCls, title: 'Round trip to the organizer' }, p.pid == null ? '' : pingText),
        host && p.u !== app.me
          ? h(
              'div',
              { class: 'acts' },
              p.role === 'racer'
                ? btn([icon('eye')], () => app.org!.setRole(p.u, 'spectator'), 'small ghost icon', 'Move to spectators')
                : btn([icon('flag')], () => app.org!.setRole(p.u, 'racer'), 'small ghost icon', 'Put on the grid'),
              confirmBtn('Remove', () => app.org!.kick(p.u), 'small danger', 'Remove from the cup'),
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
    const r = s.rules;
    const set = (change: Partial<Rules>) => {
      if (!app.org) return;
      if (lobby) app.org.configure(s.format, { ...r, ...change });
      else app.org.adjust(change as never);
    };
    const MID_CUP: (keyof Rules)[] = ['breakSeconds', 'freecam', 'lateJoin', 'finishWindow', 'next', 'readyEnds', 'countdownSeconds', 'voteSeconds', 'skipVotes'];
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
        if (Number.isFinite(n)) set({ [field]: Math.min(max, Math.max(min, n)) } as Partial<Rules>);
      });
      return row(label, hint, input);
    };
    const sec = (n: number) => fmtDuration(n);
    const sect = (title: string, ...rows: (HTMLElement | null)[]) => h('div', { class: 'sect' }, h('h3', null, title), h('div', { class: 'rules' }, rows));

    const winning = sect(
      'Winning',
      seg('mode', 'Decided by', '', [
        ['points', 'Points'],
        ['rounds', 'Rounds'],
        ['knockout', 'Knockout'],
      ]),
      r.mode === 'points' ? number('target', r.finalist ? 'Finalist at' : 'Points to win', 'The points cap', 1, 100000) : null,
      r.mode === 'points' ? toggle('finalist', 'Finalist rule', 'Reaching the cap makes you a finalist; then win a round to take the cup') : null,
      r.mode === 'rounds' ? slider('rounds', 'Rounds', 'Length of the season', 1, 50, 1, (n) => `${n}`) : null,
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
    const players = sect(
      'Players',
      toggle('lateJoin', 'Late joiners race', 'Newcomers can take a grid slot'),
      toggle('freecam', 'Spectator free camera', 'Let spectators fly around'),
      toggle('collisions', 'Bumper cars', 'Cars collide (times never upload)'),
      toggle('uploads', 'Upload PBs', 'Cup PBs go to the leaderboards (held for review)'),
    );
    return [
      lobby ? null : h('h3', { class: 'rules-title' }, host ? 'Rules (the greyed-out ones are fixed once the cup starts)' : 'Rules'),
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
      if (s.phase === 'lobby') items.push(btn([icon('play'), 'Start the cup'], () => (org.start(), this.setOpen(false)), 'primary big'));
      if (s.phase === 'podium') {
        items.push(btn('Race again', () => (org.raceAgain(false), this.setOpen(false))));
        items.push(btn('Race again on new tracks', () => (org.raceAgain(true), this.setOpen(false))));
        items.push(btn([icon('exit'), 'Close the cup'], () => app.onLeave('You closed the cup.'), 'small danger'));
      }
      if (s.phase === 'racing') {
        items.push(btn([icon('stop'), 'End round'], () => org.endRoundNow(), 'small ghost'));
        items.push(btn([icon('clock'), '+30 s'], () => org.extend(30), 'small ghost'));
      }
      if (live) {
        items.push(btn([icon('restart'), 'Restart round'], () => org.restartRound(), 'small ghost'));
        items.push(confirmBtn('Void round', () => org.voidRound(), 'small'));
      }
      if (s.phase !== 'lobby' && s.phase !== 'podium') {
        items.push(btn([icon('skip'), 'Skip track'], () => org.skipTrack(), 'small ghost'));
        items.push(btn([icon(s.hold ? 'play' : 'pause'), s.hold ? 'Resume' : 'Pause breaks'], () => org.setHold(!s.hold), 'small ' + (s.hold ? 'on' : 'ghost')));
      }
      items.push(h('span', { style: 'flex:1' }));
      const shout = this.#shoutInput;
      items.push(shout, btn([icon('megaphone')], () => shout.value.trim() && (org.shout(shout.value), (shout.value = '')), 'small ghost icon', 'Show a message to everyone'));
      if (s.phase !== 'lobby' && s.phase !== 'podium') items.push(confirmBtn('End cup', () => org.endCup(), 'small danger'));
    } else {
      items.push(h('span', { style: 'flex:1' }));
      items.push(btn([icon('exit'), 'Leave cup'], () => app.onLeave(''), 'small danger'));
    }
    return h('div', { class: 'ctl' }, items);
  }

  // ---- Chat ----

  // One stream: the cup's chat and, when the player has the main chat on, everyone else's. The box
  // and its buttons are built once, so typing (and a phone's keyboard) survives new messages.
  #renderChat() {
    const app = this.app,
      chat = app.chat,
      cup = chat.cup;
    const ui = (this.#chatUi ??= this.#buildChat());
    if (ui.box.parentElement !== this.#side) fill(this.#side, ui.box);
    const muted = chat.target === 'cup' && cup.muted;
    toggle(ui.cupBtn, 'on', chat.target === 'cup');
    toggle(ui.allBtn, 'on', chat.target === 'all');
    ui.allBtn.disabled = !chat.mainOn;
    ui.allBtn.title = chat.mainOn ? '' : 'Turn Chat on in the main menu to talk to everyone';
    ui.input.disabled = muted;
    ui.input.placeholder = muted ? 'The organizer muted you' : chat.target === 'cup' ? 'Message the cup' : 'Message everyone online';
    const lines = chat.lines();
    const key = JSON.stringify([chat.isHost, cup.status, lines.length, lines.at(-1)?.key, [...cup.mutes]]);
    if (key === this.#chatKey) return;
    this.#chatKey = key;
    const msgs = ui.msgs;
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    fill(
      msgs,
      lines.length
        ? lines.map(({ room, m }) =>
            h(
              'div',
              { class: 'msg' + (room === 'all' ? ' all' : '') },
              room === 'cup' && chat.isHost && m.uid !== cup.uid
                ? h('button', { class: 'mute', onclick: click(() => cup.mute(m.uid, !cup.mutes.has(m.uid))) }, cup.mutes.has(m.uid) ? 'unmute' : 'mute')
                : null,
              h('b', { style: `color:${nameColor(m.uid)}` }, room === 'all' ? h('span', { class: 'room' }, 'Everyone') : null, m.nick, room === 'cup' && cup.mutes.has(m.uid) ? ' (muted)' : ''),
              m.text,
            ),
          )
        : h('div', { class: 'empty' }, cup.status === 'on' ? 'No messages yet. Say hi!' : 'Connecting to chat…'),
    );
    chat.unreadAll = 0;
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
  }

  #chatUi: { box: HTMLElement; msgs: HTMLElement; input: HTMLInputElement; cupBtn: HTMLButtonElement; allBtn: HTMLButtonElement } | null = null;
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
    const cupBtn = h('button', { type: 'button', onmousedown: keep, onclick: click(() => chat.setTarget('cup')) }, 'Cup') as HTMLButtonElement;
    const allBtn = h('button', { type: 'button', onmousedown: keep, onclick: click(() => chat.setTarget('all')) }, 'Everyone') as HTMLButtonElement;
    // Who a message goes to; "Everyone" needs the main chat switched on in the menu.
    const target = h('div', { class: 'ctabs' }, h('span', { class: 'dim', style: 'font-size:14px;align-self:center;margin-right:4px' }, 'Send to'), h('div', { class: 'seg' }, cupBtn, allBtn));
    const box = h('div', { class: 'chat' }, h('div', { class: 'chathead' }, 'Chat'), msgs, target, form);
    return { box, msgs, input, cupBtn, allBtn };
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
