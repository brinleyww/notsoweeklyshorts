// The Competitions screen behind the main menu button: open cups, joining by code or link, and
// hosting. Hosting picks the name, format and maps before the room opens.
import type { App } from '../app.ts';
import { background, isBE, site, type Connection, type TrackData, type TrackMeta } from '../game.ts';
import { cleanRules, FORMATS, formatById, MAX_RACERS, PRODUCT } from '../rules.ts';
import { btn, click, h, icon, fill, range } from './dom.ts';

export interface MapPool {
  shorts: boolean;
  // Weeks of the shorts in the pool; empty means every week.
  weeks?: number[];
  main: string[];
  community: string[];
}
// Where a cup's tracks come from: the game's maps, tracks people bring, or tracks built in the cup.
export type Source = 'maps' | 'custom' | 'build';
interface Settings {
  public: boolean;
  max: number;
  name: string;
  pool: MapPool;
  format: string;
  role: 'racer' | 'spectator';
  source: Source;
  // Custom tracks: the game's maps as well, and whether racers add their own.
  mix: boolean;
  pick: 'everyone' | 'organizer';
  buildMin: number;
  // Casual: no clock, no points, no winner. Competitive: the formats with rules and a champion.
  casual: boolean;
}
interface Picked {
  code: string;
  mode?: string;
  name: string;
}
export interface CupStatus {
  phase: 'setup' | 'racing' | 'break' | 'done';
  round: number;
  racers: number;
  canRace: boolean;
  format: string;
}
interface ListedCup {
  code: string;
  name: string;
  host: string;
  players: number;
  max: number;
  status?: CupStatus | null;
}
export interface CupInfo {
  name: string;
  host: string;
  pool: MapPool;
  status?: CupStatus | null;
}

const MAIN = ['Summer', 'Winter', 'Desert'];
const CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const SETTINGS_KEY = 'nsws-sc-host';
const LIST_REFRESH_MS = 15_000;
const JOIN_TIMEOUT_MS = 20_000;
const NO_CUP = 'No open cup has that code. It may have ended.';
const SERVER_ERRORS: Record<string, string> = {
  SessionFull: 'That cup room is full.',
  BadRequest: 'That isn’t a valid cup code.',
  ExpiredInvite: NO_CUP,
  AlreadyHosted: 'That cup already has an organizer.',
  IpLimit: 'Too many cups were opened from your network in the last 10 minutes. Try again later.',
  ServerUnavailable: 'Competitions are offline right now. Try again later.',
};
const JOIN_ERRORS: Record<string, string> = {
  'server-connection': "Couldn't reach the Competitions server. Check your connection and try again.",
  expired: NO_CUP,
  full: 'That cup is full.',
  kicked: 'The organizer removed you from that cup.',
  webrtc: 'The connection to the cup dropped. Try again.',
  timeout: 'The cup didn’t answer in time. Try again in a moment.',
};
const PHASES: Record<CupStatus['phase'], string> = { setup: 'In the lobby', racing: 'Racing', break: 'Between rounds', done: 'Finished' };

export function readableError(message: string) {
  const reason = /unknown (?:server error|reason): (\w+)/.exec(message)?.[1];
  return (reason && SERVER_ERRORS[reason]) || SERVER_ERRORS[message] || message;
}

