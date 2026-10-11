// Not So Weekly Shorts: an in-page confirmation. The browser's confirm() blocks the page, and the
// organizer's page runs the cup clock for everyone.
import { element as h } from './dom.ts';

export class ConfirmDialog {
  #dialog = h('dialog', undefined, 'rules-dialog confirm-dialog');
  #text = h('p', undefined, 'confirm-text');
  #ok = h('button', undefined, 'primary');
  #cancel = h('button', 'Cancel', 'quiet');
  #resolve: ((ok: boolean) => void) | null = null;
  constructor(root: ShadowRoot) {
    this.#dialog.setAttribute('aria-label', 'Confirm');
    this.#ok.type = this.#cancel.type = 'button';
    const actions = h('div', undefined, 'controls confirm-actions');
    actions.append(this.#cancel, this.#ok);
    const body = h('div', undefined, 'rules-dialog-body');
    body.append(this.#text, actions);
    this.#dialog.append(body);
    this.#ok.addEventListener('click', () => this.#finish(true));
    this.#cancel.addEventListener('click', () => this.#finish(false));
    this.#dialog.addEventListener('close', () => this.#finish(false));
    this.#dialog.addEventListener('click', (event) => {
      if (event.target === this.#dialog) this.#finish(false);
    });
    root.append(this.#dialog);
  }
  get open() {
    return this.#dialog.open;
  }
  ask(text: string, ok = 'Confirm', danger = false) {
    this.#finish(false);
    this.#text.textContent = text;
    this.#ok.textContent = ok;
    this.#ok.classList.toggle('danger', danger);
    this.#dialog.showModal();
    this.#cancel.focus();
    return new Promise<boolean>((resolve) => {
      this.#resolve = resolve;
    });
  }
  #finish(ok: boolean) {
    const resolve = this.#resolve;
    this.#resolve = null;
    if (this.#dialog.open) this.#dialog.close();
    resolve?.(ok);
  }
}
