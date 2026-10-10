// The Competitions screen behind the main menu button: open cups, joining by code or link, and
// hosting. Hosting picks the cup's name and maps, starts a normal multiplayer room (through the
// proxy), creates the cup under that name and opens PolyCup's panel, where the host picks the rules.
import type { Controller } from '../src/controller.ts';

interface CupBridge {
  Host: new (loc: unknown, api: unknown, maxPlayers: number, profiles: unknown) => HostConnection;
  Client: new (loc: unknown, api: unknown, profiles: unknown, records: unknown) => ClientConnection;
  GameMode: { Casual: number; Competitive: number };
  CancelToken: new () => { cancel(): void };
  services(): {
    loc: unknown;
    api: unknown;
    profiles: { getCurrentUserProfile(): { nickname: string } };
    records: unknown;
    tracks: {
      forEachOfficialTrack(cb: (id: string, meta: { name: string }, data: TrackData, thumb: unknown) => void): void;
      forEachKodubCommunityTrack(cb: (id: string, group: string) => void): void;
    };
  };
  startRace(meta: unknown, data: TrackData, mp: { multiplayerConnection: unknown; sessionId: number; gameMode: number }): void;
}
interface TrackData {
  hasStartingPoint(): boolean;
}
interface HostConnection {
  startNewSessionImmediate(mode: number, meta: unknown, data: TrackData): number;
  requestInvite(): void;
  getInvite(): { inviteCode: string } | null;
  dispose(): void;
}
interface ClientConnection {
  joinInvite(code: string, cancel: unknown): Promise<void>;
  addNewSessionCallback(session: null, cb: NewSession): void;
  removeNewSessionCallback(cb: NewSession): void;
  addConnectionLostCallback(cb: () => void): void;
  removeConnectionLostCallback(cb: () => void): void;
  dispose(): void;
}
type NewSession = (sessionId: number, gameMode: number, meta: unknown, data: TrackData) => void;
export interface MapPool {
  shorts: boolean;
  main: string[];
  community: string[];
}
interface HostSettings {
  public: boolean;
  max: number;
  name: string;
  pool: MapPool;
}
interface ListedCup {
  code: string;
  name: string;
  host: string;
  players: number;
  max: number;
}

const site = window as unknown as {
  __nswsCup?: CupBridge;
  __nswsApiBase?: string;
  __nswsCupJoinCode?: string;
  __nswsCupHostOptions?: (HostSettings & { chat: string }) | null;
  __nswsCupPool?: MapPool;
  __nswsUIClick?: () => void;
  __nswsCupKeysPanel?: () => void;
};
const MAIN = ['Summer', 'Winter', 'Desert'];
const CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const SETTINGS_KEY = '_nswsCupHostSettings';
const LIST_REFRESH_MS = 15000;
const NO_CUP = 'No open cup has that code. It may have ended.';
const JOIN_ERRORS: Record<string, string> = {
  'server-connection': "Couldn't reach the Competitions server. Check your connection and try again.",
  expired: NO_CUP,
  full: 'That cup is full.',
  kicked: 'The organizer removed you from that cup.',
  webrtc: 'The connection to the cup dropped. Try again.',
};

