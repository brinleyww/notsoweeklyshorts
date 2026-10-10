import type { NativeConnection } from './game-types.ts';
// Read the same public connection methods used by PolyTrack's native Invite UI.
type InviteState =
  | { status: 'ready' | 'expired'; code: string; expires: number }
  | { status: 'hidden' | 'loading' | 'empty' | 'error'; code?: undefined; expires?: undefined };
export function inviteState(connection: NativeConnection | null, now = Date.now()): InviteState {
  if (!connection?.isInviteAllowed?.()) return { status: 'hidden' };
  if (connection.getInviteIsLoading()) return { status: 'loading' };
  const invite = connection.getInvite();
  if (invite == null) return { status: 'empty' };
  if (typeof invite.inviteCode !== 'string' || !invite.inviteCode) return { status: 'error' };
  const expires =
    invite.timeoutMilliseconds === null
      ? Infinity
      : invite.timeoutMilliseconds <= 0
        ? 0
        : Number(invite.timeoutStart) + invite.timeoutMilliseconds;
  if (!Number.isFinite(expires) && expires !== Infinity) return { status: 'error' };
  return { status: expires <= now ? 'expired' : 'ready', code: invite.inviteCode, expires };
}

export class CupInvite {
  get input() {
    return this.#input;
  }
  get element() {
    return this.#element;
  }

  #element: HTMLElement;
  #input: HTMLInputElement;
  #button: HTMLButtonElement;
  #link: HTMLButtonElement;
  #icon: HTMLImageElement;
  #text: HTMLSpanElement;
  #status: HTMLElement;
  #connection: NativeConnection | null = null;
  #requested: boolean = false;
  #requestFailed: boolean = false;
  #feedback: string = '';
  #feedbackUntil: number = 0;
  #lastCode: string | null | undefined;
  #copying: NativeConnection | null = null;

