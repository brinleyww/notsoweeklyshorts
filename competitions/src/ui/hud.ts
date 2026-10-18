// Everything drawn over the race: the round bar, countdown, live board, spectator bar, results,
// votes, warm-up, chat feed, notices and the podium. Rebuilt only when what it shows changes;
// clocks are written in place once a frame, and only when their text changes.
import type { App } from '../app.ts';
import { NEXT_LABEL, PRODUCT } from '../rules.ts';
import { isFinalist, player, standings, type CupState, type Player } from '../state.ts';
import { btn, click, fmtClock, fmtGap, fmtTime, flag, h, icon, ordinal, setText, show, toggle, fill } from './dom.ts';

const BOARD_FULL = 10;

export class Hud {
  el = h('div', { class: 'hud', hidden: true });
  #bar = h('div', { class: 'roundbar', hidden: true });
  #count = h('div', { class: 'countdown', hidden: true });
  #board = h('div', { class: 'board', hidden: true });
  #watchers = h('div', { class: 'watchers', hidden: true });
  #right = h('div', { class: 'rcol' }, this.#watchers, this.#board);
  #toasts = h('div', { class: 'toasts' });
  #shout = h('div', { class: 'shout', hidden: true });
  #center = h('div', { class: 'center', hidden: true });
  #warm = h('div', { class: 'warm', hidden: true });
  #spec = h('div', { class: 'spec', hidden: true });
  #podium = h('div', { class: 'podium-wrap', hidden: true });
  #split = h('div', { class: 'split', hidden: true });
  #splitAt = 0;
  feed = h('div', { class: 'feed' });
  #keys: Record<string, string> = {};
  #clock: { el: HTMLElement; label: HTMLElement; box: HTMLElement } | null = null;
  #countN = -1;
  #shownNotes = new Set<number>();
  #lastTick = -1;
  onOpenPanel: () => void = () => {};
  onChatSubmit: (text: string) => Promise<void> = async () => {};
  onChatPanel: () => void = () => {};
  // A card in the middle (vote, results) covers the feed's corner; set by the layer.
  feedBlocked = false;
  chatOpen = false;
  // Height the right column has (layer units), set by the layer from what the game draws there.
  boardRoom = Infinity;

