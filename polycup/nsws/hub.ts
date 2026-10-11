// The Competitions screen behind the main menu button: open cups, joining by code or link, and
// hosting. Hosting picks the cup's name and maps, starts a normal multiplayer room (through the
// proxy), creates the cup under that name and opens PolyCup's panel, where the host picks the rules.
import type { Controller } from '../src/controller.ts';
import * as Cup from '../src/cup.ts';
import { rosterOpen } from '../src/draft.ts';
import { rulesFor } from '../src/presets.ts';

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
  toMenu(): void;
}
interface TrackData {
  hasStartingPoint(): boolean;
}
interface HostConnection {
  startNewSessionImmediate(mode: number, meta: unknown, data: TrackData): number;
  requestInvite(): void;
  getInvite(): { inviteCode: string } | null;
  reportCupStatus?(status: CupStatus): void;
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
  official?: boolean;
}
// What the organizer's page reports about its cup (shown in the list and on the join card).
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
  official?: boolean;
  status?: CupStatus | null;
}
interface CupInfo {
  name: string;
  host: string;
  pool: MapPool;
  official?: boolean;
  status?: CupStatus | null;
}

const site = window as unknown as {
  __nswsCup?: CupBridge;
  __nswsApiBase?: string;
  __nswsCupJoinCode?: string;
  __nswsCupHostOptions?: (HostSettings & { chat: string; reclaim: string; ownerKey?: string | null }) | null;
  __nswsCupPool?: MapPool;
  __nswsUIClick?: () => void;
  __nswsCupKeysPanel?: () => void;
  __nswsMessageBox?: { show(text: string, button: string, callback: null): void };
  __nswsOwner?: { check(): Promise<boolean>; token(): Promise<string | null> };
};
const MAIN = ['Summer', 'Winter', 'Desert'];
const CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const SETTINGS_KEY = '_nswsCupHostSettings';
const LIST_REFRESH_MS = 15000;
const JOIN_TIMEOUT_MS = 20000;
const NO_CUP = 'No open cup has that code. It may have ended.';
const JOIN_ERRORS: Record<string, string> = {
  'server-connection': "Couldn't reach the Competitions server. Check your connection and try again.",
  expired: NO_CUP,
  full: 'That cup is full.',
  kicked: 'The organizer removed you from that cup.',
  webrtc: 'The connection to the cup dropped. Try again.',
  timeout: 'The cup didn’t answer in time. Try again in a moment.',
};
// Refusals from the proxy (proxy/src/lobby.js, worker.js) as they reach the game.
const SERVER_ERRORS: Record<string, string> = {
  SessionFull: 'That cup room is full.',
  BadRequest: 'That isn’t a valid cup code.',
  ExpiredInvite: NO_CUP,
  AlreadyHosted: 'That cup already has an organizer.',
  IpLimit: 'Too many cups were opened from your network in the last 10 minutes. Try again later.',
  ServerUnavailable: 'Competitions are offline right now. Try again later.',
};
export function readableError(message: string) {
  const reason = /unknown (?:server error|reason): (\w+)/.exec(message)?.[1];
  return (reason && SERVER_ERRORS[reason]) || SERVER_ERRORS[message] || message;
}
// A cup code from whatever was typed or pasted: the code itself in any case, or an invite link.
export function cupCode(text: string) {
  const raw = text.trim();
  try {
    const fromLink = new URL(raw).searchParams.get('cup');
    if (fromLink) return fromLink.trim().toUpperCase();
  } catch {}
  const match = /[?&]cup=([a-z0-9]{5})/i.exec(raw);
  if (match) return match[1].toUpperCase();
  return raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
}
const PHASES: Record<CupStatus['phase'], string> = {
  setup: 'Setting up',
  racing: 'Racing',
  break: 'Between rounds',
  done: 'Finished',
};
export function statusLine(status: CupStatus | null | undefined) {
  if (!status) return '';
  const round = status.phase === 'setup' ? '' : ` · round ${status.round}`;
  return `${status.format} · ${PHASES[status.phase]}${round} · ${status.racers} racing`;
}

