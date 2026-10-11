import type { CupUI } from './ui.ts';
import { element as h } from './dom.ts';
import * as Cup from './cup.ts';
import { rosterOpen } from './draft.ts';
import { rulesFor } from './presets.ts';

export class PlayerMenu {
  #ui: CupUI;
  #root: ShadowRoot;
  #element = h('div', undefined, 'player-menu');
  #id: number | null = null;
  #cupId = '';
  #signature = '';
  #anchor: DOMRect | null = null;
  constructor(ui: CupUI, root: ShadowRoot) {
    this.#ui = ui;
    this.#root = root;
    this.#element.id = 'player-actions-menu';
    this.#element.popover = 'auto';
    this.#element.setAttribute('role', 'dialog');
    this.#element.tabIndex = -1;
    this.#element.addEventListener('toggle', () => {
      if (!this.#element.matches(':popover-open')) this.#id = null;
      this.updateTriggers();
    });
    root.append(this.#element);
  }
  get open() {
    return this.#id !== null && this.#element.matches(':popover-open');
  }
  close() {
    const id = this.#id;
    this.#id = null;
    this.#element.hidePopover();
    this.updateTriggers();
    if (id !== null && this.#ui.panelOpen)
      this.#root
        .querySelector<HTMLElement>(`[data-player-menu-id="${id}"]`)
        ?.focus({ preventScroll: true });
  }
  updateTriggers() {
    for (const button of this.#root.querySelectorAll<HTMLElement>('[data-player-menu-id]'))
      button.setAttribute(
        'aria-expanded',
        String(this.open && Number(button.dataset.playerMenuId) === this.#id),
      );
  }
  show(id: number, anchor: HTMLElement) {
    if (!this.#ui.c.isHost || !this.#ui.c.state) return;
    this.#id = id;
    this.#cupId = this.#ui.c.state.id;
    this.#signature = '';
    this.#anchor = anchor.getBoundingClientRect();
    this.#ui.c.clearDrivingInput();
    this.sync();
    if (this.#id === null) return;
    this.#element.showPopover();
    this.updateTriggers();
    (this.#element.querySelector<HTMLElement>('button:not(:disabled)') ?? this.#element).focus({
      preventScroll: true,
    });
    this.position();
  }
  position() {
    if (!this.#anchor) return;
    const rect = this.#element.getBoundingClientRect();
    this.#element.style.left = `${Math.max(8, Math.min(this.#anchor.left, innerWidth - rect.width - 8))}px`;
    this.#element.style.top = `${Math.max(8, Math.min(this.#anchor.bottom + 8, innerHeight - rect.height - 8))}px`;
  }
  sync() {
    if (this.#id === null) return;
    const ui = this.#ui,
      c = ui.c,
      s = c.state,
      id = this.#id;
    const peer = c.lobby.find((p) => p.id === id),
      racer = Cup.player(s, id);
    if (!c.isHost || !s || s.id !== this.#cupId || !ui.panelOpen || (!peer && !racer)) {
      this.close();
      return;
    }
    const key = JSON.stringify([
      s.id,
      s.revision,
      peer?.nickname,
      c.hello.has(id),
      c.needsRebind.has(id),
      c.lobby.map((p) => p.id),
    ]);
    this.updateTriggers();
    if (key === this.#signature) return;
    const activeKey = (this.#root.activeElement as HTMLElement | null)?.dataset.actionKey;
    this.#signature = key;
    const name = peer?.nickname ?? racer!.name;
    this.#element.setAttribute('aria-label', `Player actions for ${name}`);
    const heading = h('div', undefined, 'player-menu-heading');
    heading.append(ui.playerLabel(id, name, true));
    this.#element.replaceChildren(heading);
    const action = (label: string, run: () => unknown, dangerous = false) => {
      const button = ui.button(
        label,
        async () => {
          if (c.state !== s || !c.isHost) {
            this.close();
            return;
          }
          await run();
          this.close();
        },
        dangerous ? 'quiet danger' : 'primary',
        `player:${id}:${label}`,
      );
      this.#element.append(button);
      return button;
    };
    if (rosterOpen(s)) {
      if (racer)
        action('Move to spectators', () =>
          c.change((state) => {
            Cup.removePlayer(state, id);
            c.pruneTrackData();
          }),
        );
      else if (peer) {
        const add = action('Move to racers', () =>
          id === c.selfId ? c.action('join') : c.enrollRacer(id, { type: 'join', cupId: s.id }),
        );
        add.disabled = s.roster.length >= 8 || (id !== c.selfId && !c.hello.has(id));
      }
    } else if (rulesFor(s).allowRacerChanges && !['registration', 'complete'].includes(s.phase)) {
      if (racer && (!s.withdrawn?.includes(id) || s.pendingRacers?.includes(id)))
        action('Move to spectators', () => c.moveToSpectators(id));
      else if (peer) {
        const add = action('Move to racers', () =>
          id === c.selfId ? c.action('join') : c.enrollRacer(id, { type: 'join', cupId: s.id }),
        );
        add.title = 'Joins the next round; returning racers keep their score.';
        add.disabled = Cup.occupiedSlots(s) >= 8 || (id !== c.selfId && !c.hello.has(id));
      }
    }
    if (racer && c.needsRebind.has(id) && !s.runtime) {
      const label = h('label', 'Confirm saved racer'),
        select = h('select');
      select.setAttribute('aria-label', `Reconnect ${name}`);
      const placeholder = h('option', 'Choose connected player');
      placeholder.value = '';
      select.append(placeholder);
      for (const p of c.lobby.filter((p) => !Cup.player(s, p.id) || p.id === id)) {
        const option = h('option', `${ui.optionName(p.id, p.nickname)} · #${p.id}`);
        option.value = String(p.id);
        option.disabled = p.id !== c.selfId && !c.hello.has(p.id);
        select.append(option);
      }
      label.append(select);
      this.#element.append(label);
      const confirm = action('Confirm identity', () => {
        const person = c.lobby.find((p) => p.id === Number(select.value));
        if (person) c.rebindRacer(id, person.id, person.nickname);
      });
      confirm.disabled = true;
      select.addEventListener('change', () => {
        confirm.disabled = !select.value;
      });
    }
    if (peer && id !== c.selfId)
      action(
        'Kick from the cup',
        async () => {
          const draft = s.phase === 'registration' && !rosterOpen(s);
          // Not So Weekly Shorts: an in-page confirmation (confirm() blocks the organizer's clock).
          this.close();
          if (
            await ui.ask(
              `Kick ${name} from the cup room?${draft ? ' This restarts the draft for the remaining racers.' : ''}`,
              'Kick',
              true,
            )
          )
            c.kickPlayer(id);
        },
        true,
      );
    if (this.#element.childElementCount === 1)
      this.#element.append(h('p', 'No player actions available during this phase.', 'muted'));
    if (this.open) {
      this.position();
      if (activeKey)
        [...this.#element.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.dataset.actionKey === activeKey)
          ?.focus({ preventScroll: true });
    }
  }
}