  constructor(private app: App) {
    this.el.append(this.#right, this.#split, this.#bar, this.#shout, this.#toasts, this.#count, this.#warm, this.#spec, this.#center, this.feed, this.#podium);
  }

  #changed(name: string, key: string) {
    if (this.#keys[name] === key) return false;
    this.#keys[name] = key;
    return true;
  }

  render() {
    const app = this.app,
      s = app.state;
    show(this.el, !!s && !!app.game);
    if (!s) return;
    this.#renderBar(s);
    this.#renderWatchers(s);
    this.#renderBoard(s);
    this.#renderCenter(s);
    this.#renderWarm(s);
    this.#renderSpec(s);
    this.#renderPodium(s);
    this.#renderToasts();
    this.#renderShout(s);
    this.#renderFeed();
    this.#renderSplit();
  }

  #renderSplit() {
    const sp = this.app.split;
    if (!sp || sp.at === this.#splitAt) return;
    this.#splitAt = sp.at;
    const tone = sp.gap == null || sp.place === 1 ? 'lead' : sp.gap <= 0 ? 'lead' : 'behind';
    fill(
      this.#split,
      h('span', { class: 'cp' }, `CP ${sp.cp}`),
      h('span', { class: 'place' }, ordinal(sp.place)),
      sp.gap != null && sp.place > 1 ? h('span', { class: 'gap mono ' + tone }, fmtGap(sp.gap)) : h('span', { class: 'gap lead' }, sp.gap == null ? 'First through' : 'Leading'),
    );
    this.#split.hidden = false;
    this.#split.style.animation = 'none';
    void this.#split.offsetWidth;
    this.#split.style.animation = '';
    clearTimeout(this.#splitTimer);
    this.#splitTimer = window.setTimeout(() => (this.#split.hidden = true), 2600);
  }
  #splitTimer = 0;

  // ---- Round bar ----

  #phaseLabel(s: CupState) {
    const r = s.round;
    switch (s.phase) {
      case 'draft':
        return s.draft?.stage === 'ban' ? 'Pick & ban: bans' : 'Pick & ban: picks';
      case 'lobby':
        return this.app.isHost ? 'Lobby · press Tab to set up and start' : 'Lobby · free practice until the organizer starts';
      case 'loading':
        return 'Loading the track…';
      case 'warmup':
        return 'Warm-up · practice freely';
      case 'countdown':
        return 'Get ready';
      case 'racing':
        return s.rules.style === 'timeattack' ? 'Time attack · your best run counts' : r?.closeAt ? 'Someone finished!' : 'Racing';
      case 'checking':
        return 'Checking runs…';
      case 'results':
        return s.hold ? 'Paused by the organizer' : s.winner != null ? 'We have a winner!' : 'Round results';
      case 'vote':
        return s.vote?.kind === 'vote' ? 'Vote for the next track' : 'Picking the next track';
      case 'podium':
        return 'Cup complete';
    }
  }

  #renderBar(s: CupState) {
    const r = s.round;
    const visible = s.phase !== 'podium';
    show(this.#bar, visible);
    if (!visible) return;
    const key = JSON.stringify([s.phase, r?.n, r?.k, r?.track.name, s.rounds, this.#phaseLabel(s), s.name]);
    if (!this.#changed('bar', key)) return;
    // The big number is the round on this track (2/3); the cup's own round count is in the line below.
    const n = r?.n ?? s.rounds + (s.phase === 'lobby' ? 0 : 1);
    const onTrack = s.phase === 'lobby' || s.phase === 'draft' || !r ? null : `${Math.max(1, r.k)}/${s.rules.perTrack}`;
    const label = h('small', null, onTrack ? 'ROUND' : 'LOBBY');
    const num = h('div', { class: 'num', title: onTrack ? 'Rounds on this track' : null }, label, h('span', { class: 'mono' }, onTrack ?? icon('flag')));
    const title = !onTrack ? s.name : r!.track.name;
    const cupRound = onTrack ? (s.rules.mode === 'rounds' ? `Cup round ${Math.max(1, n)}/${s.rules.rounds}` : `Cup round ${Math.max(1, n)}`) : '';
    const mid = h('div', { class: 'mid' }, h('div', { class: 'track ell' }, title), h('div', { class: 'sub ell' }, [cupRound, this.#phaseLabel(s)].filter(Boolean).join(' · ')));
    const clockLabel = h('small');
    const clockVal = h('span', { class: 'mono' });
    const clock = h('div', { class: 'clock' }, clockLabel, clockVal);
    this.#clock = { el: clockVal, label: clockLabel, box: clock };
    fill(this.#bar, num, mid, clock);
    this.tick();
  }

  // Once a frame: the clocks and the countdown.
  tick() {
    const app = this.app,
      s = app.state;
    if (!s) return;
    const vc = this.#voteClock;
    if (vc && vc.el.isConnected) {
      const left = vc.until - app.now();
      setText(vc.el, fmtClock(left));
      toggle(vc.el, 'warn', left < 5000);
    }
    const now = app.now(),
      r = s.round;
    let label = '',
      value = '',
      warn = false;
    switch (s.phase) {
      case 'warmup':
        if (r?.warmupUntil) [label, value] = ['Warm-up', fmtClock(r.warmupUntil - now)];
        break;
      case 'countdown':
        if (r?.startAt) [label, value] = ['Starts in', fmtClock(r.startAt - now)];
        break;
      case 'racing':
        if (!r?.startAt) break;
        if (s.rules.style === 'timeattack' && r.endAt) [label, value, warn] = ['Time left', fmtClock(r.endAt - now), r.endAt - now < 30_000];
        else if (r.closeAt) [label, value, warn] = ['Finish in', fmtClock(Math.min(r.closeAt, r.endAt ?? Infinity) - now), true];
        else if (r.endAt && r.endAt - now < 60_000) [label, value, warn] = ['Time limit', fmtClock(r.endAt - now), r.endAt - now < 15_000];
        else [label, value] = ['Race time', fmtTime(now - r.startAt).slice(0, 5)];
        break;
      case 'results':
        if (s.hold) [label, value] = ['Paused', '❚❚'];
        else if (s.nextAt) [label, value] = [s.winner != null ? 'Podium in' : 'Next in', fmtClock(s.nextAt - now)];
        break;
      case 'vote':
        if (s.vote) [label, value] = ['Closes in', fmtClock(s.vote.until - now)];
        break;
      case 'draft':
        if (s.draft) [label, value] = [s.draft.stage === 'ban' ? 'Bans close' : 'Picks close', fmtClock(s.draft.until - now)];
        break;
      case 'loading':
      case 'checking':
        [label, value] = ['', '…'];
        break;
    }
    if (this.#clock) {
      setText(this.#clock.label, label);
      setText(this.#clock.el, value);
      toggle(this.#clock.box, 'warn', warn);
      show(this.#clock.box, !!value);
    }
    // 3, 2, 1, GO
    let n = -1;
    if (r?.startAt && (s.phase === 'countdown' || s.phase === 'racing')) {
      const left = r.startAt - now;
      if (left > 0 && left <= 3000) n = Math.ceil(left / 1000);
      else if (left <= 0 && left > -1000) n = 0;
    }
    if (n !== this.#countN) {
      this.#countN = n;
      show(this.#count, n >= 0);
      if (n >= 0) {
        fill(this.#count, 
          h('div', { class: 'n' + (n === 0 ? ' go' : '') }, n === 0 ? 'GO!' : String(n)),
          n > 0 && r ? h('div', { class: 'label' }, r.track.name.toUpperCase()) : null,
        );
        if (n > 0 && this.#lastTick !== n) app.native.sound('tick');
        this.#lastTick = n;
      }
    }
    this.#tickBoard();
  }

  // How many cameras are on this racer's car, picked by hand or by the director.
  #renderWatchers(s: CupState) {
    const app = this.app,
      me = app.me;
    const live = (s.phase === 'countdown' || s.phase === 'racing') && app.driver.racing && !app.driver.done;
    const who = live ? s.players.filter((p) => p.watch === me && p.u !== me && p.pid != null && !p.away) : [];
    show(this.#watchers, who.length > 0);
    if (!who.length || !this.#changed('watchers', JSON.stringify(who.map((p) => p.name)))) return;
    fill(this.#watchers, icon('eye'), h('span', { class: 'mono' }, String(who.length)), h('span', { class: 'dim' }, 'watching'));
    this.#watchers.title = who.map((p) => p.name).join(', ');
  }

  // ---- Live board / standings ----

  #rows: { el: HTMLElement; val: HTMLElement; pid: number | null; u: number }[] = [];

  #renderBoard(s: CupState) {
    const app = this.app;
    const visible = !['podium', 'lobby', 'draft', 'results', 'checking', 'vote'].includes(s.phase);
    show(this.#board, visible);
    if (!visible) {
      this.#rows = [];
      return;
    }
    const r = s.round!;
    const live = ['countdown', 'racing'].includes(s.phase) && !!r;
    let order: number[];
    if (live) {
      const runs = r.runs;
      const fin = r.racers.filter((u) => runs[u] && runs[u].chk !== 2).sort((a, b) => runs[a].f - runs[b].f);
      const dnf = r.racers.filter((u) => !fin.includes(u) && (r.dnf.includes(u) || runs[u]?.chk === 2));
      const going = r.racers.filter((u) => !fin.includes(u) && !dnf.includes(u));
      const score = (u: number) => app.live.score(player(s, u)?.pid ?? -1);
      const table = standings(s, app.history).map((p) => p.u);
      going.sort((a, b) => score(b) - score(a) || table.indexOf(a) - table.indexOf(b));
      order = s.rules.style === 'timeattack' ? [...fin, ...going, ...dnf] : [...fin, ...going, ...dnf];
    } else order = standings(s, app.history).filter((p) => p.role === 'racer' || p.pts > 0).map((p) => p.u);
    let shown = order;
    let more = 0;
    // As many rows as fit: on a phone the touch buttons leave less room.
    const full = Math.max(3, Math.min(BOARD_FULL, Math.floor((this.boardRoom - 52 - (this.#watchers.hidden ? 0 : 40)) / 32)));
    if (order.length > full) {
      // The last line is the "+N more" note. Below the rows shown: the top, then whoever is ahead, you, and whoever is behind.
      const n = full - 1,
        i = app.me != null ? order.indexOf(app.me) : -1;
      if (i < n) shown = order.slice(0, n);
      else {
        let near = order.slice(i - 1, i + 2);
        if (n - near.length < 1) near = near.length === 3 ? near.slice(0, 2) : [app.me!];
        if (n - near.length < 1) near = [app.me!];
        shown = [...order.slice(0, n - near.length), ...near];
      }
      more = order.length - shown.length;
    }
    const watched = app.watch.active ? app.watch.target : null;
    const key = JSON.stringify([live, s.phase, shown, more, full, r?.runs, r?.dnf, watched, s.players.map((p) => [p.u, p.name, p.pts, p.out, p.fin, p.away])]);
    if (!this.#changed('board', key)) return;
    const head = h(
      'div',
      { class: 'head' },
      h('span', null, live ? (s.rules.style === 'timeattack' ? 'TIME ATTACK' : 'LIVE') : 'STANDINGS'),
      h('span', null, live ? `${Object.keys(r.runs).length}/${r.racers.length} finished` : s.rules.mode === 'knockout' ? `${s.players.filter((p) => p.role === 'racer' && !p.out).length} left` : s.rules.mode === 'rounds' ? `round ${s.rounds}/${s.rules.rounds}` : `to ${s.rules.target}`),
    );
    const firstTime = live ? Math.min(...Object.values(r.runs).filter((x) => x.chk !== 2).map((x) => x.f)) : Infinity;
    this.#rows = [];
    const rows = shown.map((u) => {
      const p = player(s, u);
      const run = live ? r.runs[u] : undefined;
      const pos = run && run.chk !== 2 ? Object.values(r.runs).filter((x) => x.chk !== 2 && x.f < run.f).length + 1 : order.indexOf(u) + 1;
      const isDnf = live && (r.dnf.includes(u) || run?.chk === 2);
      const val = h('span', { class: 'val mono' });
      const name = h('span', { class: 'name ell' }, live && isFinalist(s, p) ? h('span', { class: 'tag fin', title: 'Finalist' }, 'F') : null, p ? flag(p.cc) + (p.cc ? ' ' : '') + p.name : '?');
      const cls = ['row', `p${pos}`];
      if (u === app.me) cls.push('me');
      if (isDnf) cls.push('dnf');
      if (p?.out && !live) cls.push('out');
      if (watched != null && p?.pid === watched) cls.push('watched');
      let gain: HTMLElement | null = null;
      if (live && run && (run.wr || run.pb)) name.append(h('span', { class: 'badge' + (run.wr ? ' wr' : '') }, run.wr ? 'WR' : 'PB'));
      if (live && run && run.chk !== 2) {
        val.textContent = run.f === firstTime ? fmtTime(run.f) : fmtGap(run.f - firstTime);
        val.classList.add(run.f === firstTime ? 'fast' : 'time');
        if (run.chk === 0) val.textContent += ' ·';
        if (s.rules.mode !== 'knockout') {
          const place = Object.values(r.runs).filter((x) => x.chk !== 2 && x.f < run.f).length + 1;
          gain = h('span', { class: 'gain' }, `+${s.rules.points[place - 1] ?? 0}`);
        }
      } else if (isDnf) val.textContent = 'DNF';
      else if (!live && isFinalist(s, p)) {
        val.textContent = 'Finalist';
        val.classList.add('finalist');
      } else if (!live) val.textContent = s.rules.mode === 'knockout' ? (p?.out ? `out R${p.out}` : 'in') : `${p?.pts ?? 0}`;
      const row = h('div', { class: cls.join(' '), 'data-u': u }, h('span', { class: 'pos mono' }, String(pos)), name, gain, val);
      if (live && !run && !isDnf) this.#rows.push({ el: row, val, pid: p?.pid ?? null, u });
      return row;
    });
    // Rows slide to their new places instead of jumping.
    const before = new Map<string, number>();
    for (const el of this.#board.querySelectorAll<HTMLElement>('[data-u]')) before.set(el.dataset.u!, el.offsetTop);
    fill(this.#board, head, ...rows, more ? h('div', { class: 'more' }, `+${more} more · Tab for all`) : null);
    for (const el of this.#board.querySelectorAll<HTMLElement>('[data-u]')) {
      const was = before.get(el.dataset.u!);
      if (was != null && was !== el.offsetTop) el.animate([{ transform: `translateY(${was - el.offsetTop}px)` }, { transform: 'none' }], { duration: 350, easing: 'ease-out' });
    }
    this.#tickBoard();
  }

  // Racers still on track: checkpoint and gap, from live timing.
  #tickBoard() {
    const app = this.app,
      s = app.state;
    if (!s?.round || !this.#rows.length) return;
    const racers = s.round.racers.map((u) => player(s, u)?.pid).filter((x): x is number => x != null);
    for (const row of this.#rows) {
      if (row.pid == null) {
        setText(row.val, 'away');
        continue;
      }
      const prog = app.live.get(row.pid);
      if (!prog || !prog.started) {
        setText(row.val, s.phase === 'countdown' ? 'ready' : '—');
        continue;
      }
      const gap = prog.cp > 0 ? app.live.gapAt(row.pid, prog.cp - 1, racers) : null;
      setText(row.val, prog.cp === 0 ? 'CP 0' : gap ? `CP ${prog.cp} ${fmtGap(gap)}` : `CP ${prog.cp}`);
    }
  }

  // ---- Center: loading, results, vote ----

  #renderCenter(s: CupState) {
    const app = this.app;
    let kind = '';
    if (app.me == null && !app.isHost) kind = 'connecting';
    else if (s.phase === 'loading') kind = 'loading';
    else if (s.phase === 'results' || s.phase === 'checking') kind = 'results';
    else if (s.phase === 'vote') kind = 'vote';
    else if (s.phase === 'draft' && s.draft) kind = 'draft';
    show(this.#center, !!kind && !app.panelOpen);
    if (!kind) {
      this.#keys.center = '';
      return;
    }
    if (kind === 'connecting' || kind === 'loading') {
      const key = kind + (s.round?.track.name ?? '');
      if (!this.#changed('center', key)) return;
      const title = kind === 'connecting' ? 'Joining the cup…' : s.round?.track.name ?? 'Next track';
      const text = kind === 'connecting' ? 'Saying hello to the organizer.' : 'Everyone is loading the next track. The countdown starts once you are all in.';
      fill(this.#center, h('div', { class: 'card waiting' }, h('div', { class: 'spinner' }), h('div', { class: 'kicker amber' }, kind === 'loading' ? 'NEXT TRACK' : ''), h('h2', null, title), h('p', null, text)));
      return;
    }
    if (kind === 'results') return this.#renderResults(s);
    if (kind === 'draft') return this.#renderDraft(s);
    return this.#renderVote(s);
  }

  #renderResults(s: CupState) {
    const app = this.app;
    const checking = s.phase === 'checking';
    const last = app.history.at(-1) ?? null;
    const key = JSON.stringify([s.phase, last?.n, last?.rows, s.winner, s.hold, s.players.map((p) => [p.u, p.pts, p.out, p.fin])]);
    if (!this.#changed('center', key)) return;
    if (checking || !last) {
      fill(this.#center, h('div', { class: 'card waiting' }, h('div', { class: 'spinner' }), h('h2', null, 'Checking runs'), h('p', null, 'The organizer is replaying the finishes through the game’s physics.')));
      return;
    }
    const table = standings(s, app.history);
    const before = new Map<number, number>();
    {
      const prev = table.map((p) => ({ u: p.u, pts: p.pts - (last.rows.find((r) => r[0] === p.u)?.[3] ?? 0) }));
      prev.sort((a, b) => b.pts - a.pts).forEach((p, i) => before.set(p.u, i + 1));
    }
    const first = last.rows.find((r) => r[1] != null)?.[1] ?? null;
    const rows = last.void
      ? [h('tr', null, h('td', { colspan: 7, class: 'dim', style: 'text-align:center;padding:24px' }, 'This round was voided. No points were given.'))]
      : last.rows.map((row, i) => {
          const p = player(s, row[0]);
          const after = table.findIndex((t) => t.u === row[0]) + 1;
          const mv = (before.get(row[0]) ?? after) - after;
          const cls = [row[2] ? `p${row[2]}` : '', row[0] === app.me ? 'me' : '', row[4] ? 'out' : ''].join(' ');
          return h(
            'tr',
            { class: cls, style: `animation-delay:${Math.min(i, 14) * 45}ms` },
            h('td', { class: 'pos mono' }, row[2] ? String(row[2]) : '–'),
            h(
              'td',
              { class: 'name' },
              p ? `${flag(p.cc)} ${p.name}` : 'Left the cup',
              (row[5] ?? 0) & 2 ? h('span', { class: 'badge wr' }, 'WR') : (row[5] ?? 0) & 1 ? h('span', { class: 'badge' }, 'PB') : null,
              row[4] ? h('span', { class: 'badge', style: 'color:var(--bad)' }, 'OUT') : null,
            ),
            h('td', { class: 't mono' + (row[2] === 1 ? ' purple' : '') }, row[1] != null ? fmtTime(row[1]) : h('span', { class: 'bad' }, 'DNF')),
            h('td', { class: 'gap mono' }, row[1] != null && first != null && row[1] !== first ? fmtGap(row[1] - first) : ''),
            s.rules.mode !== 'knockout' ? h('td', { class: 'pts mono' }, row[3] ? `+${row[3]}` : '') : null,
            s.rules.mode !== 'knockout' ? h('td', { class: 'tot mono' }, isFinalist(s, p) ? h('span', { class: 'finalist' }, 'Finalist') : String(p?.pts ?? 0)) : null,
            h('td', { class: 'mv trend ' + (mv > 0 ? 'up' : mv < 0 ? 'down' : '') }, mv > 0 ? `▲${mv}` : mv < 0 ? `▼${-mv}` : ''),
          );
        });
    const winner = s.winner != null ? player(s, s.winner) : null;
    const finalists = s.rules.finalist ? s.players.filter((p) => p.fin) : [];
    const banner = winner
      ? h('div', { class: 'banner' }, icon('trophy'), ` ${winner.name} wins the cup!`)
      : finalists.length
        ? h('div', { class: 'banner' }, `Finalists: ${finalists.map((p) => p.name).join(', ')} · win a round to take the cup`)
        : null;
    const nextTxt = s.hold ? 'Paused by the organizer' : winner ? 'Podium next' : this.#nextLine(s);
    const barFill = h('i');
    const ctl = app.isHost
      ? [
          btn([icon(s.hold ? 'play' : 'pause'), s.hold ? 'Resume' : 'Pause'], () => app.org!.setHold(!s.hold), 'small ghost'),
          btn([icon('skip'), 'Next now'], () => app.org!.advance(), 'small primary'),
        ]
      : [];
    fill(this.#center, 
      h(
        'div',
        { class: 'card results' },
        h('div', { class: 'cap' }, h('div', null, h('div', { class: 'kicker' }, `Round ${last.n} results`), h('h2', null, last.track))),
        banner,
        h(
          'div',
          { class: 'scroll' },
          h(
            'table',
            null,
            last.void ? null : h('thead', null, h('tr', null, h('th'), h('th', null, 'Racer'), h('th', null, 'Time'), h('th', null, 'Gap'), s.rules.mode !== 'knockout' ? [h('th', null, 'Pts'), h('th', null, 'Total')] : null, h('th'))),
            h('tbody', null, rows),
          ),
        ),
        h('div', { class: 'bar' }, barFill),
        h('div', { class: 'foot' }, h('span', { class: 'grow dim' }, nextTxt), ...ctl),
      ),
    );
    if (s.nextAt && !s.hold) {
      const total = Math.max(1, s.nextAt - s.phaseAt);
      const left = Math.max(0, s.nextAt - app.now());
      barFill.animate([{ transform: `scaleX(${1 - left / total})` }, { transform: 'scaleX(1)' }], { duration: left, fill: 'forwards' });
    }
  }

  #nextLine(s: CupState) {
    const r = s.round;
    if (r && r.k < s.rules.perTrack) return `Same track again: round ${r.k + 1} of ${s.rules.perTrack}`;
    return `New track next · ${NEXT_LABEL[s.rules.next]}`;
  }

  #renderVote(s: CupState) {
    const app = this.app,
      v = s.vote;
    if (!v) return;
    const me = app.me;
    const myVote = me != null ? v.ballots[me] : undefined;
    const canVote = me != null && (v.kind === 'vote' ? player(s, me)?.role === 'racer' && !player(s, me)?.out : v.picker === me);
    const key = JSON.stringify([v, canVote]);
    if (!this.#changed('center', key)) return;
    const picker = player(s, v.picker);
    const title =
      v.kind === 'vote' ? 'Vote for the next track' : canVote ? 'You pick the next track' : `${picker?.name ?? 'Someone'} is picking the next track`;
    const kicker = v.kind === 'winner' ? 'WINNER PICKS' : v.kind === 'last' ? 'LAST PLACE PICKS' : v.kind === 'host' ? 'ORGANIZER PICKS' : 'TRACK VOTE';
    const voters = v.opts.map((_, i) =>
      Object.entries(v.ballots)
        .filter(([, b]) => b === i)
        .map(([u]) => player(s, +u)?.name ?? '?'),
    );
    const opts = v.opts.map((t, i) => {
      const thumb = h('div', { class: 'thumb' }, icon('flag'));
      this.#thumb(t.id).then((url) => {
        if (url) {
          thumb.style.backgroundImage = `url("${url}")`;
          fill(thumb);
        }
      });
      return h(
        'button',
        {
          class: 'opt' + (myVote === i ? ' mine' : ''),
          disabled: !canVote,
          onclick: () => {
            app.native.sound('checkpoint');
            app.act({ k: 'act', a: 'vote', v: i });
          },
        },
        thumb,
        h('div', { class: 'info' }, h('b', { class: 'ell' }, t.name), h('span', { class: 'dim ell', style: 'font-size:13px' }, t.author ? `by ${t.author}` : t.cat), h('div', { class: 'votes' }, voters[i].map((name) => h('span', { class: 'voter', title: name }, icon('user'))))),
      );
    });
    const hostBrowse = app.isHost && v.kind === 'host' ? btn([icon('search'), 'Browse all tracks'], () => this.onOpenPanel(), 'small ghost') : null;
    fill(this.#center, 
      h(
        'div',
        { class: 'card vote' },
        h('div', { class: 'cap' }, h('div', null, h('div', { class: 'kicker' }, kicker), h('h2', null, title)), this.#votePart(v.until)),
        this.#voteBar(v.until, s.phaseAt),
        h('div', { class: 'opts' }, opts),
        h('div', { class: 'foot' }, h('span', { class: 'grow dim' }, canVote ? 'Click a track to vote. You can change your mind until it closes.' : 'Watch the votes come in.'), hostBrowse),
      ),
    );
  }

  // Everyone bans, then picks, from the same list of tracks. Tiles wrap to the screen, so it works on a phone.
  #renderDraft(s: CupState) {
    const app = this.app,
      d = s.draft!;
    const me = app.me;
    const mePlayer = player(s, me);
    const racing = !!mePlayer && mePlayer.role === 'racer' && !mePlayer.out;
    const quota = d.stage === 'ban' ? s.rules.bans : s.rules.picks;
    const book = d.stage === 'ban' ? d.bans : d.picks;
    const mine = me != null ? (book[me] ?? []) : [];
    if (!this.#changed('center', JSON.stringify([d, racing, me]))) return;
    const banned = new Map<string, string[]>();
    for (const [u, ids] of Object.entries(d.bans)) for (const id of ids) banned.set(id, [...(banned.get(id) ?? []), player(s, +u)?.name ?? '?']);
    const picked = new Map<string, string[]>();
    for (const [u, ids] of Object.entries(d.picks)) for (const id of ids) picked.set(id, [...(picked.get(id) ?? []), player(s, +u)?.name ?? '?']);
    const racers = s.players.filter((p) => p.role === 'racer' && !p.out && !p.away);
    const done = racers.filter((p) => (book[p.u]?.length ?? 0) >= quota).length;
    const tiles = d.opts.map((t) => {
      const isBanned = banned.has(t.id);
      const thumb = h('div', { class: 'thumb' }, icon('flag'));
      this.#thumb(t.id).then((url) => {
        if (url) {
          thumb.style.backgroundImage = `url("${url}")`;
          fill(thumb);
        }
      });
      const who = isBanned ? `Banned by ${banned.get(t.id)!.join(', ')}` : picked.has(t.id) ? `Picked by ${picked.get(t.id)!.join(', ')}` : t.author ? `by ${t.author}` : '';
      const off = !racing || (d.stage === 'pick' && isBanned) || (!mine.includes(t.id) && mine.length >= quota);
      return h(
        'button',
        {
          class: 'opt' + (mine.includes(t.id) ? ' mine' : '') + (isBanned ? ' banned' : '') + (picked.has(t.id) ? ' picked' : ''),
          disabled: off && !mine.includes(t.id),
          onclick: () => {
            app.native.sound('checkpoint');
            app.act({ k: 'act', a: d.stage, v: t.id });
          },
        },
        thumb,
        h('div', { class: 'info' }, h('b', { class: 'ell' }, t.name), h('span', { class: 'dim ell', style: 'font-size:13px' }, who)),
      );
    });
    const verb = d.stage === 'ban' ? 'Ban' : 'Pick';
    const title = racing ? `${verb} ${quota === 1 ? 'a track' : quota + ' tracks'}` : d.stage === 'ban' ? 'Racers are banning tracks' : 'Racers are picking tracks';
    const sub = racing ? `${mine.length}/${quota} chosen · tap again to undo` : 'The cup plays the picked tracks.';
    fill(
      this.#center,
      h(
        'div',
        { class: 'card vote draft' },
        h('div', { class: 'cap' }, h('div', { class: 'kicker' }, `Pick & ban · ${d.stage === 'ban' ? 'step 1 of 2' : s.rules.bans ? 'step 2 of 2' : 'picks'}`), h('h2', null, title), h('div', { class: 'kicker' }, sub), this.#votePart(d.until)),
        this.#voteBar(d.until, s.phaseAt),
        h('div', { class: 'opts grid' }, tiles),
        h('div', { class: 'foot' }, h('span', { class: 'grow dim' }, `${done}/${racers.length} racers done`), app.isHost ? btn('Close this step now', () => app.org!.draftNow(), 'small') : null),
      ),
    );
  }

  // Seconds left to choose, counted down in place once a frame (see tick).
  #voteClock: { el: HTMLElement; until: number } | null = null;
  #votePart(until: number) {
    const el = h('div', { class: 'vclock mono' }, fmtClock(until - this.app.now()));
    this.#voteClock = { el, until };
    return el;
  }
  #voteBar(until: number, from: number) {
    const fillEl = h('i');
    const bar = h('div', { class: 'bar vbar' }, fillEl);
    const total = Math.max(1, until - from);
    const left = Math.max(0, until - this.app.now());
    fillEl.style.transform = `scaleX(${left / total})`;
    fillEl.animate([{ transform: `scaleX(${left / total})` }, { transform: 'scaleX(0)' }], { duration: left, fill: 'forwards' });
    return bar;
  }

  #thumbs = new Map<string, Promise<string | null>>();
  #thumb(id: string) {
    let p = this.#thumbs.get(id);
    if (!p) {
      p = new Promise((resolve) => {
        let found: Promise<string> | string | null = null;
        this.app.native.trackLibrary.forEachTrack((tid, _m, _c, _e, _l, thumb) => {
          if (tid === id) found = thumb;
        });
        Promise.resolve(found)
          .then((url) => resolve(typeof url === 'string' ? url : null))
          .catch(() => resolve(null));
      });
      this.#thumbs.set(id, p);
    }
    return p;
  }

  // ---- Warm-up ----

  #renderWarm(s: CupState) {
    const app = this.app;
    const visible = s.phase === 'warmup' && app.driver.racing;
    show(this.#warm, visible);
    if (!visible) return;
    const me = app.self;
    const r = s.round!;
    const ready = r.racers.filter((u) => player(s, u)?.ready).length;
    if (!this.#changed('warm', JSON.stringify([me?.ready, ready, r.racers.length]))) return;
    fill(this.#warm, 
      h('span', null, icon('flag'), ' Warm-up'),
      h('span', { class: 'dim' }, `${ready}/${r.racers.length} ready`),
      me?.ready ? h('span', { class: 'chip good' }, icon('check'), 'Ready') : btn([icon('check'), "I'm ready"], () => app.act({ k: 'act', a: 'ready' }), 'small good'),
    );
  }

  // ---- Spectating ----

  #specRefs: { name: HTMLElement; speed: HTMLElement; cp: HTMLElement; time: HTMLElement; keys: HTMLElement[] } | null = null;

  #renderSpec(s: CupState) {
    const app = this.app,
      w = app.watch;
    const offer = !w.active && app.driver.racing && app.driver.done && w.watchable().length > 0 && s.phase === 'racing';
    const visible = w.active || offer;
    show(this.#spec, visible);
    if (offer) {
      if (this.#changed('spec', 'offer')) {
        this.#specRefs = null;
        fill(this.#spec, h('div', { class: 'modes' }, btn([icon('eye'), 'Watch the others'], () => w.watchNow(), 'ghost')));
      }
      return;
    }
    if (!visible) {
      this.#specRefs = null;
      this.#keys.spec = '';
      return;
    }
    const target = w.mode === 'free' ? null : app.playerByPid(w.target);
    if (!this.#changed('spec', JSON.stringify([w.mode, target?.u, target?.name, w.cockpit, s.rules.freecam]))) return;
    const keys = [h('i'), h('i'), h('i'), h('i')];
    const name = h('div', { class: 'name ell' }, w.mode === 'free' ? 'Free camera' : target ? `${flag(target.cc)} ${target.name}` : '—');
    const speed = h('b', { class: 'mono' }),
      cp = h('b', { class: 'mono' }),
      time = h('b', { class: 'mono' });
    this.#specRefs = { name, speed, cp, time, keys };
    const mode = (m: 'director' | 'follow' | 'free', label: string, ic: string) =>
      btn([icon(ic), label], () => w.setMode(m), 'small ' + (w.mode === m ? 'on' : 'ghost'));
    const kb = app.keyNames();
    fill(this.#spec, 
      h(
        'div',
        { class: 'who' },
        w.mode === 'free' ? null : h('button', { class: 'arrow', title: `Previous racer (${kb.prev})`, onclick: () => w.cycle(-1) }, icon('left')),
        h(
          'div',
          { class: 'main' },
          h('div', { class: 'label' }, w.mode === 'director' ? 'Director cam' : w.mode === 'free' ? 'Spectating' : 'Watching'),
          name,
          w.mode === 'free' ? h('div', { class: 'stats' }, h('span', null, 'Fly with the driving keys')) : h('div', { class: 'stats' }, h('span', null, speed, ' km/h'), h('span', null, cp), h('span', null, time), h('div', { class: 'keys4' }, keys)),
        ),
        w.mode === 'free' ? null : h('button', { class: 'arrow', title: `Next racer (${kb.next})`, onclick: () => w.cycle(1) }, icon('right')),
      ),
      h(
        'div',
        { class: 'modes' },
        mode('director', 'Director', 'video'),
        mode('follow', 'Follow', 'eye'),
        s.rules.freecam ? mode('free', 'Free cam', 'camera') : null,
        w.mode !== 'free' ? btn(w.cockpit ? 'Chase view' : 'Cockpit view', () => ((w.cockpit = !w.cockpit), app.changed()), 'small ghost') : null,
      ),
    );
    this.tickSpec();
  }

  tickSpec() {
    const refs = this.#specRefs,
      w = this.app.watch;
    if (!refs || w.target == null || w.mode === 'free') return;
    const prog = this.app.live.get(w.target);
    const car = this.app.game ? this.app.native.remoteCar(this.app.game, w.target) : undefined;
    const st = car?.getCarState();
    setText(refs.speed, st ? String(Math.round(st.speedKmh)) : '0');
    setText(refs.cp, prog ? `CP ${prog.cp}` : 'CP 0');
    setText(refs.time, st ? fmtTime(st.finishFrames ?? st.frames) : '');
    const c = st?.controls;
    const on = [c?.up, c?.left, c?.down, c?.right];
    refs.keys.forEach((k, i) => toggle(k, 'on', !!on[i]));
  }

  // ---- Podium ----

  #renderPodium(s: CupState) {
    const visible = s.phase === 'podium';
    show(this.#podium, visible);
    if (!visible) {
      this.#keys.podium = '';
      return;
    }
    const app = this.app;
    const table = standings(s, app.history);
    if (!this.#changed('podium', JSON.stringify([s.id, table.map((p) => [p.u, p.pts, p.name]), app.bestRun()?.n]))) return;
    const step = (p: Player | undefined, place: number) => {
      if (!p) return h('div', { class: `step s${place}`, style: 'visibility:hidden' }, h('div', { class: 'block' }));
      const img = h('img', { class: 'car', alt: '' }) as HTMLImageElement;
      const lobby = app.lobby.find((l) => l.id === p.pid);
      if (lobby?.carStyle) app.native.carThumbnail(lobby.carStyle).then((url) => (img.src = url)).catch(() => {});
      return h(
        'div',
        { class: `step s${place}` },
        img,
        h('div', { class: 'pname ell' }, `${flag(p.cc)} ${p.name}`),
        h('div', { class: 'ppts' }, s.rules.mode === 'knockout' ? (place === 1 ? 'Last one standing' : `Out in round ${p.out ?? '?'}`) : `${p.pts} pts · ${p.wins} win${p.wins === 1 ? '' : 's'}`),
        h('div', { class: 'block' }, String(place)),
      );
    };
    const rest = table.slice(3).map((p, i) => h('span', null, `${ordinal(i + 4)} ${p.name} · ${s.rules.mode === 'knockout' ? `R${p.out ?? '-'}` : p.pts}`));
    const acts: HTMLElement[] = [];
    const best = app.bestRun();
    if (best) acts.push(btn([icon('clip'), 'Clip my best run'], () => this.#clip(), 'ghost'));
    acts.push(btn([icon('trophy'), 'Full results'], () => this.onOpenPanel(), 'ghost'));
    if (app.isHost) {
      acts.push(btn('Race again', () => app.org!.raceAgain(false)));
      acts.push(btn('New tracks', () => app.org!.raceAgain(true)));
      acts.push(btn([icon('exit'), 'Close the cup'], () => app.onLeave('You closed the cup.'), 'danger'));
    } else acts.push(btn([icon('exit'), 'Leave'], () => app.onLeave(''), 'ghost'));
    const me = table.findIndex((p) => p.u === app.me);
    const winner = table[0];
    const wrap = h(
      'div',
      { class: 'podium' },
      h('div', { class: 'title' }, h('div', { class: 'kicker' }, `${PRODUCT.toUpperCase()} · ${s.name.toUpperCase()}`), h('h1', null, winner ? `${winner.name} wins!` : 'Cup complete'), me >= 0 ? h('div', { class: 'dim', style: 'margin-top:10px;font-size:18px' }, `You finished ${ordinal(me + 1)} of ${table.length}`) : null),
      h('div', { class: 'steps' }, step(table[1], 2), step(table[0], 1), step(table[2], 3)),
      rest.length ? h('div', { class: 'rest' }, rest) : null,
      h('div', { class: 'actions' }, acts),
    );
    const colors = ['#ffd54a', '#ff8f3d', '#5ad1ff', '#4be393', '#c49bff', '#ff5d70', '#ffffff'];
    for (let i = 0; i < 70; i++)
      wrap.append(
        h('i', {
          class: 'confetti',
          style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${3 + Math.random() * 3}s;animation-delay:${0.8 + Math.random() * 2.5}s;transform:rotate(${Math.random() * 180}deg)`,
        }),
      );
    fill(this.#podium, wrap);
    if (winner?.u === app.me) app.native.sound('record');
  }

  async #clip() {
    const result = await this.app.saveBestRun();
    this.app.notify(result === 'duplicate' ? 'That run is already in your clips' : result ? 'Saved to your clips' : "Couldn't save the clip", result ? 'good' : 'bad');
  }

  // ---- Notices ----

  #renderToasts() {
    const now = Date.now();
    for (const n of this.app.notes) {
      if (this.#shownNotes.has(n.id) || now - n.at > 4000) continue;
      this.#shownNotes.add(n.id);
      const el = h('div', { class: 'toast ' + n.tone }, n.text);
      el.addEventListener('animationend', () => el.remove());
      this.#toasts.append(el);
      while (this.#toasts.children.length > 4) this.#toasts.firstElementChild!.remove();
    }
  }

  #renderShout(s: CupState) {
    const sh = s.shout;
    const fresh = !!sh && Date.now() - sh.at < 8000;
    show(this.#shout, fresh);
    if (!fresh || !this.#changed('shout', String(sh!.at))) return;
    const el = h('div', null, icon('megaphone'), ' ', h('span', null, h('b', { style: 'font-weight:400' }, 'Organizer: '), sh!.text));
    fill(this.#shout, el);
    this.#shout.style.animation = 'none';
    void this.#shout.offsetWidth;
    this.#shout.style.animation = '';
    this.app.native.sound('checkpoint');
  }

  // ---- Chat feed ----

  #feedInput: HTMLInputElement | null = null;
  #feedLines = h('div', { style: 'display:flex;flex-direction:column;align-items:flex-start;gap:4px' });
  #feedBottom = h('div');
  #lineEls = new Map<string, HTMLElement>();
  #feedOpen: boolean | null = null;
  #feedTarget = '';
  // Lines are kept by message (so their fade isn't restarted) and the box survives new messages.
  // Messages from everyone online (the main chat) are tagged.
  #renderFeed() {
    const app = this.app,
      chat = app.chat;
    show(this.feed, !app.panelOpen && app.state?.phase !== 'podium' && (!this.feedBlocked || this.chatOpen));
    if (!this.feed.firstChild) fill(this.feed, this.#feedLines, this.#feedBottom);
    const last = chat.lines(5);
    const keys = new Set(last.map((l) => l.key));
    for (const [k, el] of this.#lineEls)
      if (!keys.has(k)) {
        el.remove();
        this.#lineEls.delete(k);
      }
    for (const { key, m } of last) {
      if (this.#lineEls.has(key)) continue;
      const el = h('div', { class: 'line' }, h('b', { style: `color:${nameColor(m.uid)}` }, m.nick), m.text);
      this.#lineEls.set(key, el);
      this.#feedLines.append(el);
    }
    toggle(this.feed, 'open', this.chatOpen);
    const target = chat.target + chat.mainOn + matchMedia('(pointer: coarse)').matches;
    if (this.#feedOpen === this.chatOpen && this.#feedTarget === target) return;
    this.#feedOpen = this.chatOpen;
    this.#feedTarget = target;
    if (this.chatOpen) {
      const touch = matchMedia('(pointer: coarse)').matches;
      const to = chat.target === 'all' ? 'Message everyone online' : 'Message the cup';
      const input = h('input', { class: 'text', maxlength: 200, enterkeyhint: 'send', autocomplete: 'off', placeholder: touch ? to : `${to}… (Enter to send, Esc to close)` }) as HTMLInputElement;
      input.value = this.#draft;
      this.#feedInput = input;
      let sending = false;
      input.addEventListener('input', () => (this.#draft = input.value));
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') this.closeChat();
      });
      input.addEventListener('keyup', (e) => e.stopPropagation());
      // Clicking or tapping anywhere else closes the box; what was typed stays for next time.
      input.addEventListener('blur', () =>
        setTimeout(() => {
          if (this.chatOpen && this.#feedInput === input && document.hasFocus() && (this.feed.getRootNode() as ShadowRoot).activeElement !== input) this.closeChat();
        }, 0),
      );
      // Buttons beside the box don't take its focus.
      const keep = (e: Event) => e.preventDefault();
      const toggleTarget =
        chat.mainOn || chat.target === 'all'
          ? h('button', { class: 'btn small', type: 'button', title: 'Switch between the cup chat and everyone online', onmousedown: keep, onclick: click(() => chat.setTarget(chat.target === 'all' ? 'cup' : 'all')) }, chat.target === 'all' ? 'Everyone' : 'Cup')
          : null;
      const form = h(
        'form',
        {
          class: 'box',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const text = input.value;
            if (!text.trim()) return this.closeChat();
            if (sending) return;
            sending = true;
            this.onChatSubmit(text)
              .then(() => {
                if (this.#draft === text) this.#draft = '';
                // Only the box that sent it, and only if nothing more was typed meanwhile.
                if (this.#feedInput === input && input.value === text) {
                  input.value = '';
                  this.closeChat();
                }
              })
              .catch((err) => app.notify(err instanceof Error ? err.message : String(err), 'bad'))
              .finally(() => (sending = false));
          },
        },
        toggleTarget,
        input,
        touch ? h('button', { class: 'btn small', type: 'submit', onmousedown: keep }, 'Send') : null,
      );
      const hadFocus = (this.feed.getRootNode() as ShadowRoot).activeElement?.closest?.('.feed') != null;
      fill(this.#feedBottom, form);
      if (hadFocus) input.focus();
    } else {
      this.#feedInput = null;
      fill(this.#feedBottom, h('div', { class: 'hint', onclick: () => this.openChat() }, matchMedia('(pointer: coarse)').matches ? 'Chat' : `${app.keyNames().chat} chat · ${app.keyNames().panel} cup`));
    }
  }

  #draft = '';
  openChat() {
    if (this.feedBlocked) return this.onChatPanel();
    this.chatOpen = true;
    this.app.driver.clearInput();
    this.#renderFeed();
    // Focused inside the click or key press itself: phones only raise the keyboard for that.
    this.#feedInput?.focus();
    this.app.changed();
  }
  closeChat() {
    this.chatOpen = false;
    const input = this.#feedInput;
    this.#feedInput = null;
    input?.blur();
    this.app.changed();
  }
}

export function nameColor(uid: string) {
  let hash = 0;
  for (const c of uid) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 85% 72%)`;
}

