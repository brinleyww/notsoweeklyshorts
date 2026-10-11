import type { RaceRecord, SessionRecord } from './types.ts';
import type { InputVisualizer, LibraryTrack } from './game-types.ts';
import type { CupState } from './types.ts';
import type { Controller } from './controller.ts';
import { clock, downtimeLabel, roundClock } from './race-status.ts';
import { ConfirmDialog } from './confirm.ts';
import { roundStartCue } from './countdown.ts';
import * as Cup from './cup.ts';
import { element as h, uiScale } from './dom.ts';
import { banTurn, banEntries, isBanned, picksOpen, rosterOpen } from './draft.ts';
import { isEditing } from './held-inputs.ts';
import { presetSummary } from './preset-summary.ts';
import { rankingPositions, animateRanking } from './ranking-motion.ts';
import { ChatUI } from './chat-ui.ts';
import { PresetEditor } from './preset-ui.ts';
import { poolAllows, rulesFor, type TrackCategory } from './presets.ts';
import { inputControls } from './inputs.ts';
import { CupInvite } from './invite.ts';
import { countryFlag, lobbyPanel } from './lobby.ts';
import { RestartHint } from './restart-hint.ts';
import { resultRows, resultsImage } from './results.ts';
import { reviewPanel } from './review-ui.ts';
import { PlayerMenu } from './player-menu.ts';
import { recordTrack, sessionRecord, standings } from './standings.ts';
import { formatGap, formatTime as time } from './time.ts';
import { CupToolbar } from './toolbar.ts';
import css from './world-cup.css';

// Not So Weekly Shorts: long enough for the organizer to start a rematch from the podium.
const PODIUM_MS = 30000;
const HOST_LEAVES_AFTER_MS = 3000;

// Not So Weekly Shorts: these keys are set in the game's Settings (Competitions) or the Keys list.
type SiteKey = 'scoreboard' | 'spectatePrevious' | 'spectateNext';
const siteKeys = () =>
  (
    window as unknown as {
      __nswsCupKeys?: Record<SiteKey, () => string> & {
        matches(event: KeyboardEvent, binding: string): boolean;
        format(binding: string): string;
      };
    }
  ).__nswsCupKeys;
const defaultKeys: Record<SiteKey, string> = {
  scoreboard: 'Tab',
  spectatePrevious: 'BracketLeft',
  spectateNext: 'BracketRight',
};
const siteKey = (id: SiteKey) => siteKeys()?.[id]() ?? defaultKeys[id];
const keyIs = (event: KeyboardEvent, id: SiteKey) =>
  siteKeys()?.matches(event, siteKey(id)) ?? event.code === defaultKeys[id];
