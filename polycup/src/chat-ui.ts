import { element as h, uiScale } from './dom.ts';
import { CHAT_LIMIT, type ChatLine, type ChatTab } from './chat.ts';
import { isEditing } from './held-inputs.ts';
import type { CupUI } from './ui.ts';
const colors = [
  '#8edcf4',
  '#ffd26b',
  '#c8afff',
  '#9de4a2',
  '#ffb4c9',
  '#ffbf91',
  '#aebeff',
  '#9aebd5',
];
export class ChatUI {
  #ui: CupUI;
  #shadow: ShadowRoot;
  #root = h('aside', undefined, 'cup-chat');
  #button = h('button', 'Chat', 'chat-toggle');
  #preview = h('div', undefined, 'chat-preview');
  #panel = h('section', undefined, 'chat-panel');
  #history = h('div', undefined, 'chat-history');
  #input = h('input');
  #sendButton = h('button', 'Send', 'primary');
  #status = h('p', undefined, 'chat-status');
  #older = h('button', 'Earlier messages', 'quiet chat-older');
  #bottom = h('button', 'New messages ↓', 'quiet chat-bottom');
  #personMenu = h('div', undefined, 'chat-person-menu');
  #selectedSpeaker: number | null = null;
  #hidePreview = h('input');
  #expanded = false;
  #persistent = false;
  #cupId = '';
  #shownRevision = -1;
  // Not So Weekly Shorts: a Cup tab and a Global tab, each with its own unread count.
  #tabs: Record<ChatTab, HTMLButtonElement> = {
    cup: h('button', 'Cup', 'chat-tab'),
    global: h('button', 'Global', 'chat-tab'),
  };
  #seen: Record<ChatTab, { known: number; read: number }> = {
    cup: { known: 0, read: 0 },
    global: { known: 0, read: 0 },
  };
  #limit = 60;
  #expires = 0;
  #sending = false;
  #stickBottom = true;
  #prepend = false;
  constructor(ui: CupUI, shadow: ShadowRoot) {
    this.#ui = ui;
    this.#shadow = shadow;
    this.#root.setAttribute('aria-label', 'Cup chat');
    this.#button.type = 'button';
    this.#button.addEventListener('click', () => (this.#expanded ? this.close() : this.open()));
    this.#panel.id = 'cup-chat-panel';
    this.#panel.setAttribute('aria-label', 'Chat history');
    const heading = h('div', undefined, 'chat-heading');
    const tabs = h('div', undefined, 'chat-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const tab of ['cup', 'global'] as const) {
      const button = this.#tabs[tab];
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => this.#switchTab(tab));
      tabs.append(button);
    }
    heading.append(tabs);
    const close = h('button', 'Close', 'quiet chat-close');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    heading.append(close);
    this.#history.tabIndex = 0;
    this.#history.setAttribute('aria-label', 'Messages');
    this.#history.addEventListener('scroll', () => {
      this.#stickBottom =
        this.#history.scrollHeight - this.#history.scrollTop - this.#history.clientHeight < 32;
      this.#bottom.hidden = this.#stickBottom;
    });
    this.#older.type = 'button';
    this.#older.addEventListener('click', () => {
      this.#limit += 100;
      this.#prepend = true;
      this.#shownRevision = -1;
      this.render();
    });
    this.#bottom.type = 'button';
    this.#bottom.hidden = true;
    this.#bottom.addEventListener('click', () => {
      this.#stickBottom = true;
      this.#history.scrollTop = this.#history.scrollHeight;
      this.#bottom.hidden = true;
    });
    const form = h('form', undefined, 'chat-compose');
    this.#input.type = 'text';
    this.#input.maxLength = CHAT_LIMIT;
    this.#input.placeholder = 'Message the Cup…';
    this.#input.setAttribute('aria-label', 'Chat message');
    this.#input.autocomplete = 'off';
    this.#input.addEventListener('input', () => {
      this.#sendButton.disabled = this.#sending || !this.#input.value.trim() || ui.c.chat.muted;
    });
    this.#sendButton.type = 'submit';
    form.append(this.#input, this.#sendButton);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send();
    });
    this.#status.setAttribute('role', 'status');
    const options = h('div', undefined, 'chat-options'),
      label = h('label', 'Hide message previews');
    this.#hidePreview.type = 'checkbox';
    try {
      this.#hidePreview.checked = localStorage.getItem('pwc-hide-chat') === 'true';
    } catch {}
    this.#hidePreview.addEventListener('change', () => {
      try {
        localStorage.setItem('pwc-hide-chat', String(this.#hidePreview.checked));
      } catch {}
      this.render();
    });
    label.prepend(this.#hidePreview);
    options.append(label);
    this.#personMenu.hidden = true;
    this.#personMenu.setAttribute('role', 'group');
    this.#personMenu.setAttribute('aria-label', 'Player chat controls');
    this.#panel.append(
      heading,
      this.#history,
      this.#personMenu,
      this.#bottom,
      form,
      this.#status,
      options,
    );
    this.#root.append(this.#preview, this.#button, this.#panel);
    shadow.append(this.#root);
    this.#panel.hidden = true;
    this.#root.hidden = true;
    this.#panel.addEventListener('focusin', () => {
      ui.c.clearDrivingInput();
      if (this.#persistent) {
        this.#expanded = true;
        ui.c.setChatTyping(true);
      }
    });
    this.#panel.addEventListener('focusout', () => {
      queueMicrotask(() => {
        if (this.#persistent && !this.#panel.contains(shadow.activeElement)) {
          this.#expanded = false;
          ui.c.setChatTyping(false);
        }
      });
    });
    for (const type of ['keydown', 'keyup', 'keypress'] as const)
      window.addEventListener(
        type,
        (event) => {
          if (!this.#expanded) return;
          if (!this.#panel.contains(shadow.activeElement)) this.#input.focus();
          event.stopImmediatePropagation();
          if (type === 'keydown' && !event.isComposing) {
            if (event.code === 'Tab') {
              if (this.#persistent) return;
              event.preventDefault();
              const focusable = [
                ...this.#panel.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), input, summary, [tabindex="0"]',
                ),
              ].filter((el) => !el.closest('[hidden]') && el.getClientRects().length);
              const index = focusable.indexOf(shadow.activeElement as HTMLElement);
              focusable[
                (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
              ]?.focus();
            } else if (event.code === 'Escape') {
              event.preventDefault();
              if (this.#selectedSpeaker !== null) {
                this.#hidePersonMenu();
                this.#input.focus();
              } else this.close();
            } else if (event.code === 'Enter' && shadow.activeElement === this.#input) {
              event.preventDefault();
              if (!event.repeat) void this.send();
            }
          }
        },
        { capture: true },
      );
    document.addEventListener(
      'pointerdown',
      (event) => {
        const path = event.composedPath();
        if (this.#expanded && !path.includes(this.#root)) this.close();
        else if (
          !path.includes(this.#personMenu) &&
          !path.some((node) => node instanceof HTMLElement && node.classList.contains('chat-name'))
        )
          this.#hidePersonMenu();
      },
      { capture: true },
    );
  }
  get unread() {
    const chat = this.#ui.c.chat;
    return (['cup', 'global'] as const).reduce(
      (n, tab) => n + Math.max(0, chat.linesOf(tab).length - this.#seen[tab].read),
      0,
    );
  }
  get isOpen() {
    return this.#expanded;
  }
  mount(target: HTMLElement | null, persistent = false) {
    this.#persistent = !!target && persistent;
    this.#root.classList.toggle('chat-docked', !!target);
    const parent = target ?? this.#shadow;
    if (this.#root.parentNode !== parent) parent.append(this.#root);
    this.#panel.querySelector<HTMLElement>('.chat-close')!.hidden = this.#persistent;
  }
  hotkey(event: KeyboardEvent) {
    if (
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditing(event) ||
      !this.#ui.c.state ||
      document.querySelector('dialog[open],.settings-menu-ui') ||
      this.#shadow.querySelector('dialog[open]')
    )
      return;
    event.preventDefault();
    this.open();
  }
  #switchTab(tab: ChatTab) {
    const chat = this.#ui.c.chat;
    if (chat.tab === tab) return;
    this.#hidePersonMenu();
    chat.tab = tab;
    this.#limit = 60;
    this.#stickBottom = true;
    this.#shownRevision = -1;
    this.#status.textContent = '';
    this.render();
    this.#input.focus();
  }
  open() {
    if (!this.#ui.c.state) return;
    this.#expanded = true;
    this.#seen[this.#ui.c.chat.tab].read = this.#ui.c.chat.lines.length;
    this.#stickBottom = true;
    this.#shownRevision = -1;
    this.#ui.c.setChatTyping(true);
    this.render();
    this.#input.focus();
  }
  close() {
    this.#hidePersonMenu();
    this.#expanded = false;
    this.#ui.c.setChatTyping(false);
    (this.#shadow.activeElement as HTMLElement | null)?.blur();
    this.render();
  }
  async send() {
    if (this.#sending || !this.#input.value.trim()) return;
    const text = this.#input.value,
      cupId = this.#ui.c.state?.id;
    this.#sending = true;
    this.#input.readOnly = true;
    this.#sendButton.disabled = true;
    this.#status.textContent = 'Sending…';
    try {
      await this.#ui.c.chat.post(text);
      if (cupId === this.#ui.c.state?.id) {
        if (this.#input.value === text) this.#input.value = '';
        this.#status.textContent = '';
        this.#stickBottom = true;
      }
    } catch (error) {
      if (cupId === this.#ui.c.state?.id)
        this.#status.textContent = error instanceof Error ? error.message : 'Message not sent.';
    } finally {
      this.#sending = false;
      this.#input.readOnly = false;
      this.render();
    }
  }
  #line(line: ChatLine) {
    const row = h('div', undefined, 'chat-line'),
      stamp = h(
        'time',
        new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      );
    stamp.dateTime = new Date(line.at).toISOString();
    const speaker = this.#ui.c.chat.speakers.find((s) => s.id === line.speaker);
    const name =
      this.#ui.c.isHost && speaker?.canMute
        ? h('button', line.name, 'chat-name')
        : h('strong', line.name, 'chat-name');
    if (name instanceof HTMLButtonElement) {
      name.type = 'button';
      name.dataset.speaker = String(line.speaker);
      name.setAttribute('aria-label', `Chat controls for ${line.name} (#${line.speaker})`);
      name.addEventListener('click', () => this.#showPersonMenu(line.speaker, name));
    }
    name.title = `Chat player #${line.speaker}`;
    name.style.color = colors[line.color];
    row.append(stamp, name, h('span', line.text, 'chat-text'));
    return row;
  }
  render() {
    const c = this.#ui.c,
      state = c.state,
      chat = c.chat;
    this.#root.hidden = !state;
    if (!state) {
      this.#expanded = false;
      c.setChatTyping(false);
      return;
    }
    if (state.id !== this.#cupId) {
      this.#hidePersonMenu();
      this.#cupId = state.id;
      this.#seen = { cup: { known: 0, read: 0 }, global: { known: 0, read: 0 } };
      this.#limit = 60;
      this.#shownRevision = -1;
      this.#expanded = false;
      c.setChatTyping(false);
      this.#input.value = '';
      this.#status.textContent = '';
    }
    if (this.#expanded && !document.hidden && !this.#panel.contains(this.#shadow.activeElement))
      this.#input.focus();
    const lines = chat.cupId === state.id ? chat.lines : [];
    let unread = 0;
    for (const tab of ['cup', 'global'] as const) {
      const seen = this.#seen[tab],
        count = chat.cupId === state.id ? chat.linesOf(tab).length : 0;
      if (count < seen.read) seen.read = seen.known = count;
      if (count > seen.known) {
        if (tab === chat.tab) this.#expires = Date.now() + 4000;
        seen.known = count;
      }
      if (tab === chat.tab && (this.#expanded || this.#persistent) && this.#stickBottom)
        seen.read = count;
      const waiting = Math.max(0, count - seen.read);
      unread += waiting;
      const button = this.#tabs[tab];
      button.textContent = `${tab === 'cup' ? 'Cup' : 'Global'}${waiting && tab !== chat.tab ? ` (${waiting})` : ''}`;
      button.classList.toggle('selected', tab === chat.tab);
      button.setAttribute('aria-selected', String(tab === chat.tab));
    }
    this.#input.placeholder = chat.tab === 'cup' ? 'Message the Cup…' : 'Message everyone on the site…';
    const keys = c.game && !c.info?.disposed ? (c.native.chatKeys?.(c.game) ?? []) : [];
    this.#button.textContent = `Chat${unread ? ` (${unread})` : ''}${keys.length ? ` · ${keys.join(' / ')}` : ''}`;
    this.#button.setAttribute('aria-expanded', String(this.#expanded));
    this.#root.classList.toggle('chat-open', this.#expanded || this.#persistent);
    this.#panel.hidden = !this.#expanded && !this.#persistent;
    this.#button.hidden = this.#expanded || this.#ui.panelOpen;
    this.#preview.hidden =
      this.#expanded ||
      this.#ui.panelOpen ||
      this.#hidePreview.checked ||
      Date.now() > this.#expires;
    if (this.#shownRevision !== chat.revision) {
      const oldHeight = this.#history.scrollHeight,
        oldTop = this.#history.scrollTop;
      this.#shownRevision = chat.revision;
      this.#history.replaceChildren();
      this.#older.hidden = lines.length <= this.#limit;
      this.#history.append(this.#older);
      if (!lines.length) this.#history.append(h('p', 'No messages yet. Say hello!', 'chat-empty'));
      for (const line of lines.slice(-this.#limit)) this.#history.append(this.#line(line));
      this.#preview.replaceChildren(...lines.slice(-3).map((line) => this.#line(line)));
      this.#history.scrollTop = this.#stickBottom
        ? this.#history.scrollHeight
        : oldTop + (this.#prepend ? Math.max(0, this.#history.scrollHeight - oldHeight) : 0);
      this.#prepend = false;
    }
    this.#bottom.hidden = this.#stickBottom;
    this.#sendButton.disabled = this.#sending || chat.muted || !this.#input.value.trim();
    if (chat.muted && chat.tab === 'cup') this.#status.textContent = 'The organizer muted you for this Cup.';
    else if (this.#status.textContent === 'The organizer muted you for this Cup.')
      this.#status.textContent = '';
  }
  #hidePersonMenu() {
    this.#selectedSpeaker = null;
    this.#personMenu.hidden = true;
  }
  #showPersonMenu(id: number, anchor: HTMLElement) {
    const speaker = this.#ui.c.chat.speakers.find((s) => s.id === id);
    if (!this.#ui.c.isHost || !speaker?.canMute) return;
    if (this.#selectedSpeaker === id) {
      this.#hidePersonMenu();
      return;
    }
    if (!this.#expanded) {
      this.open();
      anchor = this.#history.querySelector<HTMLElement>(`[data-speaker="${id}"]`) ?? this.#history;
    }
    this.#selectedSpeaker = id;
    const name = h('strong', `${speaker.name} · #${speaker.id}`);
    name.style.color = colors[speaker.color];
    const button = h('button', speaker.muted ? 'Unmute' : 'Mute for this Cup', 'quiet');
    button.type = 'button';
    button.setAttribute(
      'aria-label',
      `${speaker.muted ? 'Unmute' : 'Mute'} ${speaker.name} (#${speaker.id})`,
    );
    button.addEventListener('click', () => {
      this.#ui.c.chat.mute(id, !speaker.muted);
      this.#hidePersonMenu();
      this.#input.focus();
    });
    this.#personMenu.replaceChildren(name, button);
    this.#personMenu.hidden = false;
    const panel = this.#panel.getBoundingClientRect(),
      rect = anchor.getBoundingClientRect();
    const scale = uiScale();
    this.#personMenu.style.top = `${Math.max(42, Math.min((rect.bottom - panel.top + 4) / scale, panel.height / scale - this.#personMenu.offsetHeight - 12))}px`;
    button.focus();
  }
}