const CSS = `
.nsws-cup{position:fixed;inset:0;z-index:9998;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:var(--text-color);font-family:inherit}
.nsws-cup.open{display:flex}
.nsws-cup .panel{width:min(1000px,96vw);max-height:92vh;display:flex;flex-direction:column;background:var(--surface-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%)}
.nsws-cup .head{display:flex;align-items:center;gap:14px;padding:14px 22px;background:var(--surface-secondary-color)}
.nsws-cup h2{margin:0;font-size:32px;font-weight:400;flex:1}
.nsws-cup .body{display:flex;gap:14px;padding:14px;min-height:0;flex-wrap:wrap}
.nsws-cup .col{display:flex;flex-direction:column;gap:10px;flex:1;min-width:280px}
.nsws-cup .box{background:var(--surface-secondary-color);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.nsws-cup h3{margin:0;font-size:22px;font-weight:400;opacity:.75}
.nsws-cup .button{font-size:21px;padding:6px 16px}
.nsws-cup .button.small{font-size:16px;padding:3px 10px}
.nsws-cup .button.on{background-color:#2f6db5}
.nsws-cup .button.go{background-color:#1d6b3a}
.nsws-cup input[type=text]{font:inherit;font-size:21px;color:var(--text-color);background:var(--surface-tertiary-color);border:none;padding:8px 12px;outline:none;min-width:0}
.nsws-cup .code{font-size:38px;letter-spacing:6px;text-transform:uppercase;text-align:center}
.nsws-cup .row{display:flex;align-items:center;gap:10px;padding:6px 8px;background:var(--surface-tertiary-color);font-size:19px}
.nsws-cup .row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsws-cup .dim{opacity:.6}
.nsws-cup .field{display:flex;align-items:center;gap:10px;font-size:19px;flex-wrap:wrap}
.nsws-cup .field label{flex:0 0 120px;opacity:.8}
.nsws-cup .field input[type=range]{flex:1;width:auto;min-width:0;margin:0 4px}
.nsws-cup input[type=range]::-webkit-slider-runnable-track{height:6px}
.nsws-cup input[type=range]::-webkit-slider-thumb{width:14px;height:20px;margin:-7px 0 0;border-width:3px;outline-width:1px}
.nsws-cup input[type=range]::-moz-range-track{height:6px}
.nsws-cup input[type=range]::-moz-range-thumb{width:8px;height:14px;border-width:3px;outline-width:1px}
.nsws-cup .hint{font-size:15px;opacity:.65}
.nsws-cup .error{color:#ff9a9a;font-size:17px;min-height:20px}
.nsws-cup .list{display:flex;flex-direction:column;gap:5px;overflow-y:auto;max-height:46vh}
.nsws-cup .foot{padding:8px 16px;font-size:14px;opacity:.55;background:var(--surface-secondary-color)}
.nsws-cup .maps{display:flex;flex-wrap:wrap;gap:6px;flex:1}
.nsws-cup .flyout{position:fixed;z-index:9999;display:none;flex-direction:column;gap:6px;min-width:220px;max-height:70vh;overflow-y:auto;padding:10px 12px;background:var(--surface-secondary-color);box-shadow:0 6px 24px rgba(0,0,0,.5);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.nsws-cup .flyout.open{display:flex}
.nsws-cup .flyout .button{text-align:left}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text: string, onClick: (b: HTMLButtonElement) => void, className = '') {
  const b = el('button', 'button ' + className, text);
  b.addEventListener('click', () => {
    site.__nswsUIClick?.();
    onClick(b);
  });
  return b;
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function loadSettings(): HostSettings {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') ?? {};
  } catch {}
  const pool = (saved.pool ?? {}) as Partial<MapPool>;
  return {
    public: saved.public !== false,
    max: Number.isInteger(saved.max) ? (saved.max as number) : 9,
    name: typeof saved.name === 'string' ? saved.name : '',
    pool: {
      shorts: pool.shorts !== false,
      main: strings(pool.main).filter((e) => MAIN.includes(e)),
      community: strings(pool.community),
    },
  };
}

export function poolLabel(pool: MapPool) {
  const parts: string[] = [];
  if (pool.shorts) parts.push('Not So Weekly Shorts');
  if (pool.main.length) parts.push(pool.main.join(', ') + ' main tracks');
  if (pool.community.length) parts.push('Community ' + pool.community.join(', '));
  return parts.join(' + ') || 'No maps';
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class CompetitionsHub {
  #controller: Controller;
  #root: HTMLElement;
  #error: HTMLElement;
  #list: HTMLElement;
  #busy = false;
  #joinCode: string | null = null;
  #chatSecret: string | null = null;
  #listTimer = 0;
  #flyout: HTMLElement;
  #closeFlyout = () => {};

  constructor(controller: Controller) {
    this.#controller = controller;
    const style = el('style');
    style.textContent = CSS;
    document.head.append(style);
    this.#root = el('div', 'nsws-cup');
    // Typing in the screen must not drive the car or trigger the game's shortcuts.
    for (const type of ['keydown', 'keyup'] as const)
      this.#root.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Escape') {
          if (this.#flyout.classList.contains('open')) this.#closeFlyout();
          else this.close();
        }
      });
    document.body.append(this.#root);
    this.#error = el('div', 'error');
    this.#list = el('div', 'list');
    this.#flyout = el('div', 'flyout');
    this.#build();
    this.#root.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.flyout,.community-toggle')) this.#closeFlyout();
    });
  }

  // The cup room's code and, for its organizer, the secret its chat room checks (src/chat.ts).
  room() {
    const code = this.activeCode();
    return code ? { code, secret: this.#chatSecret } : null;
  }

  // The cup the player is in (as host or guest), for tagging uploads.
  activeCode() {
    const connection = this.#controller.connection as unknown as { getInvite?(): { inviteCode: string } | null } | null;
    if (!connection) return null;
    return connection.getInvite?.()?.inviteCode ?? this.#joinCode;
  }

  open() {
    // Inside a cup the button opens the cup panel itself.
    if (this.#controller.connection && this.#controller.game) {
      this.#controller.requestPanel(true);
      return;
    }
    this.#root.classList.add('open');
    this.#error.textContent = '';
    this.#refreshList();
    clearInterval(this.#listTimer);
    this.#listTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') this.#refreshList();
    }, LIST_REFRESH_MS);
  }

  close() {
    this.#closeFlyout();
    this.#root.classList.remove('open');
    clearInterval(this.#listTimer);
  }

  #build() {
    const panel = el('div', 'panel');
    const head = el('div', 'head');
    head.append(
      el('h2', undefined, 'Competitions'),
      button('Keys', () => site.__nswsCupKeysPanel?.(), 'small'),
      button('Close', () => this.close(), 'small'),
    );
    const body = el('div', 'body');

    const left = el('div', 'col');
    const listBox = el('div', 'box');
    const listHead = el('div', 'field');
    const listTitle = el('h3', undefined, 'Open cups');
    listTitle.style.flex = '1';
    listHead.append(listTitle, button('Refresh', () => this.#refreshList(), 'small'));
    listBox.append(listHead, this.#list);
    left.append(listBox);

    const right = el('div', 'col');
    const joinBox = el('div', 'box');
    const code = el('input', 'code');
    code.type = 'text';
    code.maxLength = 5;
    code.placeholder = 'CODE';
    code.spellcheck = false;
    code.autocomplete = 'off';
    const tryJoin = () => {
      const value = code.value.trim().toUpperCase();
      if (!CODE.test(value)) {
        this.#error.textContent = 'Cup codes are 5 letters and numbers.';
        return;
      }
      void this.join(value);
    };
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryJoin();
    });
    joinBox.append(el('h3', undefined, 'Join with a code'), code, button('Join', tryJoin, 'go'));

    const settings = loadSettings();
    const hostBox = el('div', 'box');
    const name = el('input');
    name.type = 'text';
    name.maxLength = 40;
    name.placeholder = (this.#profileName() || 'My') + "'s cup";
    name.value = settings.name;
    const nameField = el('div', 'field');
    nameField.append(el('label', undefined, 'Name'), name);
    name.style.flex = '1';
    const publicBtn = button('Public', () => paint(true), 'small');
    const privateBtn = button('Private (code only)', () => paint(false), 'small');
    const paint = (value: boolean) => {
      settings.public = value;
      publicBtn.classList.toggle('on', value);
      privateBtn.classList.toggle('on', !value);
    };
    paint(settings.public);
    const visField = el('div', 'field');
    visField.append(el('label', undefined, 'Visibility'), publicBtn, privateBtn);
    const max = el('input');
    max.type = 'range';
    max.min = '2';
    max.max = '16';
    max.value = String(settings.max);
    const maxValue = el('span', undefined, String(settings.max));
    max.addEventListener('input', () => {
      settings.max = Number(max.value);
      maxValue.textContent = max.value;
    });
    const maxField = el('div', 'field');
    maxField.append(el('label', undefined, 'Room size'), max, maxValue);
    const mapsField = el('div', 'field');
    mapsField.append(el('label', undefined, 'Maps'), this.#mapPicker(settings.pool));
    hostBox.append(
      el('h3', undefined, 'Host a cup'),
      nameField,
      visField,
      maxField,
      mapsField,
      el('div', 'hint', 'Racers and spectators both take a place in the room (a cup races 2 to 8). You pick the format and rules in the cup panel once the room is open. Keys (top right) lists every key a cup uses.'),
      button('Host', () => {
        settings.name = name.value.trim();
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {}
        this.host(settings);
      }, 'go'),
    );
    right.append(joinBox, hostBox, this.#error);
    body.append(left, right);
    panel.append(head, body, el('div', 'foot', 'Cups run on PolyCup by Kiki, used with permission.'));
    this.#root.append(panel, this.#flyout);
  }

  // Weekly shorts, each environment's main tracks, and Kodub's community tracks by game version
  // (in a flyout beside their button). Only the weekly shorts are on unless the host turns more on.
  #mapPicker(pool: MapPool) {
    const maps = el('div', 'maps');
    const toggle = (text: string, on: () => boolean, flip: () => void) => {
      const b = button(text, () => {
        flip();
        b.classList.toggle('on', on());
        b.setAttribute('aria-pressed', String(on()));
      }, 'small');
      b.classList.toggle('on', on());
      b.setAttribute('aria-pressed', String(on()));
      return b;
    };
    const flipIn = (list: string[], value: string) => {
      const at = list.indexOf(value);
      if (at >= 0) list.splice(at, 1);
      else list.push(value);
    };
    maps.append(toggle('Not So Weekly Shorts', () => pool.shorts, () => (pool.shorts = !pool.shorts)));
    for (const env of MAIN) maps.append(toggle(env, () => pool.main.includes(env), () => flipIn(pool.main, env)));

    const counts = new Map<string, number>();
    try {
      site.__nswsCup?.services().tracks.forEachKodubCommunityTrack((_id, group) => counts.set(group, (counts.get(group) ?? 0) + 1));
    } catch {}
    const versions = [...counts.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    pool.community = pool.community.filter((v) => counts.has(v));
    if (!versions.length) return maps;
    const community = button('', () => {
      if (this.#flyout.classList.contains('open')) this.#closeFlyout();
      else open();
    }, 'small community-toggle');
    const label = () => {
      community.textContent = `Community tracks${pool.community.length ? ` (${pool.community.length})` : ''} ▸`;
      community.classList.toggle('on', pool.community.length > 0);
    };
    label();
    const open = () => {
      const rows = versions.map((v) =>
        toggle(`${v} · ${counts.get(v)} tracks`, () => pool.community.includes(v), () => {
          flipIn(pool.community, v);
          label();
        }),
      );
      const all = el('div', 'field');
      all.append(
        button('All', () => {
          pool.community = [...versions];
          rows.forEach((r) => r.classList.add('on'));
          label();
        }, 'small'),
        button('None', () => {
          pool.community = [];
          rows.forEach((r) => r.classList.remove('on'));
          label();
        }, 'small'),
      );
      this.#flyout.replaceChildren(el('h3', undefined, 'Community tracks'), ...rows, all);
      this.#flyout.classList.add('open');
      const at = community.getBoundingClientRect(),
        box = this.#flyout.getBoundingClientRect();
      const right = at.right + 8 + box.width <= window.innerWidth;
      this.#flyout.style.left = Math.max(8, right ? at.right + 8 : at.left - 8 - box.width) + 'px';
      this.#flyout.style.top = Math.max(8, Math.min(at.top, window.innerHeight - box.height - 8)) + 'px';
    };
    this.#closeFlyout = () => this.#flyout.classList.remove('open');
    maps.append(community);
    return maps;
  }

  #profileName() {
    try {
      return site.__nswsCup?.services().profiles.getCurrentUserProfile().nickname ?? '';
    } catch {
      return '';
    }
  }

  async #refreshList() {
    try {
      const response = await fetch(site.__nswsApiBase + 'nsws/cup/list', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { cups?: ListedCup[] };
      this.#list.replaceChildren();
      if (!data.cups?.length) this.#list.append(el('div', 'hint', 'No open cups right now. Host one!'));
      for (const cup of data.cups ?? []) {
        const row = el('div', 'row');
        const label = el('div', 'grow');
        label.append(el('span', undefined, cup.name + ' '), el('span', 'dim', cup.host));
        const go = button(cup.players >= cup.max ? 'Full' : 'Join', () => void this.join(cup.code), 'small');
        go.disabled = cup.players >= cup.max;
        row.append(label, el('span', 'dim', cup.players + '/' + cup.max), go);
        this.#list.append(row);
      }
    } catch {
      this.#list.replaceChildren(el('div', 'error', "Couldn't load the cup list."));
    }
  }

  #bridge() {
    const bridge = site.__nswsCup;
    if (!bridge) throw new Error('The game is still loading.');
    return bridge;
  }

  host(settings: HostSettings) {
    if (this.#busy) return;
    try {
      const pool = settings.pool;
      if (!pool.shorts && !pool.main.length && !pool.community.length) throw new Error('Pick at least one set of maps.');
      const cup = this.#bridge();
      const sv = cup.services();
      const official: { meta: { name: string }; data: TrackData }[] = [];
      sv.tracks.forEachOfficialTrack((_id, meta, data) => {
        if (data?.hasStartingPoint?.()) official.push({ meta, data });
      });
      if (!official.length) throw new Error('The tracks are still loading. Try again in a moment.');
      // The room needs a map to open on; the cup itself picks every map after that.
      const start = official[Math.floor(Math.random() * official.length)];
      this.#chatSecret = randomHex(16);
      site.__nswsCupHostOptions = { ...settings, chat: this.#chatSecret };
      site.__nswsCupPool = pool;
      this.#joinCode = null;
      const host = new cup.Host(sv.loc, sv.api, settings.max, sv.profiles);
      const sessionId = host.startNewSessionImmediate(cup.GameMode.Competitive, start.meta, start.data);
      host.requestInvite();
      this.close();
      cup.startRace(start.meta, start.data, { multiplayerConnection: host, sessionId, gameMode: cup.GameMode.Competitive });
      this.#openPanelSoon('Your cup room is open. Share the code, then set up the cup.', true);
    } catch (error) {
      this.#error.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async join(code: string) {
    if (this.#busy) return;
    this.#busy = true;
    this.#root.classList.add('open');
    this.#error.textContent = 'Joining ' + code + '...';
    let client: ClientConnection | null = null;
    try {
      const cup = this.#bridge();
      const sv = cup.services();
      const info = await this.#info(code);
      if (!info) throw new Error(NO_CUP);
      site.__nswsCupPool = info.pool;
      this.#chatSecret = null;
      site.__nswsCupJoinCode = code;
      client = new cup.Client(sv.loc, sv.api, sv.profiles, sv.records);
      await client.joinInvite(code, new cup.CancelToken());
      const joined = client;
      const session = await new Promise<{ sessionId: number; gameMode: number; meta: unknown; data: TrackData }>((resolve, reject) => {
        const onNew: NewSession = (sessionId, gameMode, meta, data) => {
          joined.removeNewSessionCallback(onNew);
          joined.removeConnectionLostCallback(onLost);
          resolve({ sessionId, gameMode, meta, data });
        };
        const onLost = () => reject(Object.assign(new Error('lost'), { errorType: 'webrtc' }));
        joined.addNewSessionCallback(null, onNew);
        joined.addConnectionLostCallback(onLost);
      });
      this.#joinCode = code;
      this.close();
      cup.startRace(session.meta, session.data, { multiplayerConnection: joined, sessionId: session.sessionId, gameMode: session.gameMode });
      this.#openPanelSoon();
    } catch (error) {
      client?.dispose();
      const type = (error as { errorType?: string }).errorType;
      this.#error.textContent = (type && JOIN_ERRORS[type]) || (error instanceof Error && error.message !== 'lost' ? error.message : JOIN_ERRORS.webrtc);
    } finally {
      this.#busy = false;
    }
  }

  async #info(code: string) {
    const response = await fetch(site.__nswsApiBase + 'nsws/cup/info?code=' + code, { cache: 'no-store' });
    if (!response.ok) throw Object.assign(new Error('server'), { errorType: 'server-connection' });
    return ((await response.json()) as { cup: { name: string; pool: MapPool } | null }).cup;
  }

  // The race (and PolyCup's view of it) only exists a moment after startRace. The organizer's cup is
  // created under the room's name as the proxy filtered it.
  #openPanelSoon(message = '', create = false) {
    const started = Date.now();
    let creating = false;
    const timer = window.setInterval(() => {
      const code = this.activeCode();
      if (this.#controller.connection && this.#controller.game && (!create || code)) {
        if (creating) return;
        if (create && !this.#controller.state) {
          creating = true;
          this.#info(code!)
            .catch(() => null)
            .then((info) => {
              if (this.activeCode() !== code || this.#controller.state) return;
              this.#controller.create(info?.name || this.#profileName() + "'s cup");
            })
            .catch((error) => this.#controller.fail(error))
            .finally(() => {
              window.clearInterval(timer);
              this.#controller.requestPanel(true, message);
            });
          return;
        }
        window.clearInterval(timer);
        this.#controller.requestPanel(true, message);
      } else if (Date.now() - started > 15000) window.clearInterval(timer);
    }, 200);
  }
}