const keyLabel = (id: SiteKey) => siteKeys()?.format(siteKey(id)) ?? siteKey(id);
const names = {
  registration: 'Registration',
  loading: 'Preparing round',
  warmup: 'Warmup',
  countdown: 'Get ready',
  racing: 'Live round',
  'between-rounds': 'Round results',
  complete: 'Cup results',
};
export class CupUI {
  #chatUI: ChatUI;
  get panelOpen() {
    return this.#open;
  }
  chatHotkey(event: KeyboardEvent) {
    this.#chatUI.hotkey(event);
  }
  #recordCueScope = '';
  #recordCues = new Map<number, number>();
  #presetEditor = new PresetEditor(this);
  #lobbyStart: HTMLButtonElement | null = null;
  setLobbyStart(button: HTMLButtonElement) {
    this.#lobbyStart = button;
  }
  #startControls() {
    const button = this.#lobbyStart;
    if (!button) return null;
    const start = h('div', undefined, 'setup-start');
    const note = h('small', button.title, 'setup-start-note');
    note.id = 'setup-start-note';
    note.hidden = !button.disabled || !button.title;
    button.setAttribute('aria-describedby', note.id);
    start.append(note, button);
    return start;
  }
  get presetDirty() {
    return this.#presetEditor.dirty;
  }
  presetPanel() {
    return this.#presetEditor.render();
  }
  redraw() {
    this.#signature = '';
    this.render();
  }
  #pendingButtons = new Map<string, string>();
  get c() {
    return this.#c;
  }
  get editingPick() {
    return this.#editingPick;
  }

  #c: Controller;
  #open: boolean = false;
  #signature: string = '';
  #restartHint: RestartHint = new RestartHint();
  #trackCategory: string = 'official';
  #trackQuery: string = '';
  #carThumbnails: Map<string, Promise<string | null>> = new Map();
  #playerThumbnails: Map<number, Promise<string | null>> = new Map();
  #shadow: ShadowRoot;
  #panel: HTMLElement;
  #hud: HTMLElement;
  #povHud: HTMLElement;
  #povRecordHud: HTMLElement;
  #invite: CupInvite;
  #notice: HTMLElement;
  #startCue: HTMLElement;
  #roundTimer: HTMLElement;
  #downtime: HTMLElement;
  #practiceHud: HTMLElement;
  #finishCue: HTMLElement;
  #viewerBadge = h('div', undefined, 'viewer-count');
  #inputHud: HTMLElement;
  #inputView: InputVisualizer | undefined;
  #inputStatus: HTMLElement;
  #inputSignature: string = '';
  #lastInputMask: number | null | undefined;
  #toolbar: CupToolbar;
  #ghostHintCup: string | undefined;
  #noticeTimer: number = 0;
  #noticeUntil = 0;
  #noticeCupId: string | null = null;
  #seenPanelRequest: number = 0;
  #lobbyKey: string = '';
  #editingPick: boolean = false;
  #renderedView = '';
  #playerMenu: PlayerMenu;
  #membershipControls: HTMLElement | null = null;
  #rulesDialog = h('dialog', undefined, 'rules-dialog');
  #resultControls: HTMLElement | null = null;
  #body: HTMLElement = h('div');
  #startCueValue: string | null = null;
  #finishKey: string | null = null;
  #othersSeen = -1;
  #aloneNotice = false;
  #finishTimer: number = 0;
  // Not So Weekly Shorts: in-page confirmations, cup moments (notes, finishes, records) and the
  // organizer's race controls.
  #confirm: ConfirmDialog;
  #banner = h('div', undefined, 'finish-banner');
  #bannerTimer = 0;
  #moments = { cup: '', audit: '', finish: '', round: '', error: '', photo: '', cue: '', records: '' };
  #matchPoint = new Set<string>();
  #lastLeader: number | null | undefined;

  constructor(controller: Controller) {
    this.#c = controller;

    const root = h('div');
    root.id = 'polytrack-world-cup';
    document.body.append(root);
    this.#shadow = root.attachShadow({ mode: 'open' });
    const style = h('style', css);
    this.#shadow.append(style, this.#viewerBadge);
    this.#playerMenu = new PlayerMenu(this, this.#shadow);
    this.#viewerBadge.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg><span></span>';
    this.#viewerBadge.hidden = true;
    const menuVersion = h('div', `PolyCup ${Cup.VERSION}`, 'menu-version');
    this.#panel = h('section', undefined, 'panel');
    this.#panel.setAttribute('aria-label', 'Cup panel');
    this.#panel.tabIndex = -1;
    this.#hud = h('aside', undefined, 'hud');
    this.#povHud = h('aside', undefined, 'pov-hud');
    this.#povRecordHud = h('aside', undefined, 'pov-record-hud');
    this.#shadow.append(menuVersion, this.#panel, this.#hud, this.#povHud, this.#povRecordHud);
    this.#shadow.append(this.#rulesDialog);
    this.#rulesDialog.setAttribute('aria-label', 'Cup rules');
    this.#rulesDialog.addEventListener('click', (event) => {
      if (event.target !== this.#rulesDialog) return;
      const rect = this.#rulesDialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        this.#rulesDialog.close();
    });
    this.#invite = new CupInvite();
    this.#notice = h('div', undefined, 'notice');
    this.#notice.hidden = true;
    this.#notice.setAttribute('role', 'status');
    this.#shadow.append(this.#notice);
    this.#startCue = h('div', undefined, 'start-countdown');
    this.#startCue.hidden = true;
    this.#startCue.setAttribute('role', 'status');
    this.#startCue.setAttribute('aria-live', 'assertive');
    this.#shadow.append(this.#startCue);
    this.#roundTimer = h('aside', undefined, 'round-timer');
    this.#roundTimer.setAttribute('aria-label', 'Round time remaining');
    this.#downtime = h('div', undefined, 'downtime');
    this.#downtime.hidden = true;
    this.#downtime.setAttribute('role', 'status');
    this.#shadow.append(this.#roundTimer, this.#downtime);
    this.#practiceHud = h('aside', undefined, 'practice-hud');
    this.#practiceHud.hidden = true;
    this.#finishCue = h('section', undefined, 'finish-cue');
    this.#finishCue.hidden = true;
    this.#finishCue.setAttribute('aria-label', 'Cup winner');
    this.#finishCue.setAttribute('role', 'dialog');
    this.#shadow.append(this.#practiceHud, this.#finishCue);
    this.#inputHud = h('aside', undefined, 'polycup-inputs');
    this.#inputHud.hidden = true;
    document.body.append(this.#inputHud);
    this.#inputView = this.#c.native?.createInputVisualizer?.(this.#inputHud);
    this.#inputStatus = h('div', 'Waiting for inputs', 'input-status');
    this.#inputHud.append(this.#inputStatus);
    this.#c.onInputsChanged(() => this.updateInputOverlay());
    this.#toolbar = new CupToolbar({
      fallback: menuVersion,
      hud: this.#hud,
      povHud: this.#povHud,
      povRecordHud: this.#povRecordHud,
      inputHud: this.#inputHud,
      practiceHud: this.#practiceHud,
      notice: this.#notice,
      roundTimer: this.#roundTimer,
      banner: this.#banner,
      downtime: this.#downtime,
      toggle: () => this.togglePanel(),
      inCup: () => !!this.#c.connection,
    });
    this.#chatUI = new ChatUI(this, this.#shadow);
    this.#confirm = new ConfirmDialog(this.#shadow);
    this.#banner.hidden = true;
    this.#banner.setAttribute('role', 'status');
    this.#shadow.append(this.#banner);
    this.#c.onRetireWarning = () =>
      this.showNotice(
        `Press ${this.#c.game ? (this.#c.native?.restartKeys?.(this.#c.game)?.join(' / ') ?? 'restart') : 'restart'} again to retire from this round`,
        2000,
        true,
      );
    window.addEventListener(
      'keydown',
      (event) => {
        if (this.#playerMenu.open) {
          if (event.code === 'Escape') {
            event.preventDefault();
            this.#playerMenu.close();
          }
          event.stopImmediatePropagation();
          return;
        }
        if (this.#rulesDialog.open || this.#confirm.open) {
          event.stopImmediatePropagation();
          return;
        }
        // Not So Weekly Shorts: Escape closes the cup panel instead of reaching the game.
        if (
          event.code === 'Escape' &&
          this.#open &&
          !isEditing(event) &&
          !this.#chatUI.isOpen &&
          !document.querySelector('dialog[open]')
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.#open = false;
          this.#signature = '';
          this.render();
          return;
        }
        // Not So Weekly Shorts: the cup panel key (Tab) opens the panel, and pressing it again closes it.
        if (!keyIs(event, 'scoreboard')) return;
        if (
          !this.#c.state ||
          event.repeat ||
          isEditing(event) ||
          document.querySelector('dialog[open]')
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.togglePanel();
      },
      { capture: true },
    );
    window.addEventListener(
      'keyup',
      (event) => {
        if (this.#rulesDialog.open || this.#confirm.open || this.#playerMenu.open)
          event.stopImmediatePropagation();
      },
      { capture: true },
    );
    document.addEventListener('visibilitychange', () => this.expireNotice());
    window.addEventListener('focus', () => this.expireNotice());
    for (const type of ['keydown', 'keyup', 'keypress'] as const)
      this.#panel.addEventListener(type, (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName))
          e.stopPropagation();
      });
    // Game controls listen on window. Stop those listeners before they can cancel
    // editing, while leaving the browser's normal typing/selection/paste intact.
    for (const type of ['keydown', 'keyup', 'keypress'] as const)
      window.addEventListener(
        type,
        (e) => {
          const active = this.#shadow.activeElement;
          if (type === 'keydown' && (active as HTMLElement | null)?.dataset.presetField === 'name')
            this.#presetEditor.nameKey(e);
          if (
            (!this.#panel.hidden ||
              this.#povHud.contains(active) ||
              this.#practiceHud.contains(active) ||
              this.#finishCue.contains(active)) &&
            (['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName ?? '') ||
              (active?.tagName === 'BUTTON' && ['Space', 'Enter'].includes(e.code)))
          )
            e.stopImmediatePropagation();
        },
        { capture: true },
      );
    for (const panel of [this.#panel, this.#povHud, this.#practiceHud, this.#finishCue])
      panel.addEventListener('focusin', (e) => {
        if (
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes((e.target as HTMLElement).tagName) &&
          this.#c.game
        )
          this.#c.clearDrivingInput();
      });
    window.addEventListener('keydown', (e) => {
      if (this.#c.restartHotkey(e)) e.preventDefault();
      if (
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(this.#shadow.activeElement?.tagName ?? '') &&
        this.#c.canSpectate() &&
        (keyIs(e, 'spectatePrevious') || keyIs(e, 'spectateNext'))
      ) {
        e.preventDefault();
        this.#c.cycleWatch(keyIs(e, 'spectatePrevious') ? -1 : 1);
      }
    });
  }
  editPick(editing: boolean) {
    this.#editingPick = editing;
  }
  renderTrackChoices(parent: HTMLElement) {
    const previous = this.#body;
    this.#body = parent;
    try {
      this.trackPack({ embedded: true });
    } finally {
      this.#body = previous;
    }
  }
  button(text: string, fn: () => unknown, cls: string = '', key = `${text}:${cls}`) {
    const b = h('button', text, cls);
    b.type = 'button';
    if (text) b.setAttribute('aria-label', text);
    b.dataset.actionKey = key;
    b.addEventListener('click', async () => {
      if (
        this.#pendingButtons.has(key) ||
        (key.startsWith('track:') &&
          [...this.#pendingButtons.keys()].some((k) => k.startsWith('track:')))
      )
        return;
      try {
        const result = fn();
        if (result instanceof Promise) {
          const label = key.startsWith('track:')
            ? cls.includes('ban-choice')
              ? 'Banning…'
              : 'Loading…'
            : ((
                {
                  'Join as racer': 'Joining…',
                  'Switch to spectator': 'Leaving…',
                  Ready: 'Sending…',
                  'Start Cup': 'Preparing…',
                  'Retire this round (DNF)': 'Retiring…',
                } as Record<string, string>
              )[text] ?? 'Please wait…');
          this.#pendingButtons.set(key, label);
          this.refreshPendingButtons();
          await result;
        }
      } catch (e) {
        this.#c.fail(e);
      } finally {
        this.#pendingButtons.delete(key);
        this.#signature = '';
        this.render();
      }
    });
    return b;
  }
  refreshPendingButtons() {
    const choosingTrack = [...this.#pendingButtons.keys()].some((key) => key.startsWith('track:'));
    for (const button of this.#shadow.querySelectorAll<HTMLButtonElement>(
      'button[data-action-key]',
    )) {
      const label = this.#pendingButtons.get(button.dataset.actionKey!);
      if (label) {
        if (!button.hasAttribute('aria-busy')) button.dataset.wasDisabled = String(button.disabled);
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.dataset.pendingLabel = label;
      } else if (button.hasAttribute('aria-busy')) {
        button.disabled = button.dataset.wasDisabled === 'true';
        button.removeAttribute('aria-busy');
        delete button.dataset.pendingLabel;
        delete button.dataset.wasDisabled;
      }
      if (choosingTrack && button.dataset.actionKey!.startsWith('track:')) button.disabled = true;
    }
  }
  ghostHotkey(event: KeyboardEvent) {
    if (
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !this.#c.game ||
      this.#c.info?.disposed ||
      !this.#c.state ||
      document.querySelector('dialog[open],.settings-menu-ui') ||
      event
        .composedPath()
        .some(
          (e) =>
            e instanceof HTMLElement &&
            (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) || e.isContentEditable),
        )
    )
      return;
    this.toggleGhosts();
    event.preventDefault();
  }
  toggleGhosts() {
    if (this.#c.state && rulesFor(this.#c.state).collisions) {
      this.showNotice('Other cars always show in a collision cup', 1600);
      return;
    }
    this.#c.toggleGhosts();
    this.#ghostHintCup = this.#c.state?.id;
    this.showNotice(this.#c.ghostsHidden ? 'Other ghosts hidden' : 'Other ghosts shown', 1600);
    this.#signature = '';
    this.render();
  }
  togglePanel() {
    this.#open = !this.#open;
    this.#signature = '';
    this.render();
    if (this.#open) this.#panel.focus({ preventScroll: true });
  }
  // Not So Weekly Shorts: confirmation inside the cup layer (never the page-blocking confirm()).
  ask(text: string, ok: string, danger = false) {
    return this.#confirm.ask(text, ok, danger);
  }
  confirmed(text: string, ok: string, action: () => unknown, danger = false) {
    return async () => {
      if (await this.ask(text, ok, danger)) await action();
    };
  }
  showRules() {
    const state = this.#c.state;
    if (!state) return;
    const header = h('div', undefined, 'rules-dialog-heading');
    header.append(
      h('h2', `${state.preset?.name ?? 'Cup'} rules`),
      this.button('Close', () => this.#rulesDialog.close(), 'quiet'),
    );
    const body = h('div', undefined, 'rules-dialog-body');
    body.append(presetSummary(rulesFor(state)));
    if (!rulesFor(state).finalist)
      body.append(h('p', 'A tied lead at the target continues into another round.', 'muted'));
    this.#rulesDialog.replaceChildren(header, body);
    this.#rulesDialog.showModal();
  }
  dismissNotice() {
    clearTimeout(this.#noticeTimer);
    this.#noticeUntil = 0;
    this.#notice.hidden = true;
  }
  expireNotice() {
    if (this.#noticeUntil && (document.hidden || Date.now() >= this.#noticeUntil))
      this.dismissNotice();
  }
  showNotice(text: string, duration: number, gameplayOnly = false) {
    if (document.hidden) {
      this.dismissNotice();
      return;
    }
    if (!this.#notice.hidden && this.#notice.textContent === text && this.#noticeUntil > Date.now())
      return;
    this.dismissNotice();
    const lifetime = Math.min(3500, Math.max(800, duration));
    this.#noticeUntil = Date.now() + lifetime;
    this.#notice.classList.toggle('gameplay-notice', gameplayOnly);
    this.#notice.textContent = text;
    this.#notice.hidden = false;
    this.#noticeTimer = setTimeout(() => this.expireNotice(), lifetime);
  }
  name(id: number | null) {
    return Cup.player(this.#c.state, id)?.name ?? `Player ${id}`;
  }
  render() {
    const c = this.#c,
      s = c.state;
    // Not So Weekly Shorts: tell the organizer when everyone else has left (once they are looking at
    // the tab); the room stays open.
    const others = c.isHost && s && s.phase !== 'complete' ? c.lobby.filter((p) => !p.isSelf).length : -1;
    if (this.#othersSeen > 0 && others === 0) this.#aloneNotice = true;
    else if (others !== 0) this.#aloneNotice = false;
    this.#othersSeen = others;
    if (this.#aloneNotice && !document.hidden) {
      this.#aloneNotice = false;
      this.showNotice(
        'Everyone else left the cup. The room stays open: share the code to bring players back, or End Cup when you are done.',
        10000,
      );
    }
    if (this.#noticeCupId !== (s?.id ?? null)) {
      this.dismissNotice();
      this.#noticeCupId = s?.id ?? null;
    }
    this.expireNotice();
    this.moments();
    this.#restartHint.update(
      c.game ? c.native.hudElement(c.game) : null,
      s?.phase === 'racing' &&
        c.localPlayerId !== null &&
        Cup.activeIds(s).includes(c.localPlayerId) &&
        !Cup.roundDone(s, c.localPlayerId),
    );
    if (c.panelRequest.revision !== this.#seenPanelRequest) {
      this.#seenPanelRequest = c.panelRequest.revision;
      if (c.panelRequest.revision > 0) {
        this.#open = c.panelRequest.open;
        if (this.#open) {
          if (c.game && !c.info?.disposed) c.native?.clearInput?.(c.game);
        } else (this.#shadow.activeElement as HTMLElement | null)?.blur();
        if (c.panelRequest.message) this.showNotice(c.panelRequest.message, 2500);
      }
    }
    if (!this.#open && this.#rulesDialog.open) this.#rulesDialog.close();
    this.renderCompletion();
    const lobbyKey = JSON.stringify([s?.id, s?.draft?.stage, s?.picks?.[c.selfId ?? 0]]);
    if (lobbyKey !== this.#lobbyKey) {
      this.#lobbyKey = lobbyKey;
      this.#editingPick = false;
    }

    this.#panel.classList.toggle('lobby-panel', s?.phase === 'registration');
    this.#panel.classList.toggle('scoreboard-panel', !!s && s.phase !== 'registration');
    this.#invite.update(c.connection, this.#open);
    this.#panel.hidden = !this.#open;
    this.#notice.classList.toggle('panel-open', this.#open || this.#chatUI.isOpen);
    this.renderStartCue();
    if (
      !this.#open &&
      s?.runtime &&
      ['warmup', 'countdown', 'racing'].includes(s.phase) &&
      c.localPlayerId !== null &&
      Cup.activeIds(s).includes(c.localPlayerId) &&
      this.#ghostHintCup !== s.id
    ) {
      const keys = c.game && !c.info?.disposed ? (c.native?.ghostKeys?.(c.game) ?? []) : [];
      if (keys.length) {
        this.#ghostHintCup = s.id;
        this.showNotice(`${keys.join(' / ')} · Toggle other ghosts`, 3000, true);
      }
    }
    this.#viewerBadge.hidden =
      !c.viewerCount || this.#open || !s?.runtime || !Cup.racingIds(s).includes(c.selfId!);
    this.#viewerBadge.querySelector('span')!.textContent = String(c.viewerCount);
    this.#viewerBadge.setAttribute('aria-label', `${c.viewerCount} spectators watching you`);
    this.#viewerBadge.title = `${c.viewerCount} spectators watching you`;
    const key = JSON.stringify([
      this.#open,
      s?.id,
      s?.revision,
      c.isHost,
      c.selfId,
      c.reconnectPending,
      c.lobby.map((p) => [
        p.id,
        p.nickname,
        p.countryCode,
        c.hello.has(p.id),
        p.carStyle?.serialize(),
      ]),
      c.error,
      c.physicsWarnings,
      !!c.connection,
      c.auto,
      c.watchId,
      c.watchStatus,
      c.transferProgress,
      c.hideOtherGhosts,
      c.game && !c.info?.disposed ? c.native?.ghostKeys?.(c.game) : null,
      !!c.startingCup,
      c.preparingRandom,
      c.canSpectate(),
      c.isHost
        ? [c.review.dropped, c.review.runs.map((r) => [r.id, r.outcome, r.flag, r.reviewed])]
        : null,
    ]);
    if (key !== this.#signature) {
      const previousPositions = rankingPositions(this.#shadow);
      const lobbyScroll = [
        ...this.#shadow.querySelectorAll<HTMLElement>('.lobby-roster,.lobby-action'),
      ].map((element) => [element.className, element.scrollTop] as const);
      // Preserve a partially entered track code/name when unrelated lobby updates arrive.
      const buttonFocus = (this.#shadow.activeElement as HTMLElement | null)?.dataset.actionKey;
      const focus = (this.#shadow.activeElement as HTMLElement | null)?.dataset?.field,
        presetFocus = (this.#shadow.activeElement as HTMLElement | null)?.dataset?.presetField,
        view = `${s?.id}:${s?.phase === 'registration' ? 'setup' : s?.phase === 'complete' ? 'results' : 'race'}`,
        bodyScroll = this.#renderedView === view ? (this.#body?.scrollTop ?? 0) : 0;
      const presetInput = presetFocus ? (this.#shadow.activeElement as HTMLInputElement) : null;
      const presetSelection =
        presetInput?.type === 'text'
          ? ([presetInput.selectionStart, presetInput.selectionEnd] as const)
          : null;
      const gridScroll =
        this.#renderedView === view
          ? (this.#shadow.querySelector('.track-grid')?.scrollTop ?? 0)
          : 0;
      this.#renderedView = view;
      const inviteSelection =
        this.#shadow.activeElement === this.#invite.input
          ? ([this.#invite.input.selectionStart, this.#invite.input.selectionEnd] as const)
          : null;
      const drafts = Object.fromEntries(
        [
          ...this.#shadow.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]'),
        ].map((e) => [e.dataset.field!, e.value]),
      );
      this.#signature = key;
      this.#panel.replaceChildren();
      this.#lobbyStart = null;
      this.#resultControls = null;
      this.#membershipControls = null;
      const header = h('header');
      const title = h('div', undefined, 'header-title');
      title.append(h('h1', 'PolyCup'));
      if (s)
        title.append(
          h(
            'p',
            `${s.name} / ${s.phase === 'registration' ? ({ roster: 'Lobby', bans: 'Banning', picks: 'Picking' }[s.draft?.stage ?? 'picks'] ?? 'Picking') : s.phase === 'between-rounds' && this.#c.needsRebind.size ? 'Cup paused' : names[s.phase]}`,
          ),
        );
      const hide = this.button(
        'Hide',
        () => {
          this.#open = false;
        },
        'quiet header-hide',
      );
      header.append(title, this.#invite.element);
      if (s && s.phase !== 'registration') {
        const chat = this.button(
          'Chat',
          () => (this.#chatUI.isOpen ? this.#chatUI.close() : this.#chatUI.open()),
          'quiet header-chat',
        );
        chat.setAttribute('aria-controls', 'cup-chat-panel');
        header.append(chat);
      }
      if (s && s.phase !== 'registration') {
        const rules = this.button('Rules', () => this.showRules(), 'quiet header-rules');
        rules.setAttribute('aria-haspopup', 'dialog');
        header.append(rules);
      }
      // Not So Weekly Shorts: every key a cup uses, and rebinding them (polycup/nsws/keys.ts).
      const keysButton = this.button('Keys', () => (window as unknown as { __nswsCupKeysPanel?: () => void }).__nswsCupKeysPanel?.(), 'quiet header-rules');
      keysButton.setAttribute('aria-haspopup', 'dialog');
      header.append(keysButton, hide);
      this.#panel.append(header);
      if (c.error) {
        const error = h('p', c.error, 'error');
        error.setAttribute('role', 'alert');
        this.#panel.append(error);
      }
      if (c.physicsWarnings.length) {
        const warnings = h('div', undefined, 'physics-warnings');
        warnings.setAttribute('role', 'status');
        for (const warning of c.physicsWarnings)
          warnings.append(
            h(
              'p',
              `${this.name(warning.id)}: modified physics reported${warning.driveForce !== null && warning.driveForce !== 4000 ? ` (drive force ${warning.driveForce}; standard 4000)` : ''}.`,
              'warning',
            ),
          );
        warnings.title =
          'Client-reported physics check. This warns only; it does not block racing or prove a client is unmodified.';
        this.#panel.append(warnings);
      }
      if (!c.connection) this.welcome();
      else if (!s) this.setup();
      else {
        this.#body = h('div', undefined, 'body');
        this.#panel.append(this.#body);
        this.tournament();
        if (c.isHost) {
          this.hostControls();
          if (s.phase !== 'registration') this.lobbyPeople();
          if (c.review.runs.length || c.review.dropped) this.#body.append(reviewPanel(this));
        }
        this.#panel.append(h('div', undefined, 'panel-chat-slot'));
        if (this.#resultControls) this.#panel.append(this.#resultControls);
        if (c.isHost || this.#membershipControls) {
          const footer = h('footer');
          if (c.isHost) {
            const tools = h('div', undefined, 'cup-actions');
            const automatic = this.button(
              c.auto ? 'Auto rounds: on' : 'Auto rounds: off',
              () => c.toggleAutomaticRounds(),
              'quiet',
            );
            automatic.setAttribute('aria-pressed', String(c.auto));
            tools.append(automatic);
            if (c.review.runs.length || c.review.dropped)
              tools.append(
                this.button(
                  'Run review',
                  () => {
                    this.#shadow
                      .querySelector('.review-panel')
                      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                  },
                  'quiet',
                ),
              );
            tools.prepend(
              this.button(
                'End Cup',
                this.confirmed('End this cup and send everyone back to the menu?', 'End cup', () => c.endCup(), true),
                'quiet danger',
              ),
            );
            footer.append(tools);
          }
          if (this.#membershipControls) footer.append(this.#membershipControls);
          const startControl = this.#startControls();
          if (startControl) footer.append(startControl);
          else if (c.isHost && s.phase === 'between-rounds') {
            const next = this.button(
              'Start next round',
              async () => {
                await c.runRound();
                this.#open = false;
              },
              'primary',
            );
            next.disabled = !c.canStartRound();
            if (next.disabled)
              next.title = 'Waiting for connected racers or saved identity confirmation.';
            footer.append(next);
          }
          this.#panel.append(footer);
        }
      }
      for (const e of this.#shadow.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '[data-field]',
      ))
        if (e.dataset.field! in drafts) e.value = drafts[e.dataset.field!];
      if (buttonFocus && this.#open)
        [...this.#shadow.querySelectorAll<HTMLButtonElement>('button[data-action-key]')]
          .find((button) => button.dataset.actionKey === buttonFocus && !button.disabled)
          ?.focus({ preventScroll: true });
      if (focus && this.#open)
        this.#shadow.querySelector<HTMLElement>(`[data-field="${focus}"]`)?.focus();
      if (presetFocus && this.#open) {
        const input = this.#shadow.querySelector<HTMLInputElement>(
          `[data-preset-field="${presetFocus}"]`,
        );
        input?.focus();
        if (presetSelection && input?.type === 'text') input.setSelectionRange(...presetSelection);
      }
      if (inviteSelection && this.#open && !this.#invite.input.disabled) {
        this.#invite.input.focus();
        this.#invite.input.setSelectionRange(...inviteSelection);
      }
      this.renderHud();
      animateRanking(this.#shadow, previousPositions);
      if (this.#body) this.#body.scrollTop = bodyScroll;
      for (const [className, scroll] of lobbyScroll) {
        const region = this.#shadow.querySelector<HTMLElement>(`.${className}`);
        if (region) region.scrollTop = scroll;
      }
      const grid = this.#shadow.querySelector('.track-grid');
      if (grid) grid.scrollTop = gridScroll;
    }
    for (const badge of this.#shadow.querySelectorAll<HTMLElement>('[data-record-until]'))
      badge.hidden = Date.now() >= Number(badge.dataset.recordUntil);
    this.#playerMenu.sync();
    this.updatePings();
    const chatSlot =
      this.#open && s
        ? this.#shadow.querySelector<HTMLElement>(
            s.phase === 'registration' && innerWidth / uiScale() > 950
              ? '.lobby-chat-slot'
              : '.panel-chat-slot',
          )
        : null;
    this.#chatUI.mount(chatSlot, s?.phase === 'registration');
    this.#chatUI.render();
    const chatButton = this.#shadow.querySelector<HTMLButtonElement>('.header-chat');
    if (chatButton) {
      chatButton.setAttribute('aria-expanded', String(this.#chatUI.isOpen));
      chatButton.textContent = this.#chatUI.unread ? `Chat (${this.#chatUI.unread})` : 'Chat';
    }
    this.updateInputOverlay();
    const timer = this.#open ? null : roundClock(s, c.now());
    this.#roundTimer.classList.toggle('visible', timer !== null);
    this.#roundTimer.classList.toggle('urgent', !!timer?.urgent);
    this.#roundTimer.setAttribute('aria-hidden', String(timer === null));
    if (timer) {
      const text = `${timer.label}|${timer.text}`;
      if (this.#roundTimer.dataset.text !== text) {
        this.#roundTimer.dataset.text = text;
        this.#roundTimer.replaceChildren(h('small', timer.label), h('span', timer.text));
      }
    }
    const vote = s?.phase === 'between-rounds' ? s.trackVote : null;
    const nextIn = s?.phase === 'between-rounds' && s.nextRoundAt ? Math.ceil((s.nextRoundAt - c.now()) / 1000) : null;
    const label = this.#open
      ? ''
      : vote
        ? `${vote.mode === 'vote' ? 'Vote for the next track' : `${this.name(vote.picker)} picks the next track`} · ${Math.max(0, Math.ceil((vote.endsAt - c.now()) / 1000))}s`
        : c.preparingRandom
          ? 'Choosing next track…'
          : c.reconnectPending
            ? 'Reconnected · Racing next round'
            : s?.phase === 'between-rounds' && nextIn !== null && nextIn > 0 && !c.waitingForRacers()
              ? `Next round in ${nextIn}s`
              : downtimeLabel(
                  s?.phase,
                  c.waitingForRacers(),
                  s?.runtime?.trackId === c.info?.trackData?.getId(),
                );
    const shown = !this.#downtime.hidden;
    this.#downtime.hidden = !label;
    if (this.#downtime.textContent !== label) this.#downtime.textContent = label;
    if (!!label && !shown) this.#toolbar.sync();
    else if (label || !this.#banner.hidden) this.#toolbar.relayout();
    this.#toolbar.sync(this.#open);
    this.refreshPendingButtons();
    for (const e of this.#shadow.querySelectorAll('[data-clock]')) {
      const run = s?.runtime;
      const target = s?.phase === 'racing' ? run?.deadline : run?.startsAt;
      e.textContent = target ? clock(Math.max(0, Math.ceil((target - c.now()) / 1000))) : '';
    }
    for (const e of this.#shadow.querySelectorAll<HTMLElement>('[data-vote-clock]'))
      e.textContent = s?.trackVote ? `${Math.max(0, Math.ceil((s.trackVote.endsAt - c.now()) / 1000))}s` : '';
    this.renderHostStrip();
  }
  // Not So Weekly Shorts: things worth saying during a cup, each said once: organizer notes (void,
  // restart, skip, knockouts, failed physics checks), your finish, photo finishes, lead changes,
  // match point and finalists, and errors while the panel is closed.
  moments() {
    const c = this.#c,
      s = c.state,
      me = c.localPlayerId;
    const m = s ? Cup.currentMatch(s) : null;
    if (!s) {
      this.#moments.cup = '';
      return;
    }
    if (this.#moments.cup !== s.id) {
      this.#moments = { cup: s.id, audit: s.audit.at(-1)?.at ?? '', finish: '', round: String(m?.rounds ?? 0), error: c.error, photo: '', cue: '', records: '' };
      this.#matchPoint.clear();
      this.#lastLeader = undefined;
      return;
    }
    const fresh = s.audit.filter((a) => a.at > this.#moments.audit);
    if (fresh.length) {
      this.#moments.audit = fresh.at(-1)!.at;
      this.showNotice(fresh.at(-1)!.message, 3500);
    }
    if (c.takeAutoStopped())
      this.showNotice('Automatic rounds stopped. Open the cup panel to start the next round.', 3500);
    else if (c.error && c.error !== this.#moments.error && !this.#open) this.showNotice(c.error, 3500);
    this.#moments.error = c.error;
    const run = s.runtime;
    if (run && s.phase === 'racing' && me !== null && me in run.finishes) {
      const key = `${run.id}:${run.finishes[me]}`;
      if (this.#moments.finish !== key) {
        this.#moments.finish = key;
        this.finishBanner();
      }
    }
    if (run && s.phase === 'racing') {
      const times = Object.values(run.finishes).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1],
          key = `${run.id}:${times[i - 1]}:${times[i]}`;
        if (gap > 0 && gap < 50 && !this.#moments.photo.includes(key)) {
          this.#moments.photo += key + ';';
          const [a, b] = [times[i - 1], times[i]].map(
            (t) => this.name(Number(Object.keys(run.finishes).find((id) => run.finishes[Number(id)] === t))),
          );
          this.showNotice(`Photo finish! ${a} beat ${b} by ${(gap / 1000).toFixed(3)} s`, 3500);
        }
      }
      const award = me !== null ? run.recordAwards?.[me] : undefined;
      const recordKey = award ? `${run.id}:${award}:${run.finishes[me!]}` : '';
      if (award && this.#moments.records !== recordKey) {
        this.#moments.records = recordKey;
        if (award !== 'PB' || rulesFor(s).roundStyle !== 'time-attack') c.native?.sound?.('record');
      }
    }
    const rounds = String(m?.rounds ?? 0);
    if (m && rounds !== this.#moments.round && !run) {
      this.#moments.round = rounds;
      const rules = rulesFor(s);
      const leader = rankingLeader(s);
      if (leader !== null && this.#lastLeader !== undefined && leader !== this.#lastLeader && !m.winners.length && !rules.knockout)
        this.showNotice(`${this.name(leader)} takes the lead!`, 3000);
      this.#lastLeader = leader;
      if (!rules.knockout && !m.winners.length)
        for (const id of Cup.activeIds(s)) {
          const finalist = id in m.finalists;
          const point = !rules.finalist && m.scores[id] + rules.points[0] >= m.target;
          const key = `${id}:${finalist ? 'f' : 'p'}`;
          if ((finalist || point) && !this.#matchPoint.has(key)) {
            this.#matchPoint.add(key);
            this.showNotice(
              finalist
                ? `${this.name(id)} is a finalist: one round win takes the cup`
                : `${this.name(id)} is on match point`,
              3000,
            );
          }
        }
    }
  }
  finishBanner() {
    const c = this.#c,
      s = c.cup,
      run = s.runtime!,
      me = c.localPlayerId!;
    const rows = standings(s),
      row = rows.find((r) => r.id === me);
    if (!row) return;
    const best = Math.min(...Object.values(run.finishes));
    const gap = run.finishes[me] - best;
    const ta = rulesFor(s).roundStyle === 'time-attack';
    const parts = [
      `P${row.position}`,
      rulesFor(s).knockout ? null : row.gain ? `+${row.gain} pts` : null,
      gap > 0 ? formatGap(gap) : Object.keys(run.finishes).length > 1 ? 'Fastest' : null,
      ta ? `Best ${time(run.finishes[me])}` : null,
    ].filter(Boolean);
    this.#banner.replaceChildren(h('strong', parts.shift()!), h('span', parts.join(' · ')));
    this.#banner.hidden = false;
    this.#toolbar.sync();
    this.#banner.classList.remove('show');
    void this.#banner.offsetWidth;
    this.#banner.classList.add('show');
    c.native?.sound?.('finish');
    clearTimeout(this.#bannerTimer);
    this.#bannerTimer = window.setTimeout(() => (this.#banner.hidden = true), 4000);
  }
  // The organizer's round controls while racing, as buttons in the game's own toolbar.
  renderHostStrip() {
    const c = this.#c,
      s = c.state;
    const live = !!s && c.isHost && !!s.runtime && ['loading', 'warmup', 'countdown', 'racing'].includes(s.phase);
    const actions: { label: string; icon: string; run: () => void }[] = [];
    if (live && s!.phase === 'racing')
      actions.push({ label: 'End round', icon: 'checkmark', run: this.confirmed('Score the finishes so far and give everyone still racing a DNF?', 'End round', () => c.finishRound()) });
    if (live)
      actions.push(
        { label: 'Restart', icon: 'reset', run: this.confirmed('Restart this round from the countdown? Nobody scores the current attempt.', 'Restart round', () => c.restartRound()) },
        { label: 'Void', icon: 'cancel', run: this.confirmed('Stop this round without awarding points?', 'Void round', () => c.voidRound(), true) },
      );
    this.#toolbar.setActions(actions);
  }
  trackVoteControls() {
    const c = this.#c,
      s = c.cup,
      v = s.trackVote;
    if (!v || s.phase !== 'between-rounds') return null;
    const me = c.localPlayerId;
    const box = h('section', undefined, 'track-vote');
    const title = h('div', undefined, 'track-vote-title');
    title.append(
      h('strong', v.mode === 'vote' ? 'Vote for the next track' : me === v.picker ? 'Pick the next track' : `${this.name(v.picker)} picks the next track`),
    );
    const timer = h('span');
    timer.dataset.voteClock = '';
    title.append(timer);
    box.append(title);
    const mayVote = me !== null && Cup.activeIds(s).includes(me) && (v.mode === 'vote' || me === v.picker);
    const counts = new Map<string, number>();
    for (const choice of Object.values(v.votes)) counts.set(choice, (counts.get(choice) ?? 0) + 1);
    const list = h('div', undefined, 'track-vote-options');
    let library: LibraryTrack[] = [];
    try {
      library = c.availableTracks();
    } catch {}
    for (const option of v.options) {
      const mine = me !== null && v.votes[me] === option.id;
      const b = this.button('', () => c.action('track-vote', option.id), `track-card${mine ? ' added' : ''}`, `vote:${option.id}`);
      b.disabled = !mayVote;
      b.setAttribute('aria-label', `${mine ? 'Voted for' : 'Vote for'} ${option.name}`);
      const image = h('img');
      image.alt = '';
      const entry = library.find((t) => t.id === option.id);
      if (entry)
        Promise.resolve(entry.thumbnail)
          .then((src) => {
            if (src && image.isConnected) image.src = src;
          })
          .catch(() => {});
      image.addEventListener('error', () => (image.hidden = true));
      const text = h('span');
      text.append(h('strong', option.name));
      if (v.mode === 'vote') text.append(h('small', `${counts.get(option.id) ?? 0} vote${counts.get(option.id) === 1 ? '' : 's'}`, 'muted'));
      else if (mine) text.append(h('small', 'Your pick', 'muted'));
      b.append(image, text);
      list.append(b);
    }
    box.append(list);
    if (!mayVote && v.mode !== 'vote') box.append(h('small', 'A random one is chosen if no pick arrives in time.', 'muted'));
    return box;
  }
  welcome() {
    const content = h('div', undefined, 'body');
    content.append(
      h('h2', 'Not in a cup'),
      h('p', 'Open Competitions from the main menu to host or join one.'),
    );
    this.#panel.append(content);
  }
  updateInputOverlay() {
    const c = this.#c,
      visible =
        !!this.#inputView &&
        !this.#open &&
        !!c.state &&
        !c.info?.disposed &&
        c.canSpectate() &&
        c.watchable().length > 0;
    const mask = visible ? c.watchedInputs() : null;
    const signature = `${visible}:${mask}:${c.watchId}:${visible ? this.name(c.watchId) : ''}`;
    if (signature === this.#inputSignature) return;
    this.#inputSignature = signature;
    this.#inputHud.hidden = !visible;
    if (mask !== this.#lastInputMask) {
      this.#inputView?.update(inputControls(mask ?? 0));
      this.#inputStatus.style.visibility = mask === null ? 'visible' : 'hidden';
      this.#lastInputMask = mask;
    }
    this.#inputHud.setAttribute(
      'aria-label',
      `Reported driving inputs for ${visible ? this.name(c.watchId) : 'spectated racer'}`,
    );
    this.#inputHud.title =
      'Reported racer inputs, synchronized with the buffered POV. Not proof of manual driving.';
  }
  renderStartCue() {
    const c = this.#c,
      value = roundStartCue(
        c.state,
        c.info?.disposed ? null : (c.info?.sessionId ?? null),
        c.now(),
      );
    this.#startCue.hidden = !value || this.#open;
    if (value === this.#startCueValue) return;
    this.#startCueValue = value;
    this.#startCue.replaceChildren();
    if (!value) return;
    c.native?.sound?.(value === 'GO' ? 'go' : 'tick');
    const signal = h('div', undefined, `start-signal${value === 'GO' ? ' go' : ''}`);
    signal.append(h('span', value === 'GO' ? 'GO!' : value, 'start-number'));
    this.#startCue.append(signal);
  }
  setup() {
    const body = h('div', undefined, 'body');
    // Not So Weekly Shorts: the host's cup is created with the name picked before the room opened,
    // and an ended cup sends everyone back to the menu.
    const c = this.#c,
      failed = c.isHost && c.connection ? c.native?.inviteError?.(c.connection) : null;
    if (failed) {
      body.append(h('h2', 'The cup room couldn’t open'), h('p', failed));
      const controls = h('div', undefined, 'controls');
      controls.append(
        this.button('Try again', () => c.connection?.renewInvite(), 'primary'),
        this.button('Back to the menu', () => (window as unknown as { __nswsCupLeave?: (m: string) => void }).__nswsCupLeave?.(''), 'quiet'),
      );
      body.append(controls);
    } else body.append(h('h2', c.isHost ? 'Setting up the cup…' : 'Waiting for the organizer…'));
    this.#panel.append(body);
  }
  lobbyPeople() {
    const c = this.#c,
      s = c.cup;
    const people = c.lobby.filter(
      (p) => !Cup.player(s, p.id) || s.withdrawn?.includes(p.id) || s.pendingRacers?.includes(p.id),
    );
    const missing = s.roster.filter((p) => !c.lobby.some((peer) => peer.id === p.id));
    if (!people.length && !missing.length) return;
    const section = h('section', undefined, 'cup-people');
    section.append(h('h3', 'Spectators & returning racers'));
    const list = h('div', undefined, 'cup-people-list');
    for (const p of [...people.map((p) => ({ id: p.id, name: p.nickname })), ...missing]) {
      const row = h('div', undefined, 'cup-person');
      row.append(this.racerName(p.id, p.name, true, true));
      if (missing.some((person) => person.id === p.id))
        row.append(h('small', 'Disconnected', 'muted'));
      else if (s.pendingRacers?.includes(p.id))
        row.append(h('small', 'Joining next round', 'muted'));
      list.append(row);
    }
    section.append(list);
    this.#body.append(section);
  }
  country(id: number | null) {
    return (
      this.#c.lobby.find((p) => p.id === id)?.countryCode ??
      this.#c.state?.roster.find((p) => p.id === id)?.countryCode
    );
  }
  flag(code: unknown) {
    const url = countryFlag(code);
    if (!url) return null;
    const image = h('img', undefined, 'country-flag');
    image.src = url;
    image.alt = String(code).toUpperCase();
    image.title = 'Player’s selected country';
    image.addEventListener('error', () => {
      image.hidden = true;
    });
    return image;
  }
  optionName(id: number, name = this.name(id)) {
    const code = this.country(id);
    return countryFlag(code)
      ? `${[...code!.toUpperCase()].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join('')} ${name}`
      : name;
  }
  playerLabel(id: number, name = this.name(id), showFlag = false) {
    const label = h('span', undefined, 'player-label');
    const flag = showFlag ? this.flag(this.country(id)) : null;
    if (flag) label.append(flag);
    label.append(h('span', name));
    return label;
  }
  playerTools(id: number) {
    const tools = h('div', undefined, 'player-tools');
    const ping = h('span', undefined, 'player-ping');
    ping.dataset.pingPlayer = String(id);
    const bars = h('span', undefined, 'connection-bars');
    bars.setAttribute('aria-hidden', 'true');
    bars.append(h('i'), h('i'), h('i'));
    ping.append(bars, h('small', '—', 'ping-value'));
    tools.append(ping);
    return tools;
  }
  updatePings() {
    for (const element of this.#shadow.querySelectorAll<HTMLElement>('[data-ping-player]')) {
      const ping = this.#c.ping(Number(element.dataset.pingPlayer));
      const quality =
        ping === null ? 'unknown' : ping <= 100 ? 'good' : ping <= 200 ? 'fair' : 'poor';
      element.dataset.quality = quality;
      const label = ping === null ? 'Ping unavailable' : `${ping} milliseconds to the host`;
      element.setAttribute('aria-label', label);
      element.title = label;
      element.querySelector('.ping-value')!.textContent = ping === null ? '—' : `${ping} ms`;
    }
  }
  racerName(id: number, name: string, showFlag = false, actions = false) {
    const group = h('span', undefined, 'racer-name grow'),
      image = h('img', undefined, 'car-skin');
    group.title = name;
    image.alt = '';
    image.title = `${name}'s car`;
    image.draggable = false;
    image.src = new URL('images/car_thumbnail_placeholder.png', document.baseURI).href;
    this.thumbnail(id).then((url) => {
      if (url && image.isConnected) image.src = url;
    });
    group.append(image);
    const flag = showFlag ? this.flag(this.country(id)) : null;
    if (flag) group.append(flag);
    group.append(h('span', name));
    if (actions && this.#c.isHost) {
      const button = this.button(
        '',
        () => this.#playerMenu.show(id, button),
        'player-actions-toggle',
        `player-menu:${id}`,
      );
      button.innerHTML =
        '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg>';
      button.setAttribute('aria-label', `Manage ${name}`);
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', 'player-actions-menu');
      button.setAttribute('aria-expanded', 'false');
      button.dataset.playerMenuId = String(id);
      button.title = 'Player actions';
      group.prepend(button);
    }
    return group;
  }
  async thumbnail(id: number) {
    const style = this.#c.lobby.find((p) => p.id === id)?.carStyle;
    if (style) {
      const key = style.serialize();
      if (!this.#carThumbnails.has(key)) {
        if (this.#carThumbnails.size >= 64)
          this.#carThumbnails.delete(this.#carThumbnails.keys().next().value!);
        this.#carThumbnails.set(
          key,
          this.#c.native.carThumbnail(style).catch(() => null),
        );
      }
      this.#playerThumbnails.set(id, this.#carThumbnails.get(key)!);
    }
    return this.#playerThumbnails.get(id) ?? null;
  }
  joinControls() {
    const s = this.#c.cup,
      box = h('div', undefined, 'controls'),
      joined = !!Cup.player(s, this.#c.localPlayerId);
    if (!rosterOpen(s)) return box;
    const full = !joined && s.roster.length >= Cup.MAX_RACERS;
    const join = this.button(
      joined ? 'Switch to spectator' : full ? 'Grid full · spectating' : 'Join as racer',
      () => this.#c.action(joined ? 'leave' : 'join'),
      'primary',
    );
    join.disabled = full;
    box.append(join);
    return box;
  }
  trackPack({ embedded = false } = {}) {
    const s = this.#c.cup,
      c = this.#c,
      joined = !!Cup.player(s, c.localPlayerId);
    const banning = s.draft?.stage === 'bans' && s.phase === 'registration';
    const mayChoose = banning ? banTurn(s) === c.localPlayerId : joined && picksOpen(s);
    if (!embedded)
      this.#body.append(
        h(
          'h2',
          banning
            ? banTurn(s) === c.localPlayerId
              ? 'Your ban'
              : `${this.optionName(banTurn(s)!)}’s ban`
            : s.phase === 'registration'
              ? 'Track picks'
              : 'Track order',
        ),
      );
    if (s.draft && !embedded) {
      const bans = h('div', undefined, 'ban-list');
      for (const { racerId: id, track: t } of banEntries(s)) {
        const item = h('span', `× ${t.name}`, 'draft-ban');
        item.title = `Banned by ${this.name(Number(id))}`;
        bans.append(item);
      }
      this.#body.append(bans);
      if (s.draft.stage === 'roster') {
        this.#body.append(h('p', 'Waiting for the organizer to begin bans.', 'muted'));
        return;
      }
    }
    if (!embedded)
      for (const t of s.tracks) {
        const row = h('div', undefined, 'row');
        row.append(
          h('strong', t.name, 'grow'),
          h(
            'small',
            s.roster
              .filter((p) => Cup.chosenTracks(s, p.id).includes(t.id))
              .map((p) => this.optionName(p.id, p.name))
              .join(', '),
            'muted',
          ),
        );
        this.#body.append(row);
      }
    if (!embedded && s.phase === 'registration' && !joined) this.#body.append(this.joinControls());
    if (s.phase === 'registration' && (joined || banning)) {
      const grid = h('div', undefined, 'track-grid');
      let entries: LibraryTrack[] | undefined;
      try {
        entries = c.allowedTracks();
      } catch (error) {
        grid.append(h('p', error instanceof Error ? error.message : String(error), 'muted'));
      }
      // Not So Weekly Shorts: a tab for each collection in the host's map pool.
      const pool = (['official', 'community', 'custom'] as const).filter((category) =>
        category === 'custom'
          ? !banning && poolAllows(rulesFor(s), category)
          : !entries || entries.some((t) => t.category === category),
      );
      if (!pool.includes(this.#trackCategory as TrackCategory))
        this.#trackCategory = pool[0] ?? 'official';
      if (c.transferProgress) this.#body.append(h('p', c.transferProgress, 'upload-status'));
      const tabs = h('div', undefined, 'track-tabs');
      tabs.setAttribute('aria-label', 'Track collections');
      for (const [category, text] of [
        ['official', 'Tracks'],
        ['community', 'Community tracks'],
        ['custom', 'Custom tracks'],
      ]) {
        if (!pool.includes(category as TrackCategory)) continue;
        const button = this.button(
          text,
          () => {
            this.#trackCategory = category;
          },
          category === this.#trackCategory ? 'selected' : 'quiet',
        );
        button.setAttribute('aria-pressed', String(category === this.#trackCategory));
        tabs.append(button);
      }
      this.#body.append(tabs);
      const search = h('input');
      search.type = 'search';
      search.placeholder = 'Search tracks';
      search.value = this.#trackQuery;
      search.setAttribute('aria-label', 'Search tracks');
      search.dataset.field = 'track-search';
      search.className = 'track-search';
      const draw = () => {
        if (!entries) return;
        grid.replaceChildren();
        const tracks = entries.filter(
          (t) =>
            t.category === this.#trackCategory &&
            `${t.name} ${t.author ?? ''}`
              .toLocaleLowerCase()
              .includes(this.#trackQuery.toLocaleLowerCase()),
        );
        if (!tracks.length)
          grid.append(
            h(
              'p',
              this.#trackCategory === 'custom' && !this.#trackQuery
                ? 'No saved custom tracks.'
                : 'No matching tracks.',
              'muted',
            ),
          );
        for (const track of tracks) {
          const selected =
            c.localPlayerId !== null && Cup.chosenTracks(s, c.localPlayerId).includes(track.id);
          const banned = isBanned(s, track.id);
          const button = this.button(
            '',
            async () => {
              button.disabled = true;
              try {
                if (banning) await c.action('ban', track.id);
                else await c.addLibraryTrack(track);
              } finally {
                if (button.isConnected) button.disabled = false;
              }
            },
            `track-card${selected ? ' added' : ''}${banned ? ' banned' : ''}${banning ? ' ban-choice' : ''}`,
            `track:${track.id}`,
          );
          button.disabled = !mayChoose || banned || selected || !!c.pendingUpload;
          button.setAttribute(
            'aria-label',
            `${banned ? 'Banned' : selected ? 'Selected' : banning ? 'Ban' : 'Choose'} ${track.name}`,
          );
          const image = h('img');
          image.alt = '';
          image.loading = 'lazy';
          image.draggable = false;
          Promise.resolve(track.thumbnail)
            .then((src) => {
              if (src && image.isConnected) image.src = src;
            })
            .catch(() => {});
          image.addEventListener('error', () => {
            image.hidden = true;
          });
          const text = h('span');
          text.append(h('strong', track.name));
          if (banned || selected || track.author)
            text.append(
              h(
                'small',
                banned ? 'Banned' : selected ? 'Your pick' : track.author,
                banned ? 'ban-label' : 'muted',
              ),
            );
          button.append(image, text);
          grid.append(button);
        }
      };
      search.addEventListener('input', () => {
        this.#trackQuery = search.value;
        draw();
      });
      this.#body.append(search, grid);
      draw();
      if (banning || !mayChoose || !rulesFor(s).pool.includes('custom')) return;
      const advanced = h('section', undefined, 'track-code');
      advanced.append(h('h3', 'Paste a share code instead'));
      const label = h('label', 'PolyTrack share code'),
        code = h('textarea');
      code.rows = 4;
      code.dataset.field = 'track-code';
      code.spellcheck = false;
      label.append(code);
      advanced.append(
        label,
        this.button(
          'Choose this track',
          async () => {
            await c.importTrack(code.value);
            code.value = '';
          },
          'primary',
        ),
      );
      this.#body.append(advanced);
    }
  }
  tournament() {
    const c = this.#c,
      s = c.cup;
    if (c.reconnectPending) this.#body.append(h('p', 'Reconnected · Racing next round', 'muted'));
    if (s.phase === 'between-rounds' && this.#c.needsRebind.size) {
      this.recovery();
      return;
    }
    if (s.phase === 'complete') {
      this.results();
      return;
    }
    if (s.phase === 'registration') {
      this.#body.append(lobbyPanel(this));
    } else {
      if (rulesFor(s).allowRacerChanges && c.localPlayerId !== null) {
        const queued = s.pendingRacers?.includes(c.localPlayerId),
          joined = Cup.activeIds(s).includes(c.localPlayerId);
        const membership = h('div', undefined, 'membership-controls');
        const button = this.button(
          queued ? 'Cancel join' : joined ? 'Switch to spectator' : 'Join as racer',
          () => c.action(queued || joined ? 'leave' : 'join'),
          'primary',
        );
        button.disabled = !joined && !queued && Cup.occupiedSlots(s) >= Cup.MAX_RACERS;
        button.title = queued
          ? 'Cancel joining the next round'
          : joined
            ? 'Leave the racer roster and retire this round'
            : 'Join the next round; new racers start at zero points';
        if (queued) membership.append(h('small', 'Joining next round', 'muted'));
        membership.append(button);
        this.#membershipControls = membership;
      }
      this.#body.append(this.scoreboard(true));
      const vote = this.trackVoteControls();
      if (vote) this.#body.append(vote);
      const skip = this.skipControl();
      if (skip) this.#body.append(skip);
      if (!c.isHost && !rulesFor(s).collisions) {
        const ghosts = this.button(c.ghostsHidden ? 'Show other cars' : 'Hide other cars', () => this.toggleGhosts(), 'quiet');
        ghosts.setAttribute('aria-pressed', String(c.ghostsHidden));
        this.#body.append(ghosts);
      }
      if (s.runtime) {
        const roundBar = h('div', undefined, 'scoreboard-meta');
        const status = h(
          'p',
          `Round ${s.runtime.round} · ${s.tracks.find((t) => t.id === s.runtime!.trackId)?.name} `,
          'scoreboard-round',
        );
        const clock = h('strong');
        clock.dataset.clock = '';
        status.append(clock);
        roundBar.append(status);
        this.#body.append(roundBar);
        if (s.phase === 'loading')
          this.#body.append(
            h('p', `Loaded: ${s.runtime.ready.length}/${Cup.activeIds(s).length}`, 'muted'),
          );
        if (s.phase === 'warmup') this.#body.append(this.practiceControls());
        if (
          s.phase === 'racing' &&
          c.localPlayerId !== null &&
          Cup.activeIds(s).includes(c.localPlayerId) &&
          !Cup.roundDone(s, c.localPlayerId)
        )
          roundBar.append(
            this.button(
              'Retire this round (DNF)',
              async () => {
                await c.action('dnf', s.runtime!.id);
                this.#open = false;
              },
              'quiet',
            ),
          );
        if (Cup.roundDone(s, c.localPlayerId) && !c.canSpectate() && c.watchable().length)
          roundBar.append(
            this.button('Watch remaining racers', () => {
              c.watchRemaining();
              this.#open = false;
            }),
          );
      }
    }
  }
  recovery() {
    const c = this.#c;
    this.#body.append(h('h2', 'Cup paused'));
    if (!c.isHost) {
      this.#body.append(
        h('p', 'Waiting for the organizer to reconnect racers and restart the round.'),
      );
      return;
    }
    this.#body.append(h('p', 'Click each saved racer’s name to confirm their lobby identity.'));
    for (const racer of c.recoveryRacers()) {
      const row = h('div', undefined, 'row');
      row.append(this.racerName(racer.id, racer.name, true, true));
      this.#body.append(row);
    }
  }
  hostControls() {
    const c = this.#c,
      s = c.cup;
    const controls = h('div', undefined, 'controls');
    if (s.phase === 'racing')
      controls.append(
        this.button(
          'End round',
          this.confirmed('Score the finishes so far and give everyone still racing a DNF?', 'End round', () => c.finishRound()),
          'quiet',
        ),
      );
    // Not So Weekly Shorts: replay the current round from the start; nobody scores the stopped attempt.
    if (s.runtime)
      controls.append(
        this.button(
          'Restart round',
          this.confirmed('Restart this round from the countdown? Nobody scores the current attempt.', 'Restart round', () => c.restartRound()),
          'quiet',
        ),
      );
    if (s.runtime)
      controls.append(
        this.button(
          'Void round',
          this.confirmed('Stop this round without awarding points?', 'Void round', () => c.voidRound(), true),
          'quiet',
        ),
      );
    if (['between-rounds', 'complete'].includes(s.phase)) {
      const undo = this.button(
        'Undo last scored round',
        this.confirmed('Undo the last scored round? Its points are taken back.', 'Undo round', () => c.change(Cup.undoRound)),
        'quiet',
      );
      undo.disabled = s.history.at(-1)?.matchIndex !== s.matchIndex;
      controls.append(undo);
    }
    if (Cup.currentTrackVisit(s))
      controls.append(
        this.button(
          'Remove current track',
          this.confirmed(
            'Remove this track for the rest of the cup and undo every scored round from this visit? Earlier visits keep their scores.',
            'Remove track',
            () => c.removeTrack(),
            true,
          ),
          'quiet',
        ),
      );
    if (controls.childElementCount || s.phase !== 'registration') {
      const section = h('section', undefined, 'host-round-controls');
      const heading = h('div', undefined, 'section-heading');
      heading.append(h('h3', 'Round controls'));
      if (!rulesFor(s).collisions) {
        const ghosts = this.button(
          c.ghostsHidden ? 'Show other cars' : 'Hide other cars',
          () => this.toggleGhosts(),
          'quiet',
        );
        ghosts.setAttribute('aria-pressed', String(c.ghostsHidden));
        heading.append(ghosts);
      }
      section.append(heading, controls);
      this.#body.append(section);
    }

  }
  scoreboard(personalBests = false) {
    const s = this.#c.cup,
      board = h('div', undefined, 'scoreboard'),
      rows = standings(s);
    board.classList.toggle('full-scoreboard', personalBests);
    const match = Cup.currentMatch(s),
      run = s.runtime ?? match.roundsLog.at(-1);
    const scope = `${s.id}:${s.matchIndex}:${run?.round}:${run?.trackId}`;
    if (scope !== this.#recordCueScope) {
      this.#recordCueScope = scope;
      this.#recordCues.clear();
    }
    const winners = rows.filter((r) => r.winner),
      racers = rows.filter((r) => !r.winner);
    if (winners.length) {
      const podium = h('div', undefined, 'winner-strip');
      podium.append(h('small', 'CUP WINNER'));
      for (const r of winners) podium.append(this.racerName(r.id, this.name(r.id)));
      board.append(podium);
    }
    const heading = h('div', undefined, 'ranking-heading');
    const rules = rulesFor(s);
    heading.append(h('strong', s.phase === 'racing' ? 'ROUND RANKING' : 'CUP STANDINGS'));
    // Not So Weekly Shorts: what it takes to win, always in view.
    heading.append(
      h(
        'small',
        rules.knockout
          ? `Knockout · ${Cup.activeIds(s).length} left`
          : rules.finalist
            ? `Finalist at ${match.target} · win a round`
            : `First to ${match.target}`,
        'ranking-goal',
      ),
    );
    board.append(heading);
    // Not So Weekly Shorts: a big field shows the top 8 and your own row on the race HUD (the panel
    // has everyone).
    const compact = !personalBests && racers.length > 10;
    let hiddenRows = 0;
    for (const [i, r] of racers.entries()) {
      if (compact && i >= 8 && r.id !== this.#c.localPlayerId) {
        hiddenRows++;
        continue;
      }
      const row = h(
        'div',
        undefined,
        `score-row${r.id === this.#c.localPlayerId ? ' highlighted self' : ''}${r.finalist ? ' finalist' : ''}${r.out ? ' out' : ''}${r.verifying ? ' verifying' : ''}`,
      );
      const name = this.racerName(r.id, this.name(r.id), false, personalBests);
      name.title = this.name(r.id);
      const movement = h(
        'small',
        r.movement > 0 ? `▲${r.movement}` : r.movement < 0 ? `▼${-r.movement}` : '',
        r.movement < 0 ? 'movement down' : 'movement up',
      );
      movement.title =
        s.phase === 'racing'
          ? 'Places gained or lost at the latest race update'
          : 'Places gained or lost in Cup standings this round';
      const points = h('span', undefined, 'points');
      const total = h('strong', r.out ? 'OUT' : rules.knockout ? 'IN' : r.finalist ? 'F' : String(r.score));
      total.title = r.out
        ? 'Knocked out'
        : rules.knockout
          ? 'Still in the cup'
          : r.finalist
            ? 'Finalist: win an outright round to take the cup'
            : `${r.score} of ${Cup.currentMatch(s).target} points`;
      const gain = h(
        'small',
        r.gain ? `+${r.gain}` : '',
        `point-gain${r.provisional ? ' projected' : ''}`,
      );
      gain.title = r.provisional
        ? 'Provisional points if these finish positions hold'
        : 'Points gained this round';
      points.append(total, gain);
      const reading = r.frames ?? r.splitFrames;
      const showGap =
        s.phase === 'racing' ? i > 0 && r.delta !== null : r.delta !== null && r.delta > 0;
      const result = r.dnf
        ? 'DNF'
        : reading === undefined
          ? '—'
          : showGap
            ? formatGap(r.delta ?? 0)
            : time(reading);
      const timing = h('span', r.verifying ? `${result} …` : result, 'time');
      timing.title = r.verifying
        ? 'The organizer is checking this finish'
        : r.dnf
        ? 'Retired this round'
        : r.frames !== undefined
          ? `Finish: ${time(r.frames)}`
          : r.splitFrames !== undefined
            ? `Checkpoint ${r.checkpoint + 1}: ${time(r.splitFrames)} · ${formatGap(r.delta ?? 0)}`
            : 'No checkpoint reached';
      const identity = h('div', undefined, 'score-identity');
      identity.append(name);
      if (personalBests) {
        row.classList.add('with-pb');
        const car = name.querySelector('.car-skin');
        if (car) identity.prepend(car);
        const actions = name.querySelector('.player-actions-toggle');
        if (actions) identity.append(actions);
        const track = recordTrack(s);
        const pb = track ? s.records[track]?.pbs[r.id] : null;
        const best = !track
          ? '—'
          : !pb
            ? 'Loading…'
            : pb.frames
              ? time(pb.frames)
              : pb.status === 'unavailable'
                ? 'Unavailable'
                : 'No record';
        const record = h('small', undefined, 'score-pb');
        record.title = 'Overall personal best for this track';
        record.append(h('span', 'PB'), h('span', best));
        identity.append(record);
      }
      row.append(h('strong', r.position, 'position'), identity, movement, points, timing);
      const entry = h('div', undefined, 'score-entry');
      entry.dataset.rankingRow = `${personalBests ? 'panel' : 'hud'}:${scope}:${r.id}`;
      entry.dataset.rankingOrder = String(i);
      entry.append(row);
      const award = run?.recordAwards?.[r.id];
      if (award) {
        if (!this.#recordCues.has(r.id)) this.#recordCues.set(r.id, Date.now());
        const since = this.#recordCues.get(r.id)!;
        if (Date.now() < since + 6000) {
          const badge = h('small', award, `record-badge record-badge-${award.toLowerCase()}`);
          badge.title =
            award === 'WR'
              ? 'New world-record time'
              : award === 'TR'
                ? 'New Cup track record'
                : 'New personal best';
          badge.dataset.recordUntil = String(since + 6000);
          badge.style.animationDelay = `${-Math.min(300, Date.now() - since)}ms`;
          entry.append(badge);
        }
      }
      board.append(entry);
    }
    if (hiddenRows) board.append(h('small', `+${hiddenRows} more · ${keyLabel('scoreboard')} for the full standings`, 'ranking-more'));
    return board;
  }
  recordStrip(
    label: string,
    record: RaceRecord | SessionRecord | null | undefined,
    name: string | undefined,
    tooltip: string,
  ) {
    const strip = h('div', undefined, `record-strip record-${label.toLowerCase()}`);
    strip.title = tooltip;
    const status = !record
      ? 'Loading…'
      : 'status' in record && record.status === 'missing'
        ? 'No record'
        : 'status' in record && record.status === 'unavailable'
          ? 'Unavailable'
          : name;
    const holder = h('span', status, 'record-holder');
    if (record && 'ids' in record) {
      holder.replaceChildren();
      for (const id of record.ids) {
        if (holder.childNodes.length) holder.append(' / ');
        holder.append(this.playerLabel(id));
      }
    }
    strip.append(
      h('strong', label),
      holder,
      h('strong', record?.frames ? time(record.frames) : '—', 'record-time'),
    );
    return strip;
  }
  renderHud() {
    this.#hud.replaceChildren();
    this.#povHud.replaceChildren();
    this.#povRecordHud.replaceChildren();
    this.#practiceHud.replaceChildren();
    this.#practiceHud.hidden = true;
    this.#povHud.hidden = true;
    this.#povRecordHud.hidden = true;
    this.#hud.hidden = !this.#c.state || !Cup.currentMatch(this.#c.state) || this.#open;
    this.#hud.classList.toggle('spectating', this.#c.canSpectate());
    if (this.#hud.hidden) return;
    const s = this.#c.cup,
      m = Cup.currentMatch(s),
      id = recordTrack(s),
      track = s.tracks.find((t) => t.id === id);
    const title = h('div', undefined, 'hud-track');
    title.append(h('strong', track?.name ?? s.name));
    const sub = h('div', undefined, 'hud-meta');
    // Not So Weekly Shorts: between tracks the finished block no longer has a schedule; show the
    // scoreboard anyway with what comes next.
    const visit = s.runtime
      ? Cup.trackProgress(s, m.rounds)
      : m.rounds
        ? Cup.trackProgress(s, m.rounds - 1)
        : Cup.trackProgress(s, 0);
    const picked = s.roster
      .filter((p) => Cup.chosenTracks(s, p.id).includes(id ?? ''))
      .map((p) => p.name)
      .join(', ');
    const picker = h(
      'span',
      rulesFor(s).selection === 'random' ? 'Random track' : 'Picked by ',
      'track-pickers',
    );
    for (const player of s.roster.filter((p) => Cup.chosenTracks(s, p.id).includes(id ?? ''))) {
      if (picker.childNodes.length > 1) picker.append(', ');
      picker.append(this.playerLabel(player.id));
    }
    picker.title = picked;
    const roundNumber = (s.runtime?.round ?? m.rounds) || 1;
    sub.append(
      picker,
      h(
        'strong',
        visit && (s.runtime || visit.trackId === id)
          ? `ROUND ${roundNumber} · ${visit.round}/${visit.rounds} ON TRACK`
          : `ROUND ${roundNumber}`,
      ),
    );
    title.append(sub);
    const upcoming = !s.runtime ? Cup.nextTrack(s) : null;
    if (upcoming && upcoming !== id)
      title.append(h('div', `Next: ${s.tracks.find((t) => t.id === upcoming)?.name ?? 'new track'}`, 'hud-next'));
    const status = h('div', undefined, 'hud-phase');
    status.append(
      h(
        'span',
        s.phase === 'between-rounds' && this.#c.needsRebind.size ? 'Cup paused' : names[s.phase],
      ),
    );
    title.append(status);
    const records = id ? s.records[id] : undefined,
      tr = id ? sessionRecord(s, id) : null;
    const summary = h('div', undefined, 'hud-summary');
    summary.append(title);
    if (!rulesFor(s).collisions)
      summary.append(
        this.recordStrip(
          'WR',
          records?.wr,
          records?.wr?.name,
          'Overall leaderboard record. Official/community tracks use verified records; custom tracks use their public leaderboard.',
        ),
      );
    summary.append(
      this.recordStrip(
        'TR',
        tr ?? { status: 'missing' },
        tr?.ids.map((id) => this.name(id)).join(' / '),
        'Fastest scored run on this track in this Cup, including current round provisionally. Voided rounds are excluded.',
      ),
    );
    this.#hud.append(summary, this.scoreboard());
    const vote = this.trackVoteControls();
    if (vote) {
      this.#practiceHud.hidden = false;
      this.#practiceHud.append(vote);
    }
    const skip = this.skipControl();
    if (skip) {
      this.#practiceHud.hidden = false;
      this.#practiceHud.append(skip);
    }
    if (s.phase === 'warmup') {
      this.#practiceHud.hidden = false;
      this.#practiceHud.append(this.practiceControls());
    } else if (
      Cup.roundDone(s, this.#c.localPlayerId) &&
      !this.#c.canSpectate() &&
      this.#c.watchable().length
    ) {
      this.#practiceHud.hidden = false;
      this.#practiceHud.append(
        this.button('Watch remaining racers', () => this.#c.watchRemaining()),
      );
    }
    if (this.#c.canSpectate() && this.#c.watchable().length) {
      this.#povHud.hidden = false;
      this.#povHud.append(this.spectatorControls());
      this.#povRecordHud.hidden = false;
      this.#povRecordHud.append(this.spectatorRecord());
    }
  }
  spectatorControls() {
    const c = this.#c,
      box = h('section', undefined, 'pov'),
      racers = c.watchable();
    box.setAttribute('aria-label', 'Spectator controls');
    const previous = this.button('', () => c.cycleWatch(-1), 'pov-cycle previous');
    const next = this.button('', () => c.cycleWatch(1), 'pov-cycle next');
    for (const [button, label, key] of [
      [previous, 'Previous racer', keyLabel('spectatePrevious')],
      [next, 'Next racer', keyLabel('spectateNext')],
    ] as const) {
      button.setAttribute('aria-label', `${label} (${key})`);
      button.setAttribute('aria-keyshortcuts', key);
      button.title = `${label} (${key})`;
      button.disabled = racers.length < 2;
      const icon = h('span', undefined, 'pov-arrow');
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
    }
    const main = h('div', undefined, 'pov-main'),
      name = h('div', undefined, 'pov-name');
    const selected = h('span', undefined, 'pov-selected');
    if (c.watchId !== null && racers.includes(c.watchId))
      selected.append(this.playerLabel(c.watchId));
    else selected.textContent = 'Waiting for racer';
    name.title =
      c.watchId !== null && racers.includes(c.watchId) ? this.name(c.watchId) : 'Waiting for racer';
    name.append(selected);
    main.append(name);
    box.append(previous, main, next);
    // Not So Weekly Shorts: the spectator keys, on screen.
    const game = c.game,
      hints = [`${keyLabel('spectatePrevious')} / ${keyLabel('spectateNext')} switch racer`];
    const freecam = game ? c.native?.freecamKeys?.(game) : null;
    if (freecam?.length && rulesFor(c.cup).allowSpectatorFreecam !== false) hints.push(`${freecam.join(' / ')} free camera`);
    const ghosts = game ? c.native?.ghostKeys?.(game) : null;
    if (ghosts?.length && !rulesFor(c.cup).collisions) hints.push(`${ghosts.join(' / ')} other cars`);
    const hint = h('small', hints.join(' · '), 'pov-keys');
    box.append(hint);
    return box;
  }
  spectatorRecord() {
    const c = this.#c,
      id = recordTrack(c.cup),
      watching = c.watchId !== null && c.watchable().includes(c.watchId);
    const pb = watching && id ? c.cup.records[id]?.pbs[c.watchId!] : null;
    const record = h('div', undefined, 'pov-pb');
    const best = !watching
      ? '—'
      : !pb
        ? 'Loading…'
        : pb.frames
          ? time(pb.frames)
          : pb.status === 'unavailable'
            ? 'Unavailable'
            : 'No record';
    record.title = `${watching ? `${this.name(c.watchId)} — ` : ''}Overall personal best for this track${pb?.source ? ` (${pb.source === 'online' ? 'online leaderboard' : 'saved profile'})` : ''}`;
    record.append(h('span', 'PB'), h('strong', best));
    return record;
  }
  results() {
    const s = this.#c.cup;
    if (s.phase === 'complete') {
      const board = h('div', undefined, 'final-standings');
      board.append(h('h2', 'Final standings'));
      for (const r of resultRows(s)) {
        const row = h('div', undefined, `final-row${r.winner ? ' champion' : ''}`);
        const score = h('span', rulesFor(s).knockout ? (r.winner ? 'Winner' : `Out R${Cup.currentMatch(s).knockedOut?.find((k) => k.id === r.id)?.round ?? '?'}`) : r.score, 'final-score');
        score.title = rulesFor(s).knockout ? 'Knockout result' : 'Cup points';
        row.append(h('strong', r.place), this.racerName(r.id, r.name, false, true));
        if (r.winner) row.append(h('span', 'Winner', 'winner-label'));
        row.append(score);
        board.append(row);
      }
      this.#body.append(board);
      const controls = h('div', undefined, 'controls result-controls');
      if (this.#c.isHost)
        controls.append(
          this.button('Race again', () => this.#c.rematch(), 'primary'),
          this.button('Choose new tracks', () => this.#c.rematch(true)),
        );
      controls.append(this.button('Save results image', () => this.downloadImage(), 'quiet'));
      this.#resultControls = controls;
    }
    const history = h('section', undefined, 'race-history');
    history.append(h('h3', this.#c.isHost ? 'Race history' : 'Latest round'));
    const parent = this.#body;
    this.#body.append(history);
    this.#body = history;
    if (!s.matches.length) this.#body.append(h('p', 'No scored rounds yet.', 'muted'));
    for (const m of s.matches) {
      this.#body.append(h('h3', m.name));
      if (!m.roundsLog.length) this.#body.append(h('p', 'No scored rounds yet.', 'muted'));
      for (const r of m.roundsLog.slice(-20).reverse()) {
        this.#body.append(
          h(
            'p',
            `Round ${r.round}: ${m.players.map((id) => `${this.name(id)} ${r.finishes[id] === undefined ? 'DNF' : time(r.finishes[id])}`).join(' / ')}${r.tiedFirst ? ' · Tied first: no finalist win' : ''}`,
            'history',
          ),
        );
      }
    }
    this.#body = parent;
  }
  // Not So Weekly Shorts: vote-skip for random tracks.
  skipControl() {
    const c = this.#c,
      s = c.state,
      target = Cup.skipTarget(s);
    if (!s || !target || c.localPlayerId === null || !Cup.activeIds(s).includes(c.localPlayerId))
      return null;
    const votes = Cup.skipVotes(s),
      mine = votes.includes(c.localPlayerId);
    const button = this.button(
      `${mine ? 'Voted to skip' : 'Vote to skip track'} ${votes.length}/${Cup.skipNeeded(s)}`,
      () => c.action('skip-vote', target),
      mine ? 'selected' : 'quiet',
    );
    button.setAttribute('aria-pressed', String(mine));
    button.classList.add('skip-vote');
    return button;
  }
  practiceControls() {
    const c = this.#c,
      s = c.cup,
      run = c.round,
      box = h('div', undefined, 'practice-controls');
    const ready = run.practiceReady ?? [],
      ids = Cup.activeIds(s);
    const count = h(
        'span',
        rulesFor(s).readyEndsWarmup ? `${ready.length}/${ids.length} ready` : 'Practice',
      ),
      clock = h('strong');
    clock.dataset.clock = '';
    box.append(count, clock);
    if (rulesFor(s).readyEndsWarmup && c.localPlayerId !== null && ids.includes(c.localPlayerId)) {
      const button = this.button(
        ready.includes(c.localPlayerId) ? 'Ready ✓' : 'Ready',
        () => c.action('practice-ready', run.id),
        'primary',
      );
      button.disabled = ready.includes(c.localPlayerId);
      box.append(button);
    }
    return box;
  }
  // Not So Weekly Shorts: a final podium like Trackmania's, with each racer's car on their step.
  // When it has been shown, everyone leaves the cup room (the organizer a moment after the others,
  // so nobody sees a dropped connection).
  renderCompletion() {
    const s = this.#c.state,
      rows = s?.phase === 'complete' ? [...resultRows(s)].sort((x, y) => x.place - y.place) : [],
      winner = rows.find((r) => r.winner);
    if (!s || !winner) {
      clearInterval(this.#finishTimer);
      this.#finishCue.hidden = true;
      this.#finishKey = null;
      return;
    }
    const key = `${s.id}:${Cup.currentMatch(s).rounds}:${winner.id}`;
    if (this.#finishKey === key) return;
    this.#finishKey = key;
    this.#open = false;
    this.#finishCue.hidden = false;
    this.#finishCue.classList.add('podium-cue');
    const countdown = h('p', undefined, 'podium-countdown');
    const message = `${s.name} is over. ${winner.name} won with ${winner.score ?? 0} points.`;
    const leave = () => {
      clearInterval(this.#finishTimer);
      (window as unknown as { __nswsCupLeave?: (message: string) => void }).__nswsCupLeave?.(message);
    };
    this.#finishCue.replaceChildren(this.podium(s.name, rows, countdown, leave));
    const leaveAt = Date.now() + PODIUM_MS + (this.#c.isHost ? HOST_LEAVES_AFTER_MS : 0);
    const tick = () => {
      if (this.#finishKey !== key) return clearInterval(this.#finishTimer);
      const left = leaveAt - Date.now();
      const seconds = Math.max(0, Math.ceil(left / 1000));
      countdown.textContent = this.#c.isHost
        ? `Everyone leaves in ${seconds}s unless you race again`
        : `Leaving in ${seconds}s unless the organizer starts a rematch`;
      if (left <= 0) leave();
    };
    clearInterval(this.#finishTimer);
    tick();
    this.#finishTimer = window.setInterval(tick, 500);
  }
  podium(
    name: string,
    rows: ReturnType<typeof resultRows>,
    countdown: HTMLElement,
    leave: () => void,
  ) {
    const box = h('div', undefined, 'podium');
    box.append(h('p', name, 'podium-cup'), h('h2', 'Final podium'));
    const stage = h('div', undefined, 'podium-stage');
    for (const step of [2, 1, 3]) {
      const r = rows[step - 1],
        slot = h('div', undefined, `podium-slot podium-${step}`);
      if (r) {
        const car = h('img', undefined, 'podium-car');
        car.alt = `${r.name}'s car`;
        car.draggable = false;
        car.src = new URL('images/car_thumbnail_placeholder.png', document.baseURI).href;
        this.thumbnail(r.id).then((url) => {
          if (url && car.isConnected) car.src = url;
        });
        slot.append(car, h('strong', r.name, 'podium-name'), h('span', this.podiumScore(r), 'podium-points'));
      }
      if (!r) slot.classList.add('empty');
      const block = h('div', undefined, 'podium-block');
      block.append(h('span', r ? String(r.place) : '', 'podium-place'));
      slot.append(block);
      stage.append(slot);
    }
    box.append(stage);
    if (rows.length > 3) {
      const rest = h('ol', undefined, 'podium-rest');
      rest.start = 4;
      for (const r of rows.slice(3)) {
        const item = h('li');
        item.append(h('span', `${r.place}. ${r.name}`), h('span', this.podiumScore(r), 'podium-points'));
        rest.append(item);
      }
      box.append(rest);
    }
    const controls = h('div', undefined, 'controls podium-controls');
    // Not So Weekly Shorts: the organizer can go again straight from the podium (which keeps
    // everyone in the room), and anyone can save their best run of the cup as a clip.
    if (this.#c.isHost)
      controls.append(
        this.button('Race again', () => this.#c.rematch(), 'primary'),
        this.button('New tracks', () => this.#c.rematch(true), 'quiet'),
      );
    const best = this.#c.bestRun;
    if (best && this.#c.native?.saveClip) {
      const track = this.#c.cup.tracks.find((t) => t.id === best.trackId)?.name ?? 'track';
      const clip = this.button(`Clip my best run (P${best.place} · ${track})`, async () => {
        const saved = await this.#c.saveBestRun();
        clip.textContent = saved === 'duplicate' ? 'Already in your clips' : saved ? 'Saved to your clips' : 'Couldn’t save the clip';
        clip.disabled = true;
      }, 'quiet');
      controls.append(clip);
    }
    controls.append(
      this.button('Save results image', () => this.downloadImage(), 'quiet'),
      this.button('Leave now', leave, this.#c.isHost ? 'quiet' : 'primary'),
    );
    box.append(controls, countdown);
    return box;
  }
  // Not So Weekly Shorts: a knockout cup has no points; say when each racer went out.
  podiumScore(r: { id: number; score?: number; winner: boolean }) {
    const s = this.#c.cup;
    if (!rulesFor(s).knockout) return `${r.score ?? 0} pts`;
    if (r.winner) return 'Winner';
    const out = Cup.currentMatch(s).knockedOut?.find((k) => k.id === r.id);
    return out ? `Out in round ${out.round}` : 'Still in';
  }
  async downloadImage() {
    const state = structuredClone(this.#c.cup),
      blob = await resultsImage(state, (id) => this.thumbnail(id));
    const url = URL.createObjectURL(blob),
      a = h('a');
    a.href = url;
    a.download = 'polycup-results.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Not So Weekly Shorts: the cup leader (by the cup's own ranking), for lead-change notices.
function rankingLeader(s: CupState) {
  const m = Cup.currentMatch(s);
  if (!m) return null;
  const ranking = Cup.rankMatch(s, m).filter((id) => Cup.activeIds(s).includes(id));
  const first = ranking[0];
  if (first === undefined || !m.scores[first]) return null;
  return ranking[1] !== undefined && m.scores[ranking[1]] === m.scores[first] ? null : first;
}