// A cup code from whatever was typed or pasted: the code in any case, an invite link (/c/CODE)
// or a link straight to the site (?cup=CODE).
export function cupCode(text: string) {
  const raw = text.trim();
  try {
    const link = new URL(raw);
    const fromQuery = link.searchParams.get('cup');
    if (fromQuery) return fromQuery.trim().toUpperCase();
    const fromPath = /^\/c\/([a-z0-9]{5})(?:\/|$)/i.exec(link.pathname);
    if (fromPath) return fromPath[1].toUpperCase();
  } catch {}
  const match = /[?&]cup=([a-z0-9]{5})|\/c\/([a-z0-9]{5})(?:[/?#]|$)/i.exec(raw);
  if (match) return (match[1] ?? match[2]).toUpperCase();
  return raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
}

// The cup list's format text: the format id, and "+custom", "+mix" or "+build" for where its tracks come from.
export function cupFormat(text: string | undefined) {
  const m = /^(.*?)(?:\+(custom|mix|build))?$/.exec(text ?? '');
  const id = m?.[1] ?? '';
  const src = (m?.[2] ?? (id === 'build' ? 'build' : null)) as 'custom' | 'mix' | 'build' | null;
  return { name: formatById(id)?.name ?? id, src };
}

export function tracksLabel(src: 'custom' | 'mix' | 'build' | null, pool: MapPool) {
  if (src === 'build') return 'Built by the racers during the cup';
  if (src === 'custom') return 'Custom tracks';
  if (src === 'mix') return `${poolLabel(pool)} + custom tracks`;
  return poolLabel(pool);
}

export function poolLabel(pool: MapPool) {
  const parts: string[] = [];
  if (pool.shorts) {
    const all = pool.weeks ?? [];
    const events = site.__nswsWeeks?.filter((w) => w.event && all.includes(w.week)) ?? [];
    const weeks = all.filter((w) => !events.some((e) => e.week === w)).sort((a, b) => a - b);
    if (weeks.length || !events.length) parts.push(weeks.length ? `Not So Weekly Shorts week${weeks.length > 1 ? 's' : ''} ${weeks.join(', ')}` : 'Not So Weekly Shorts');
    for (const e of events) parts.push(e.label ?? `Week ${e.week}`);
  }
  if (pool.main.length) parts.push(pool.main.join(', ') + ' main tracks');
  if (pool.community.length) parts.push('Community ' + pool.community.join(', '));
  return parts.join(' + ') || 'No maps';
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function loadSettings(): Settings {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') ?? {};
  } catch {}
  const pool = (saved.pool ?? {}) as Partial<MapPool>;
  return {
    public: saved.public !== false,
    max: Number.isInteger(saved.max) ? Math.min(MAX_RACERS, Math.max(2, saved.max as number)) : 10,
    name: typeof saved.name === 'string' ? saved.name : '',
    pool: { shorts: pool.shorts !== false, weeks: Array.isArray(pool.weeks) ? pool.weeks.filter((w) => Number.isInteger(w)) : [], main: strings(pool.main).filter((e) => MAIN.includes(e)), community: strings(pool.community) },
    format: typeof saved.format === 'string' && formatById(saved.format) && saved.format !== 'build' && saved.format !== 'casual' ? saved.format : 'quickplay',
    role: saved.role === 'spectator' ? 'spectator' : 'racer',
    source: saved.source === 'custom' || saved.source === 'build' ? saved.source : 'maps',
    mix: saved.mix === true,
    pick: saved.pick === 'organizer' ? 'organizer' : 'everyone',
    buildMin: Number.isInteger(saved.buildMin) ? Math.min(30, Math.max(1, saved.buildMin as number)) : 8,
    casual: saved.casual === true || saved.format === 'casual',
  };
}

export class Hub {
  el = h('div', { class: 'hub-wrap', hidden: true });
  #status = h('div', { class: 'hub-status' });
  #list = h('div', { class: 'cups' });
  #card = h('div', { class: 'hub-card', hidden: true });
  #code = h('input', {
    class: 'text codebox mono',
    type: 'text',
    maxlength: 300,
    placeholder: 'ABCDE',
    spellcheck: 'false',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'characters',
    enterkeyhint: 'go',
    'aria-label': 'Cup code or invite link',
  }) as HTMLInputElement;
  #settings = loadSettings();
  // Kept while the page is open; codes can be megabytes, too big for localStorage.
  #picked: Picked[] = [];
  #pasting = false;
  #listTimer = 0;
  #busy = false;
  #cancel: (() => void) | null = null;
  #joinCode: string | null = null;
  onKeys: () => void = () => {};
  onJoined: () => void = () => {};

  constructor(private app: App) {
    for (const type of ['keydown', 'keyup'] as const)
      this.el.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
          if (!this.#card.hidden && !this.#busy) this.#card.hidden = true;
          else this.close();
        }
      });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  // The cup room's code and, for its organizer, the secret its chat room checks.
  room() {
    const code = this.app.code ?? this.#joinCode;
    return this.app.connection && code ? { code, secret: this.app.isHost ? this.app.chatSecret : null } : null;
  }

  open() {
    this.el.hidden = false;
    this.#build();
    void this.#refresh(true);
    clearInterval(this.#listTimer);
    this.#listTimer = window.setInterval(() => !background() && !this.el.hidden && void this.#refresh(false), LIST_REFRESH_MS);
    setTimeout(() => this.#code.focus(), 50);
  }

  close() {
    if (this.#busy) this.#cancel?.();
    this.el.hidden = true;
    this.#card.hidden = true;
    clearInterval(this.#listTimer);
  }

  #say(text: string, error = false) {
    this.#status.textContent = text;
    this.#status.className = 'hub-status' + (error ? ' bad' : '');
  }

  #profileName() {
    try {
      return site.__nswsCup?.services().profiles.getCurrentUserProfile().nickname ?? '';
    } catch {
      return '';
    }
  }

  #save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.#settings));
    } catch {}
  }

  // ---- Layout ----

  #build() {
    const st = this.#settings;
    const tryJoin = () => {
      const value = cupCode(this.#code.value);
      if (!CODE.test(value)) return this.#say('Cup codes are 5 letters and numbers (no O, 0, I or 1). You can paste an invite link too.', true);
      this.#code.value = value;
      void this.join(value);
    };
    this.#code.oninput = () => {
      const v = cupCode(this.#code.value);
      if (v.length <= 5 && v !== this.#code.value) this.#code.value = v;
    };
    // A block body: an on* handler that returns false cancels the key, which made the box untypable.
    this.#code.onkeydown = (e) => {
      if (e.key === 'Enter') tryJoin();
    };

    const left = h(
      'section',
      { class: 'col' },
      h('div', { class: 'box' }, h('h3', null, 'Join with a code'), h('div', { class: 'joinrow' }, this.#code, btn('Join', tryJoin))),
      h('div', { class: 'box fill' }, h('div', { class: 'boxhead' }, h('h3', null, 'Open cups'), btn('Refresh', () => this.#refresh(true), 'small')), this.#list),
    );

    const nick = this.#profileName();
    const name = h('input', { class: 'text', maxlength: 40, placeholder: nick ? `${nick}'s cup` : 'My cup', value: st.name }) as HTMLInputElement;
    name.oninput = () => (st.name = name.value);
    const seg = <T extends string | boolean>(options: [T, string][], get: () => T, set: (v: T) => void) => {
      const wrap = h('div', { class: 'seg' });
      const paint = (): void =>
        fill(wrap, ...options.map(([v, label]) => h('button', { class: get() === v ? 'on' : '', onclick: click(() => (set(v), paint())) }, label)));
      paint();
      return wrap;
    };
    const size = range({ min: 2, max: MAX_RACERS, value: st.max });
    const sizeVal = h('span', { class: 'val' }, `${st.max} players`);
    size.oninput = () => {
      st.max = Number(size.value);
      sizeVal.textContent = `${st.max} players`;
    };
    const source = h('div', { class: 'srcrows' });
    const paintSource = (): void => fill(source, ...this.#sourceRows(paintSource));
    paintSource();
    const hint = h('p', { class: 'hint' });
    const paintHint = () =>
      (hint.textContent = st.casual
        ? 'Casual: no time limit and no winner. Everyone drives the track as long as they like, can join at any time, and votes for a new track when they are ready. Room size counts everyone, racers and spectators.'
        : st.source === 'build'
          ? 'You can change the build time and every rule once the room is open. Room size counts everyone, racers and spectators.'
          : 'You choose the format and rules once the room is open. Room size counts everyone, racers and spectators.');
    paintHint();
    const right = h(
      'section',
      { class: 'col' },
      h(
        'div',
        { class: 'box' },
        h('h3', null, 'Host a cup'),
        h('div', { class: 'frow' }, h('label', null, 'Name'), name),
        h(
          'div',
          { class: 'frow' },
          h('label', null, 'Tracks'),
          seg<Source>(
            [
              ['maps', 'Game maps'],
              ['custom', 'Custom tracks'],
              ['build', 'Build Off'],
            ],
            () => st.source,
            (v) => {
              st.source = v;
              this.#save();
              paintSource();
              paintHint();
            },
          ),
        ),
        source,
        h(
          'div',
          { class: 'frow' },
          h('label', null, 'Mode'),
          seg<boolean>(
            [
              [false, 'Competitive'],
              [true, 'Casual'],
            ],
            () => st.casual,
            (v) => {
              st.casual = v;
              this.#save();
              paintHint();
            },
          ),
        ),
        h('div', { class: 'frow' }, h('label', null, 'Room size'), size, sizeVal),
        h('div', { class: 'frow' }, h('label', null, 'Listed'), seg<boolean>([[true, 'Public'], [false, 'Code only']], () => st.public, (v) => (st.public = v))),
        h('div', { class: 'frow' }, h('label', null, 'You'), seg<'racer' | 'spectator'>([['racer', 'Race'], ['spectator', 'Only organize']], () => st.role, (v) => (st.role = v))),
        hint,
        btn('Open the room', () => {
          st.name = name.value.trim();
          this.#save();
          return this.host();
        }, 'wide primary'),
      ),
    );
    fill(
      this.el,
      h('div', { class: 'scrim', onclick: () => !this.#busy && this.close() }),
      h(
        'div',
        { class: 'hub' },
        h('header', null, h('div', { class: 'titles' }, h('h2', null, PRODUCT), h('p', null, 'Live cups: race other players in short rounds for points.')), btn('Keys', () => this.onKeys(), 'small'), btn('Close', () => this.close(), 'small')),
        h('div', { class: 'body' }, left, right),
        this.#status,
        this.#card,
      ),
    );
  }

  // The rows under Tracks for the chosen source.
  #sourceRows(repaint: () => void): HTMLElement[] {
    const st = this.#settings;
    const seg = <T extends string | boolean>(options: [T, string][], get: () => T, set: (v: T) => void) =>
      h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { class: get() === v ? 'on' : '', onclick: click(() => (set(v), this.#save(), repaint())) }, label)));
    if (st.source === 'maps') return [h('div', { class: 'frow top' }, h('label', null, 'Maps'), this.#maps(st.pool))];
    if (st.source === 'build') {
      const time = range({ min: 1, max: 30, value: st.buildMin });
      const val = h('span', { class: 'val' }, `${st.buildMin} min`);
      time.oninput = () => {
        st.buildMin = Number(time.value);
        val.textContent = `${st.buildMin} min`;
      };
      time.onchange = () => this.#save();
      return [
        h('div', { class: 'frow' }, h('label', null, 'Build time'), time, val),
        h('p', { class: 'hint' }, 'When you start, everyone gets this long to build a track in the editor. Then the cup races every track that came in, and anyone can save the ones they liked to My Tracks.'),
      ];
    }
    return [
      h('div', { class: 'frow top' }, h('label', null, 'Your tracks'), this.#pickedBox(repaint)),
      h('div', { class: 'frow' }, h('label', null, 'Racers add'), seg<'everyone' | 'organizer'>([['everyone', 'Their own tracks too'], ['organizer', 'Only my tracks']], () => st.pick, (v) => (st.pick = v))),
      h('div', { class: 'frow' }, h('label', null, 'Game maps'), seg<boolean>([[false, 'Not used'], [true, 'Mixed in']], () => st.mix, (v) => (st.mix = v))),
      st.mix ? h('div', { class: 'frow top' }, h('label', null, 'Maps'), this.#maps(st.pool)) : null,
    ].filter((x) => !!x) as HTMLElement[];
  }

  // Tracks the organizer brings: from My Tracks or pasted. They join the cup when the room opens.
  #pickedBox(repaint: () => void) {
    const lib = site.__nswsTracks;
    const list = this.#picked;
    const add = (items: { code: string; mode?: string; name?: string }[]) => {
      let added = 0;
      for (const t of items) {
        const code = String(t.code ?? '').trim();
        if (!code || list.some((x) => x.code === code)) continue;
        let name = t.name;
        if (!name) {
          try {
            name = lib?.parse?.(code)?.name || (isBE(code) ? '' : this.app.native.parse(code)?.trackMetadata?.name);
          } catch {}
        }
        list.push({ code, ...(t.mode && t.mode !== 'normal' ? { mode: t.mode } : {}), name: (name || 'Track').slice(0, 40) });
        added++;
      }
      if (!added && items.length) this.#say('Those tracks are already in the list.', true);
      else this.#say('');
      repaint();
    };
    const fromLibrary = async () => {
      const got = await lib?.pick?.({ multi: true });
      if (got?.length) add(got);
    };
    const box = h('input', { class: 'text', placeholder: 'Paste a track code, pack code or NSWS link', spellcheck: 'false', autocomplete: 'off', disabled: this.#pasting }) as HTMLInputElement;
    const paste = async () => {
      const text = box.value.trim();
      if (!text) return this.#say('Paste a track code first.', true);
      if (/^PolyTrack\S*$/.test(text) || !lib?.importText) return add([{ code: text }]);
      this.#pasting = true;
      repaint();
      try {
        const got = await lib.importText(text);
        if (!got.tracks?.length) return this.#say(got.club ? 'That is a club code. Join the club in Custom Tracks, then add its tracks from My Tracks.' : "That isn't a track code, pack code or NSWS link.", true);
        add(got.tracks);
      } catch (e) {
        this.#say((e as Error)?.message || "That link couldn't be read.", true);
      } finally {
        this.#pasting = false;
        repaint();
      }
    };
    box.onkeydown = (e) => {
      if (e.key === 'Enter') void paste();
    };
    const rows = list.map((t, i) =>
      h(
        'div',
        { class: 'pick' },
        h('span', { class: 'ell' }, t.name),
        t.mode ? h('span', { class: 'dim' }, t.mode === 'rocket' ? 'Rocket League' : 'Royale') : null,
        h('button', { class: 'x', type: 'button', title: 'Take it out', onclick: click(() => (list.splice(i, 1), repaint())) }, icon('x')),
      ),
    );
    return h(
      'div',
      { class: 'picked' },
      rows.length ? h('div', { class: 'picks' }, rows) : h('p', { class: 'hint' }, this.#settings.pick === 'everyone' ? 'None yet. Add some here, or let everyone bring theirs once the room is open.' : 'None yet. Add the tracks the cup will race.'),
      h('div', { class: 'joinrow' }, lib?.pick ? btn('Add from My Tracks', () => fromLibrary(), 'small') : null),
      h('div', { class: 'joinrow' }, box, btn(this.#pasting ? 'Adding…' : 'Add', () => !this.#pasting && paste(), 'small')),
    );
  }

  #maps(pool: MapPool) {
    const wrap = h('div', { class: 'maps' });
    const counts = new Map<string, number>(),
      mainCounts = new Map<string, number>(),
      weekCounts = new Map<number, number>();
    try {
      const tracks = site.__nswsCup?.services().tracks as {
        forEachCommunityTrack(cb: (id: string, group: string, meta: unknown) => void): void;
        forEachKodubCommunityTrack(cb: (id: string, group: string) => void): void;
        forEachOfficialTrack(cb: (id: string, meta: { name: string }) => void): void;
      };
      tracks?.forEachKodubCommunityTrack((_id, group) => counts.set(group, (counts.get(group) ?? 0) + 1));
      tracks?.forEachCommunityTrack((id, _group, meta) => {
        const week = site.__nswsTrackWeekMap?.[id];
        if (meta && week != null) weekCounts.set(week, (weekCounts.get(week) ?? 0) + 1);
      });
      tracks?.forEachOfficialTrack((_id, meta) => {
        const env = /^(Summer|Winter|Desert)\b/.exec(meta?.name ?? '')?.[1];
        if (env) mainCounts.set(env, (mainCounts.get(env) ?? 0) + 1);
      });
    } catch {}
    const versions = [...counts.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    pool.community = pool.community.filter((v) => counts.has(v));
    let showVersions = pool.community.length > 0;
    const weeks = [...weekCounts.keys()].sort((a, b) => b - a);
    pool.weeks ??= [];
    if (weeks.length) pool.weeks = pool.weeks.filter((w) => weekCounts.has(w));
    if (pool.weeks.length === weeks.length) pool.weeks = [];
    let showWeeks = pool.shorts && pool.weeks.length > 0;
    const weekOn = (w: number) => pool.shorts && (!pool.weeks!.length || pool.weeks!.includes(w));
    // An empty list means every week, so new weeks join a saved pool by themselves.
    const setWeeks = (list: number[]) => {
      pool.shorts = list.length > 0;
      pool.weeks = list.length === weeks.length ? [] : list;
    };
    const flipWeek = (w: number) => setWeeks(weeks.filter((x) => (x === w ? !weekOn(x) : weekOn(x))));
    const flip = (list: string[], v: string) => {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
      else list.push(v);
    };
    const chip = (label: string, on: boolean, fn: () => void, extra = '') =>
      h('button', { class: 'mapchip' + (on ? ' on' : '') + extra, onclick: click(() => (fn(), paint())) }, on ? icon('check') : null, label);
    const paint = (): void => {
      const chips: HTMLElement[] = [
        weeks.length > 1
          ? chip(`Not So Weekly Shorts${pool.shorts && pool.weeks!.length ? ` (${pool.weeks!.length})` : ''} ${showWeeks ? '▾' : '▸'}`, pool.shorts, () => (showWeeks = !showWeeks), ' more')
          : chip('Not So Weekly Shorts', pool.shorts, () => setWeeks(pool.shorts ? [] : weeks)),
        ...MAIN.map((env) => chip(`${env}${mainCounts.get(env) ? ` · ${mainCounts.get(env)}` : ''}`, pool.main.includes(env), () => flip(pool.main, env))),
      ];
      if (versions.length) chips.push(chip(`Community${pool.community.length ? ` (${pool.community.length})` : ''} ${showVersions ? '▾' : '▸'}`, pool.community.length > 0, () => (showVersions = !showVersions), ' more'));
      fill(wrap, 
        ...chips,
        showWeeks && weeks.length > 1
          ? h(
              'div',
              { class: 'versions' },
              weeks.map((w) => chip(`${site.__nswsWeeks?.find((x) => x.week === w)?.label ?? `Week ${w}`} · ${weekCounts.get(w)}`, weekOn(w), () => flipWeek(w))),
              h('button', { class: 'mapchip ghost', onclick: click(() => (setWeeks(pool.shorts && !pool.weeks!.length ? [] : weeks), paint())) }, pool.shorts && !pool.weeks!.length ? 'None' : 'All'),
            )
          : null,
        showVersions && versions.length
          ? h(
              'div',
              { class: 'versions' },
              versions.map((v) => chip(`${v} · ${counts.get(v)}`, pool.community.includes(v), () => flip(pool.community, v))),
              h('button', { class: 'mapchip ghost', onclick: click(() => ((pool.community = pool.community.length === versions.length ? [] : [...versions]), paint())) }, pool.community.length === versions.length ? 'None' : 'All'),
            )
          : null,
      );
    };
    paint();
    return wrap;
  }

  // ---- Open cups ----

  async #refresh(manual: boolean) {
    if (manual && !this.#list.children.length) fill(this.#list, h('div', { class: 'empty' }, 'Looking for open cups…'));
    try {
      const res = await fetch(site.__nswsApiBase + 'nsws/cup/list', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { cups?: ListedCup[] };
      const cups = (data.cups ?? []).filter((c) => CODE.test(c.code)).sort((a, b) => b.players - a.players);
      if (!cups.length) {
        fill(this.#list, h('div', { class: 'empty' }, 'No open cups right now. Host one and it shows up here for everyone.'));
        return;
      }
      fill(this.#list, ...cups.map((c) => this.#cupRow(c)));
    } catch {
      fill(this.#list, h('div', { class: 'empty bad' }, "Couldn't load the cup list. Refresh to try again."));
    }
  }

  #cupRow(c: ListedCup) {
    const full = c.players >= c.max;
    const st = c.status;
    const about = [
      `by ${c.host}`,
      st?.format ? cupFormat(st.format).name : '',
      st?.format && cupFormat(st.format).src ? { build: 'build your own tracks', custom: 'custom tracks', mix: 'plus custom tracks' }[cupFormat(st.format).src!] : '',
      st ? PHASES[st.phase] + (st.phase !== 'setup' && st.round ? `, round ${st.round}` : '') : '',
      st && !st.canRace && st.phase !== 'setup' ? 'watch only' : '',
    ].filter(Boolean);
    return h(
      'button',
      { class: 'cup' + (full ? ' full' : ''), disabled: full, onclick: click(() => this.join(c.code)) },
      h('div', { class: 'grow' }, h('div', { class: 'cname ell' }, c.name), h('div', { class: 'csub ell' }, about.join(' · '))),
      h('div', { class: 'cfill' }, full ? 'Full' : `${c.players}/${c.max}`),
    );
  }

  // ---- Hosting ----

  async host() {
    if (this.#busy) return;
    const st = this.#settings;
    const bridge = site.__nswsCup;
    if (!bridge) throw new Error('The game is still loading.');
    const custom = st.source === 'custom',
      build = st.source === 'build';
    const noMaps = !st.pool.shorts && !st.pool.main.length && !st.pool.community.length;
    if (noMaps && (st.source === 'maps' || (custom && st.mix))) return this.#say('Pick at least one set of maps.', true);
    if (custom && !this.#picked.length && st.pick === 'organizer') return this.#say('Add at least one track, or let racers add their own.', true);
    if (build && !site.__nswsEditor) return this.#say("The editor isn't available on this page, so a Build Off can't run here.", true);
    this.#busy = true;
    try {
      const sv = bridge.services();
      // Without maps of its own the cup still needs a lobby track: the main tracks then.
      const pool: MapPool = noMaps ? { shorts: false, weeks: [], main: [...MAIN], community: [] } : st.pool;
      site.__nswsCupPool = pool;
      const maps: (() => Promise<{ trackData: TrackData; trackMetadata: TrackMeta }>)[] = [];
      this.app.native.trackLibrary.forEachTrack((_id, _m, category, _e, load) => category !== 'custom' && maps.push(load));
      if (!maps.length) throw new Error('The tracks are still loading. Try again in a moment.');
      this.#say('Opening the room…');
      // A custom cup's lobby is its first ordinary track, so everyone practices on what they will race.
      let loaded: { trackData: TrackData; trackMetadata: TrackMeta } | null = null;
      if (custom)
        for (const t of this.#picked) {
          if (t.mode || isBE(t.code)) continue;
          try {
            const p = this.app.native.parse(t.code);
            if (p?.trackData?.hasStartingPoint?.()) {
              loaded = p as { trackData: TrackData; trackMetadata: TrackMeta };
              break;
            }
          } catch {}
        }
      loaded ??= await maps[Math.floor(Math.random() * maps.length)]();
      if (!loaded?.trackData?.hasStartingPoint?.()) throw new Error("That map couldn't be loaded. Try again.");
      const chat = randomHex(16);
      const saved = formatById(st.format);
      const format = st.casual ? formatById('casual')! : build ? formatById('build')! : saved && saved.id !== 'build' && saved.id !== 'casual' ? saved : FORMATS[0];
      const rules = cleanRules({
        ...format.rules,
        ...(custom ? { customTracks: true, customOnly: !st.mix, customPick: st.pick } : {}),
        ...(build ? { build: st.buildMin } : {}),
      });
      const nick = this.#profileName();
      const cupName = st.name || (nick ? `${nick}'s cup` : 'Cup');
      site.__nswsCupHostOptions = { public: st.public, max: st.max, name: cupName, pool, chat, reclaim: randomHex(16) };
      this.app.planHost({ name: cupName, format: format.id, rules, role: st.role, chatSecret: chat, tracks: custom ? this.#picked.map(({ code, mode }) => ({ code, mode })) : undefined });
      this.#joinCode = null;
      const host = new bridge.Host(sv.loc, sv.api, st.max, sv.profiles);
      const sessionId = host.startNewSessionImmediate(bridge.GameMode.Competitive, loaded.trackMetadata, loaded.trackData);
      host.requestInvite?.();
      this.close();
      this.#say('');
      bridge.startRace(loaded.trackMetadata, loaded.trackData, { multiplayerConnection: host, sessionId, gameMode: bridge.GameMode.Competitive });
      this.onJoined();
    } catch (error) {
      this.#say(readableError(error instanceof Error ? error.message : String(error)), true);
    } finally {
      this.#busy = false;
    }
  }

  // ---- Joining ----

  async join(code: string) {
    if (this.#busy) return;
    if (this.el.hidden) this.open();
    this.#say(`Looking up ${code}…`);
    let info: CupInfo | null;
    try {
      info = await this.#info(code);
    } catch {
      return this.#say(JOIN_ERRORS['server-connection'], true);
    }
    if (!info) return this.#say(NO_CUP, true);
    this.#say('');
    const st = info.status;
    const canRace = !st || st.canRace;
    const fact = (k: string, v: string) => [h('dt', null, k), h('dd', null, v)];
    fill(this.#card, 
      h(
        'div',
        { class: 'cardbox' },
        h('div', { class: 'kicker' }, `Cup ${code}`),
        h('h2', null, info.name),
        h('dl', null, fact('Organizer', info.host), fact('Tracks', tracksLabel(cupFormat(st?.format).src, info.pool)), st ? fact('Format', cupFormat(st.format).name) : null, st ? fact('Now', `${PHASES[st.phase]}${st.phase === 'setup' ? '' : ` · round ${st.round}`} · ${st.racers} racing`) : null),
        h('p', { class: 'dim' }, canRace ? (st && st.phase !== 'setup' ? 'The cup is under way. You can join the grid and start scoring from the next round, or just watch.' : 'Take a place on the grid, or just watch.') : 'You can watch this cup. Its grid is locked or full.'),
        h(
          'div',
          { class: 'acts' },
          btn('Cancel', () => (this.#card.hidden = true)),
          btn('Watch', () => this.#connect(code, info!, 'spectator')),
          canRace ? btn('Race', () => this.#connect(code, info!, 'racer')) : null,
        ),
      ),
    );
    this.#card.hidden = false;
  }

  // Back into a cup this page was in before the tab closed (mod/nsws_cup_rejoin.js already looked it up).
  rejoin(code: string, info: CupInfo, role: 'racer' | 'spectator') {
    if (this.#busy) return;
    if (this.el.hidden) this.open();
    this.#card.hidden = false;
    void this.#connect(code, info, role);
  }

  async #info(code: string) {
    const res = await fetch(site.__nswsApiBase + 'nsws/cup/info?code=' + code, { cache: 'no-store' });
    if (!res.ok) throw new Error('server');
    return ((await res.json()) as { cup: CupInfo | null }).cup;
  }

  async #connect(code: string, info: CupInfo, role: 'racer' | 'spectator') {
    if (this.#busy) return;
    this.#busy = true;
    const bridge = site.__nswsCup!;
    const text = h('p', { class: 'dim' }, `Joining ${info.name}…`);
    fill(this.#card, h('div', { class: 'cardbox' }, h('div', { class: 'spinner' }), h('h2', null, info.name), text, h('div', { class: 'acts' }, btn('Cancel', () => this.#cancel?.()))));
    let client: (Connection & { joinInvite(code: string, cancel: unknown): Promise<void>; addConnectionLostCallback(cb: () => void): void; removeConnectionLostCallback(cb: () => void): void }) | null = null;
    let cancelled = false;
    let timer = 0;
    try {
      const sv = bridge.services();
      site.__nswsCupPool = info.pool;
      site.__nswsCupJoinCode = code;
      this.app.planJoin(code, role);
      const token = new bridge.CancelToken();
      client = new bridge.Client(sv.loc, sv.api, sv.profiles, sv.records);
      const joined = client;
      let stop: (e: Error) => void = () => {};
      const stopped = new Promise<never>((_, reject) => (stop = reject));
      this.#cancel = () => {
        cancelled = true;
        token.cancel();
        stop(new Error('cancelled'));
      };
      timer = window.setTimeout(() => stop(Object.assign(new Error('timeout'), { errorType: 'timeout' })), JOIN_TIMEOUT_MS);
      await Promise.race([joined.joinInvite(code, token), stopped]);
      text.textContent = 'Connected. Loading the track…';
      const session = await Promise.race([
        new Promise<{ sessionId: number; gameMode: number; meta: TrackMeta; data: TrackData }>((resolve, reject) => {
          const onNew = (sessionId: number, gameMode: number, meta: TrackMeta, data: TrackData) => {
            joined.removeNewSessionCallback(onNew);
            joined.removeConnectionLostCallback(onLost);
            resolve({ sessionId, gameMode, meta, data });
          };
          const onLost = () => reject(Object.assign(new Error('lost'), { errorType: 'webrtc' }));
          joined.addNewSessionCallback(null, onNew);
          joined.addConnectionLostCallback(onLost);
        }),
        stopped,
      ]);
      this.#joinCode = code;
      this.close();
      bridge.startRace(session.meta, session.data, { multiplayerConnection: joined, sessionId: session.sessionId, gameMode: session.gameMode });
      this.onJoined();
    } catch (error) {
      client?.dispose();
      this.#card.hidden = true;
      if (!cancelled) {
        const type = (error as { errorType?: string }).errorType;
        const message = error instanceof Error ? error.message : String(error);
        this.#say((type && JOIN_ERRORS[type]) || (message !== 'lost' ? readableError(message) : JOIN_ERRORS.webrtc), true);
      } else this.#say('');
    } finally {
      clearTimeout(timer);
      this.#cancel = null;
      this.#busy = false;
    }
  }
}