const CSS = `
.nsws-cup{--s:var(--ui-scale-factor,1);position:fixed;left:0;top:0;width:calc(100% / var(--s));height:calc(100% / var(--s));transform:scale(var(--s));transform-origin:0 0;z-index:9998;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:var(--text-color);font-family:inherit}
.nsws-cup.open{display:flex}
.nsws-cup [hidden]{display:none!important}
.nsws-cup .panel{width:min(1000px,calc(96vw / var(--s)));max-height:calc(92vh / var(--s));display:flex;flex-direction:column;background:var(--surface-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%)}
.nsws-cup .head{display:flex;align-items:center;gap:14px;padding:14px 22px;background:var(--surface-secondary-color)}
.nsws-cup h2{margin:0;font-size:32px;font-weight:400;flex:1}
.nsws-cup .intro{margin:0;padding:10px 22px 0;font-size:18px;line-height:1.35;opacity:.85}
.nsws-cup .body{display:flex;gap:14px;padding:14px;min-height:0;flex-wrap:wrap;overflow-y:auto}
.nsws-cup .col{display:flex;flex-direction:column;gap:10px;flex:1;min-width:280px}
.nsws-cup .box{background:var(--surface-secondary-color);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.nsws-cup h3{margin:0;font-size:22px;font-weight:400;opacity:.75}
.nsws-cup .button{font-size:21px;padding:6px 16px}
.nsws-cup .button.small{font-size:16px;padding:3px 10px}
.nsws-cup .button.on{background-color:#2f6db5}
.nsws-cup .button.go{background-color:#1d6b3a}
.nsws-cup .button:disabled{opacity:.5;cursor:default}
.nsws-cup input[type=text]{font:inherit;font-size:21px;color:var(--text-color);background:var(--surface-tertiary-color);border:none;padding:8px 12px;outline:none;min-width:0}
.nsws-cup .code{font-size:38px;letter-spacing:6px;text-transform:uppercase;text-align:center}
.nsws-cup .row{display:flex;align-items:center;gap:10px;padding:6px 8px;background:var(--surface-tertiary-color);font-size:19px;cursor:pointer}
.nsws-cup .row:hover,.nsws-cup .row:focus-visible{outline:2px solid #2f6db5;outline-offset:-2px}
.nsws-cup .row.full{cursor:default;opacity:.7}
.nsws-cup .row .grow{flex:1;min-width:0;overflow:hidden}
.nsws-cup .row .grow > div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsws-cup .row .sub{font-size:15px;opacity:.7}
.nsws-cup .official{color:#ffd26b}
.nsws-cup .dim{opacity:.6}
.nsws-cup .field{display:flex;align-items:center;gap:10px;font-size:19px;flex-wrap:wrap}
.nsws-cup .field label{flex:0 0 120px;opacity:.8}
.nsws-cup .field input[type=range]{flex:1;width:auto;min-width:0;margin:0 4px}
.nsws-cup input[type=range]::-webkit-slider-runnable-track{height:6px}
.nsws-cup input[type=range]::-webkit-slider-thumb{width:14px;height:20px;margin:-7px 0 0;border-width:3px;outline-width:1px}
.nsws-cup input[type=range]::-moz-range-track{height:6px}
.nsws-cup input[type=range]::-moz-range-thumb{width:8px;height:14px;border-width:3px;outline-width:1px}
.nsws-cup .hint{font-size:15px;opacity:.65;line-height:1.3}
.nsws-cup .error{color:#ff9a9a;font-size:17px;min-height:20px}
.nsws-cup .status{color:var(--text-color);opacity:.85;font-size:17px;min-height:20px}
.nsws-cup .list{display:flex;flex-direction:column;gap:5px;overflow-y:auto;max-height:calc(46vh / var(--s))}
.nsws-cup .foot{padding:8px 16px;font-size:14px;opacity:.55;background:var(--surface-secondary-color)}
.nsws-cup .maps{display:flex;flex-wrap:wrap;gap:6px;flex:1}
.nsws-cup .flyout{position:fixed;z-index:9999;display:none;flex-direction:column;gap:6px;min-width:220px;max-height:calc(70vh / var(--s));overflow-y:auto;padding:10px 12px;background:var(--surface-secondary-color);box-shadow:0 6px 24px rgba(0,0,0,.5);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.nsws-cup .flyout.open{display:flex}
.nsws-cup .flyout .button{text-align:left}
.nsws-cup .card{position:absolute;inset:0;z-index:2;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
.nsws-cup .card.open{display:flex}
.nsws-cup .card > div{width:min(560px,calc(92vw / var(--s)));background:var(--surface-color);padding:18px 22px;display:flex;flex-direction:column;gap:10px;clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%)}
.nsws-cup .card h3{font-size:30px;opacity:1}
.nsws-cup .card .facts{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:18px}
.nsws-cup .card .facts dt{opacity:.7}
.nsws-cup .card .facts dd{margin:0}
.nsws-cup .card .actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(text: string, onClick: (b: HTMLButtonElement) => void, className = '') {
  const b = el('button', 'button ' + className, text);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
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
  #rows = new Map<string, HTMLElement>();
  #refresh!: HTMLButtonElement;
  #card: HTMLElement;
  #code!: HTMLInputElement;
  #busy = false;
  #joinCode: string | null = null;
  #chatSecret: string | null = null;
  #reclaim: string | null = null;
  #listTimer = 0;
  #sentStatus = '';
  #flyout: HTMLElement;
  #closeFlyout = () => {};
  #cancelJoin: (() => void) | null = null;
  #official = false;
  #intent: 'race' | 'watch' = 'race';

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
          else if (this.#card.classList.contains('open')) this.#closeCard();
          else this.close();
        }
      });
    document.body.append(this.#root);
    this.#error = el('div', 'error');
    this.#error.setAttribute('role', 'status');
    this.#list = el('div', 'list');
    this.#flyout = el('div', 'flyout');
    this.#card = el('div', 'card');
    this.#build();
    this.#root.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.flyout,.community-toggle')) this.#closeFlyout();
      if (e.target === this.#root && !this.#busy) this.close();
    });
    window.setInterval(() => this.#reportStatus(), 3000);
  }

  // The cup room's code and, for its organizer, the secret its chat room checks (src/chat.ts).
  room() {
    const code = this.activeCode();
    return code ? { code, secret: this.#chatSecret } : null;
  }

  // An official cup (hosted with the owner key): its winner gets the Cup Champion tag.
  get official() {
    return this.#official && this.#controller.isHost;
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
    this.#show();
    this.#say('');
    this.#code.focus();
  }

  #show() {
    this.#root.classList.add('open');
    void this.#refreshList(true);
    clearInterval(this.#listTimer);
    this.#listTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.#refreshList(false);
    }, LIST_REFRESH_MS);
  }

  close() {
    if (this.#busy && this.#cancelJoin) this.#cancelJoin();
    this.#closeFlyout();
    this.#closeCard();
    this.#root.classList.remove('open');
    clearInterval(this.#listTimer);
  }

  #say(text: string, error = false) {
    this.#error.className = error ? 'error' : 'status';
    this.#error.textContent = text;
  }

  #build() {
    const panel = el('div', 'panel');
    panel.style.position = 'relative';
    const head = el('div', 'head');
    head.append(
      el('h2', undefined, 'Competitions'),
      button('Keys', () => site.__nswsCupKeysPanel?.(), 'small'),
      button('Close', () => this.close(), 'small'),
    );
    const intro = el(
      'p',
      'intro',
      'Race other players live. A cup is a series of short rounds: each finish scores points, and the first to the target wins (or play knockout, time attack and more). Join an open cup, enter a code, or host your own.',
    );
    const body = el('div', 'body');

    const left = el('div', 'col');
    const listBox = el('div', 'box');
    const listHead = el('div', 'field');
    const listTitle = el('h3', undefined, 'Open cups');
    listTitle.style.flex = '1';
    this.#refresh = button('Refresh', () => void this.#refreshList(true), 'small');
    listHead.append(listTitle, this.#refresh);
    listBox.append(listHead, this.#list);
    left.append(listBox);

    const right = el('div', 'col');
    const joinBox = el('div', 'box');
    const code = el('input', 'code');
    this.#code = code;
    code.type = 'text';
    code.maxLength = 300;
    code.placeholder = 'CODE';
    code.spellcheck = false;
    code.autocomplete = 'off';
    code.setAttribute('aria-label', 'Cup code or invite link');
    code.addEventListener('input', () => {
      const value = cupCode(code.value);
      if (value.length <= 5 && value !== code.value) code.value = value;
    });
    code.addEventListener('paste', () => setTimeout(() => (code.value = cupCode(code.value).slice(0, 12)), 0));
    const tryJoin = () => {
      const value = cupCode(code.value);
      if (!CODE.test(value)) {
        this.#say('Cup codes are 5 letters and numbers (there is no O, 0, I or 1). You can also paste an invite link.', true);
        return;
      }
      code.value = value;
      void this.join(value);
    };
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryJoin();
    });
    joinBox.append(el('h3', undefined, 'Join with a code or link'), code, button('Join', tryJoin, 'go'));

    const settings = loadSettings();
    const hostBox = el('div', 'box');
    const name = el('input');
    name.type = 'text';
    name.maxLength = 40;
    const nick = this.#profileName();
    name.placeholder = nick ? `${nick}'s cup` : 'My cup';
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
      publicBtn.setAttribute('aria-pressed', String(value));
      privateBtn.setAttribute('aria-pressed', String(!value));
    };
    paint(settings.public);
    const visField = el('div', 'field');
    visField.append(el('label', undefined, 'Visibility'), publicBtn, privateBtn);
    const max = el('input');
    max.type = 'range';
    max.min = '2';
    max.max = '25';
    max.value = String(settings.max);
    max.setAttribute('aria-label', 'Room size');
    const roomText = (n: number) => `${n} players`;
    const maxValue = el('span', undefined, roomText(settings.max));
    max.addEventListener('input', () => {
      settings.max = Number(max.value);
      maxValue.textContent = roomText(settings.max);
    });
    const maxField = el('div', 'field');
    maxField.append(el('label', undefined, 'Room size'), max, maxValue);
    const mapsField = el('div', 'field');
    mapsField.append(el('label', undefined, 'Maps'), this.#mapPicker(settings.pool));
    const officialField = el('div', 'field');
    officialField.hidden = true;
    const official = el('input');
    official.type = 'checkbox';
    official.id = 'nsws-cup-official';
    const officialLabel = el('label', undefined, 'Official cup');
    officialLabel.htmlFor = official.id;
    officialField.append(
      officialLabel,
      official,
      el('span', 'hint', 'Announced to everyone online with a Join button; the winner gets the Cup Champion tag.'),
    );
    void site.__nswsOwner?.check().then((owner) => (officialField.hidden = !owner), () => {});
    hostBox.append(
      el('h3', undefined, 'Host a cup'),
      nameField,
      visField,
      maxField,
      mapsField,
      officialField,
      el(
        'div',
        'hint',
        'Everyone in the room counts towards its size, you included, and each player chooses to race or watch. You start on the grid and pick the format (points, knockout, time attack, collisions…) once the room is open. Keys (top right) lists every key a cup uses.',
      ),
      button('Host', () => {
        settings.name = name.value.trim();
        settings.official = !officialField.hidden && official.checked;
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, official: undefined }));
        } catch {}
        void this.host(settings);
      }, 'go'),
    );
    right.append(joinBox, hostBox, this.#error);
    body.append(left, right);
    panel.append(head, intro, body, el('div', 'foot', 'Cups run on PolyCup by Kiki, used with permission.'), this.#card);
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
    const counts = new Map<string, number>(),
      mainCounts = new Map<string, number>();
    try {
      const tracks = site.__nswsCup?.services().tracks;
      tracks?.forEachKodubCommunityTrack((_id, group) => counts.set(group, (counts.get(group) ?? 0) + 1));
      tracks?.forEachOfficialTrack((_id, meta) => {
        const env = /^(Summer|Winter|Desert)\b/.exec(meta?.name ?? '')?.[1];
        if (env) mainCounts.set(env, (mainCounts.get(env) ?? 0) + 1);
      });
    } catch {}
    maps.append(toggle('Not So Weekly Shorts', () => pool.shorts, () => (pool.shorts = !pool.shorts)));
    for (const env of MAIN)
      maps.append(
        toggle(
          `${env} main${mainCounts.get(env) ? ` · ${mainCounts.get(env)}` : ''}`,
          () => pool.main.includes(env),
          () => flipIn(pool.main, env),
        ),
      );
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
      // Measured in window pixels; the screen is scaled like the game's UI.
      const scale = parseFloat(document.documentElement.style.getPropertyValue('--ui-scale-factor')) || 1;
      const at = community.getBoundingClientRect(),
        box = this.#flyout.getBoundingClientRect();
      const right = at.right + 8 + box.width <= window.innerWidth;
      this.#flyout.style.left = Math.max(8, right ? at.right + 8 : at.left - 8 - box.width) / scale + 'px';
      this.#flyout.style.top = Math.max(8, Math.min(at.top, window.innerHeight - box.height - 8)) / scale + 'px';
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

  // Rows are updated in place (keyed by code) so nothing moves under the pointer; a manual refresh
  // re-sorts them.
  async #refreshList(manual: boolean) {
    if (manual) {
      this.#refresh.disabled = true;
      this.#refresh.textContent = 'Refreshing…';
      if (!this.#rows.size) this.#list.replaceChildren(el('div', 'hint', 'Loading open cups…'));
    }
    try {
      const response = await fetch(site.__nswsApiBase + 'nsws/cup/list', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { cups?: ListedCup[] };
      const cups = (data.cups ?? []).filter((c) => CODE.test(c.code));
      const seen = new Set(cups.map((c) => c.code));
      for (const [code, row] of this.#rows)
        if (!seen.has(code)) {
          row.remove();
          this.#rows.delete(code);
        }
      this.#list.querySelector('.hint,.error')?.remove();
      if (manual) for (const row of this.#rows.values()) row.remove();
      const ordered = manual
        ? [...cups].sort((a, b) => Number(!!b.official) - Number(!!a.official) || b.players - a.players)
        : cups;
      for (const cup of ordered) {
        const row = this.#rows.get(cup.code) ?? this.#row(cup.code);
        this.#fillRow(row, cup);
        if (manual || !row.isConnected) this.#list.append(row);
      }
      if (!cups.length) this.#list.replaceChildren(el('div', 'hint', 'No open cups right now. Host one, and it shows up here for everyone.'));
    } catch {
      this.#list.replaceChildren(el('div', 'error', "Couldn't load the cup list. Refresh to try again."));
      this.#rows.clear();
    } finally {
      this.#refresh.disabled = false;
      this.#refresh.textContent = 'Refresh';
    }
  }

  #row(code: string) {
    const row = el('div', 'row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const open = () => {
      if (row.classList.contains('full')) return;
      site.__nswsUIClick?.();
      void this.join(code);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    this.#rows.set(code, row);
    return row;
  }

  #fillRow(row: HTMLElement, cup: ListedCup) {
    const full = cup.players >= cup.max;
    row.classList.toggle('full', full);
    const label = el('div', 'grow');
    const title = el('div');
    if (cup.official) title.append(el('span', 'official', '★ Official · '));
    title.append(el('span', undefined, cup.name + ' '), el('span', 'dim', cup.host));
    label.append(title);
    const line = statusLine(cup.status);
    if (line) label.append(el('div', 'sub', line + (cup.status && !cup.status.canRace && cup.status.phase !== 'setup' ? ' · watch only' : '')));
    const action = el('span', 'button small ' + (full ? '' : 'go'), full ? 'Full' : 'Join');
    row.replaceChildren(label, el('span', 'dim', cup.players + '/' + cup.max), action);
    row.setAttribute('aria-label', `${full ? 'Full' : 'Join'} ${cup.name} by ${cup.host}`);
  }

  #bridge() {
    const bridge = site.__nswsCup;
    if (!bridge) throw new Error('The game is still loading.');
    return bridge;
  }

  async host(settings: HostSettings) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const pool = settings.pool;
      if (!pool.shorts && !pool.main.length && !pool.community.length) throw new Error('Pick at least one set of maps.');
      const cup = this.#bridge();
      const sv = cup.services();
      const library = this.#controller.native?.trackLibrary;
      if (!library) throw new Error('The game is still loading. Try again in a moment.');
      // The room opens on a map from the cup's own pool; the cup picks every map after that.
      site.__nswsCupPool = pool;
      const maps: (() => Promise<{ trackData: TrackData; trackMetadata: unknown }>)[] = [];
      library.forEachTrack((_id, _meta, category, _env, load) => {
        if (category !== 'custom') maps.push(load as () => Promise<{ trackData: TrackData; trackMetadata: unknown }>);
      });
      if (!maps.length) throw new Error('The tracks are still loading. Try again in a moment.');
      this.#say('Opening the room…');
      const loaded = await maps[Math.floor(Math.random() * maps.length)]();
      if (!loaded?.trackData?.hasStartingPoint?.()) throw new Error("That map couldn't be loaded. Try again.");
      const start = { meta: loaded.trackMetadata, data: loaded.trackData };
      this.#say('');
      this.#chatSecret = randomHex(16);
      this.#reclaim = randomHex(16);
      const ownerKey = settings.official ? await site.__nswsOwner?.token().catch(() => null) : null;
      this.#official = !!ownerKey;
      site.__nswsCupHostOptions = { ...settings, chat: this.#chatSecret, reclaim: this.#reclaim, ownerKey };
      this.#joinCode = null;
      this.#sentStatus = '';
      const host = new cup.Host(sv.loc, sv.api, settings.max, sv.profiles);
      const sessionId = host.startNewSessionImmediate(cup.GameMode.Competitive, start.meta, start.data);
      host.requestInvite();
      this.close();
      cup.startRace(start.meta, start.data, { multiplayerConnection: host, sessionId, gameMode: cup.GameMode.Competitive });
      this.#openPanelSoon('Your cup room is open. Share the code, then set up the cup.', true);
    } catch (error) {
      this.#say(readableError(error instanceof Error ? error.message : String(error)), true);
    } finally {
      this.#busy = false;
    }
  }

  // Before connecting, say what the cup is and let the player choose to race or watch.
  async join(code: string) {
    if (this.#busy) return;
    if (!this.#root.classList.contains('open')) this.#show();
    this.#say(`Looking up ${code}…`);
    let info: CupInfo | null;
    try {
      info = await this.#info(code);
    } catch (error) {
      this.#say(JOIN_ERRORS[(error as { errorType?: string }).errorType ?? ''] ?? JOIN_ERRORS['server-connection'], true);
      return;
    }
    if (!info) {
      this.#say(NO_CUP, true);
      return;
    }
    this.#say('');
    const status = info.status;
    const card = el('div');
    const facts = el('dl', 'facts');
    const fact = (name: string, value: string) => facts.append(el('dt', undefined, name), el('dd', undefined, value));
    fact('Organizer', info.host);
    fact('Maps', poolLabel(info.pool));
    if (status) {
      fact('Format', status.format);
      fact('Now', `${PHASES[status.phase]}${status.phase === 'setup' ? '' : ` · round ${status.round}`} · ${status.racers} racing`);
    }
    const canRace = !status || status.canRace;
    const note = canRace
      ? status && status.phase !== 'setup'
        ? 'The cup is under way: you start on 0 points from the next round.'
        : 'You can take a place on the grid, or just watch.'
      : 'You can watch this cup; its grid is locked or full.';
    card.append(
      el('h3', undefined, (info.official ? '★ ' : '') + info.name),
      facts,
      el('p', 'hint', note),
    );
    const actions = el('div', 'actions');
    actions.append(button('Cancel', () => this.#closeCard(), 'small'));
    if (canRace) actions.append(button('Watch', () => this.#connect(code, info!, 'watch')), button('Race', () => this.#connect(code, info!, 'race'), 'go'));
    else actions.append(button('Watch', () => this.#connect(code, info!, 'watch'), 'go'));
    card.append(actions);
    this.#card.replaceChildren(card);
    this.#card.classList.add('open');
    (actions.lastElementChild as HTMLElement | null)?.focus();
  }

  #closeCard() {
    this.#card.classList.remove('open');
    this.#card.replaceChildren();
  }

  async #connect(code: string, info: CupInfo, intent: 'race' | 'watch') {
    if (this.#busy) return;
    this.#busy = true;
    this.#intent = intent;
    const progress = el('div');
    const text = el('p', 'status', `Joining ${info.name}…`);
    const cancel = button('Cancel', () => this.#cancelJoin?.(), 'small');
    const row = el('div', 'actions');
    row.append(cancel);
    progress.append(el('h3', undefined, info.name), text, row);
    this.#card.replaceChildren(progress);
    let client: ClientConnection | null = null;
    let cancelled = false;
    try {
      const cup = this.#bridge();
      const sv = cup.services();
      site.__nswsCupPool = info.pool;
      this.#chatSecret = null;
      site.__nswsCupJoinCode = code;
      const token = new cup.CancelToken();
      client = new cup.Client(sv.loc, sv.api, sv.profiles, sv.records);
      const joined = client;
      let stop: (error: Error) => void = () => {};
      const stopped = new Promise<never>((_, reject) => (stop = reject));
      this.#cancelJoin = () => {
        cancelled = true;
        token.cancel();
        stop(new Error('cancelled'));
      };
      const timer = window.setTimeout(() => stop(Object.assign(new Error('timeout'), { errorType: 'timeout' })), JOIN_TIMEOUT_MS);
      try {
        await Promise.race([joined.joinInvite(code, token), stopped]);
        text.textContent = 'Connected. Waiting for the next race to load…';
        const session = await Promise.race([
          new Promise<{ sessionId: number; gameMode: number; meta: unknown; data: TrackData }>((resolve, reject) => {
            const onNew: NewSession = (sessionId, gameMode, meta, data) => {
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
        window.clearTimeout(timer);
        this.#joinCode = code;
        this.#cancelJoin = null;
        this.close();
        cup.startRace(session.meta, session.data, { multiplayerConnection: joined, sessionId: session.sessionId, gameMode: session.gameMode });
        this.#openPanelSoon();
      } finally {
        window.clearTimeout(timer);
      }
    } catch (error) {
      client?.dispose();
      this.#closeCard();
      if (!cancelled) {
        const type = (error as { errorType?: string }).errorType;
        const message = error instanceof Error ? error.message : String(error);
        this.#say((type && JOIN_ERRORS[type]) || (message !== 'lost' ? readableError(message) : JOIN_ERRORS.webrtc), true);
      } else this.#say('');
    } finally {
      this.#cancelJoin = null;
      this.#busy = false;
    }
  }

  async #info(code: string) {
    const response = await fetch(site.__nswsApiBase + 'nsws/cup/info?code=' + code, { cache: 'no-store' });
    if (!response.ok) throw Object.assign(new Error('server'), { errorType: 'server-connection' });
    return ((await response.json()) as { cup: CupInfo | null }).cup;
  }

  // Back to the main menu (which closes this page's side of the room), then the message.
  leave(message: string, delay = 0) {
    const connection = this.#controller.connection;
    if (!connection) return;
    window.setTimeout(() => {
      if (this.#controller.connection !== connection) return;
      this.#controller.requestPanel(false);
      site.__nswsCup?.toMenu();
      if (message) window.setTimeout(() => site.__nswsMessageBox?.show(message, 'Ok', null), 600);
    }, delay);
  }

  // A new cup in the organizer's room, under the room's name as the proxy filtered it.
  async newCup() {
    const code = this.activeCode();
    if (!code || this.#controller.state || !this.#controller.isHost) return;
    const info = await this.#info(code).catch(() => null);
    if (this.activeCode() !== code || this.#controller.state) return;
    const nick = this.#profileName();
    this.#controller.create(info?.name || (nick ? `${nick}'s cup` : 'Cup'));
  }

  // The organizer's page tells the proxy what its cup is doing (for the list and join cards); only
  // when it changes, and not more than every few seconds.
  #reportStatus() {
    const c = this.#controller,
      s = c.state;
    const connection = c.connection as unknown as HostConnection | null;
    if (!c.isHost || !s || !connection?.reportCupStatus) return;
    const m = Cup.currentMatch(s);
    const rules = rulesFor(s);
    const racers = s.phase === 'registration' ? s.roster.length : Cup.occupiedSlots(s);
    const status: CupStatus = {
      phase: s.phase === 'registration' ? 'setup' : s.phase === 'complete' ? 'done' : s.phase === 'between-rounds' ? 'break' : 'racing',
      round: m ? m.rounds + (s.runtime ? 1 : 0) : 0,
      racers,
      canRace: racers < Cup.MAX_RACERS && (rosterOpen(s) || (rules.allowRacerChanges && !rules.knockout && s.phase !== 'complete')),
      format: (s.preset?.name ?? 'Custom').slice(0, 24),
    };
    const key = JSON.stringify(status);
    if (key === this.#sentStatus) return;
    this.#sentStatus = key;
    connection.reportCupStatus(status);
  }

  // The race (and PolyCup's view of it) only exists a moment after startRace.
  #openPanelSoon(message = '', create = false) {
    const started = Date.now();
    let creating = false,
      tries = 0,
      trying = false;
    const intent = create ? 'race' : this.#intent;
    const timer = window.setInterval(() => {
      const code = this.activeCode();
      const c = this.#controller;
      if (c.connection && c.game && (!create || code)) {
        if (creating) return;
        if (create && !c.state) {
          creating = true;
          this.newCup()
            .catch((error) => c.fail(error))
            .finally(() => {
              window.clearInterval(timer);
              c.requestPanel(true, message);
            });
          return;
        }
        if (!create && intent === 'race') {
          // Racing means taking a place once the organizer has greeted this page (a few tries).
          const joined = !!c.state && c.selfId !== null && Cup.player(c.state, c.selfId) && !c.state.withdrawn?.includes(c.selfId);
          if (!joined && Date.now() - started < 20000) {
            if (trying || !c.state || c.selfId === null || !c.greeted) return;
            const rules = rulesFor(c.state);
            if (rosterOpen(c.state) || (rules.allowRacerChanges && !rules.knockout && c.state.phase !== 'complete')) {
              if (tries++ < 3) {
                trying = true;
                c.requestPanel(true, message);
                Promise.resolve(c.action('join'))
                  .catch((error) => tries >= 3 && c.fail(error))
                  .finally(() => (trying = false));
                return;
              }
            }
          }
        }
        window.clearInterval(timer);
        c.requestPanel(true, message);
      } else if (Date.now() - started > 15000) {
        // The room never got a code (or the race never started): open the panel anyway, which says why.
        window.clearInterval(timer);
        if (c.connection) c.requestPanel(true);
      }
    }, 200);
  }
}