  constructor() {
    this.#element = document.createElement('div');
    this.#element.className = 'lobby-invite';
    const label = document.createElement('label');
    label.className = 'invite-label';
    label.textContent = 'Lobby code';
    this.#input = document.createElement('input');
    this.#input.type = 'text';
    this.#input.readOnly = true;
    this.#input.setAttribute('aria-label', 'Lobby invite code');
    this.#input.spellcheck = false;
    this.#input.addEventListener('click', () => this.#input.select());
    label.append(this.#input);
    this.#button = document.createElement('button');
    this.#button.type = 'button';
    this.#button.className = 'quiet invite-copy';
    this.#icon = document.createElement('img');
    this.#icon.alt = '';
    this.#icon.draggable = false;
    this.#text = document.createElement('span');
    this.#text.setAttribute('aria-live', 'polite');
    this.#button.append(this.#icon, this.#text);
    this.#button.addEventListener('click', () => this.act());
    const row = document.createElement('div');
    row.className = 'invite-actions';
    // Not So Weekly Shorts: a link that opens the site and joins this cup.
    this.#link = document.createElement('button');
    this.#link.type = 'button';
    this.#link.className = 'quiet invite-copy';
    this.#link.textContent = 'Link';
    this.#link.setAttribute('aria-label', 'Copy invite link');
    this.#link.addEventListener('click', () => this.copyLink());
    row.append(label, this.#button, this.#link);
    this.#status = document.createElement('small');
    this.#status.className = 'invite-status';
    this.#status.setAttribute('role', 'status');
    this.#status.setAttribute('aria-live', 'polite');
    this.#element.append(row, this.#status);
  }
  update(connection: NativeConnection | null, open: boolean) {
    if (connection !== this.#connection) {
      this.#connection = connection;
      this.#requested = false;
      this.#requestFailed = false;
      this.#feedback = '';
      this.#feedbackUntil = 0;
      this.#lastCode = null;
    }
    let state = inviteState(connection);
    // Opening PolyCup can replace opening vanilla Invite. Request once, never
    // rotate a still-valid code or retry a failed service on every render tick.
    if (open && !this.#requested && state.status !== 'hidden') {
      this.#requested = true;
      if (['empty', 'expired'].includes(state.status)) {
        this.renew();
        state = inviteState(connection);
      }
    }
    if (state.status === 'loading') this.#requested = true;
    if (this.#requestFailed && state.status === 'empty') state = { status: 'error' };
    if (state.code !== this.#lastCode) {
      this.#feedback = '';
      this.#lastCode = state.code;
    }
    this.#element.hidden = state.status === 'hidden';
    const ready = state.status === 'ready';
    this.#link.disabled = !ready;
    const value = state.status === 'ready' ? state.code : '';
    if (this.#input.value !== value) this.#input.value = value;
    this.#input.placeholder =
      state.status === 'loading'
        ? 'Creating…'
        : state.status === 'expired'
          ? 'Expired'
          : 'Unavailable';
    this.#input.disabled = !ready;
    this.#button.disabled =
      ['hidden', 'loading'].includes(state.status) || this.#copying === connection;
    const feedback = ready && this.#feedbackUntil > Date.now() ? this.#feedback : '';
    this.#text.textContent =
      this.#copying === connection && connection
        ? 'Copying…'
        : feedback === 'copied'
          ? 'Copied!'
          : ready
            ? 'Copy'
            : state.status === 'expired'
              ? 'Renew'
              : state.status === 'loading'
                ? 'Creating…'
                : 'Retry';
    this.#button.setAttribute(
      'aria-label',
      ready
        ? 'Copy lobby invite code'
        : state.status === 'expired'
          ? 'Renew lobby invite code'
          : 'Create lobby invite code',
    );
    const icon = ready || state.status === 'loading' ? 'copy' : 'refresh';
    const src = new URL(`images/${icon}.svg`, document.baseURI).href;
    if (this.#icon.src !== src) this.#icon.src = src;
    const message =
      feedback === 'manual'
        ? 'Select code and press Ctrl+C'
        : state.status === 'ready' && state.expires !== Infinity
          ? `Expires in ${Math.max(1, Math.ceil((state.expires - Date.now()) / 60000))} min`
          : '';
    if (this.#status.textContent !== message) this.#status.textContent = message;
  }
  async copyLink() {
    const state = inviteState(this.#connection);
    if (state.status !== 'ready') return;
    const link = location.origin + location.pathname + '?cup=' + state.code;
    try {
      await navigator.clipboard.writeText(link);
      this.#link.textContent = 'Copied!';
    } catch {
      this.#input.value = link;
      this.#input.select();
      this.#link.textContent = 'Ctrl+C';
    }
    setTimeout(() => (this.#link.textContent = 'Link'), 2000);
  }
  renew() {
    this.#requested = true;
    this.#requestFailed = false;
    try {
      this.#connection!.renewInvite();
    } catch {
      this.#requestFailed = true;
    }
  }
  async act() {
    const connection = this.#connection,
      state = inviteState(connection);
    if (state.status === 'hidden' || state.status === 'loading' || this.#copying === connection)
      return;
    if (state.status !== 'ready') {
      this.renew();
      this.update(connection, false);
      return;
    }
    this.#copying = connection;
    this.update(connection, false);
    let copied = false;
    try {
      await navigator.clipboard.writeText(state.code!);
      copied = true;
    } catch {
      // The native game also falls back to selection-based copying on desktop.
      // Keep the code selectable when the browser denies both clipboard paths.
      if (this.#connection === connection && inviteState(connection).code === state.code) {
        this.#input.focus();
        this.#input.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          /* Manual copy remains available. */
        }
      }
    } finally {
      if (this.#copying === connection) this.#copying = null;
    }
    if (this.#connection !== connection || inviteState(connection).code !== state.code) return;
    this.#feedback = copied ? 'copied' : 'manual';
    this.#feedbackUntil = Date.now() + (copied ? 2000 : 8000);
    this.update(connection, false);
  }
}
