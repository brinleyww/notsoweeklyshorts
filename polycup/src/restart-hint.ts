// Keep the native key labels (including rebound keys) and change only the action.
export class RestartHint {
  #changed: Map<ChildNode, string> = new Map();

  constructor() {}
  update(root: HTMLElement | null, retiring: boolean) {
    const original = ' to start over.',
      replacement = ' to retire from this round.';
    for (const [node, text] of this.#changed) {
      if (!retiring || !root?.contains(node)) {
        if (node.textContent === replacement) node.textContent = text;
        this.#changed.delete(node);
      }
    }
    if (!retiring) return;
    for (const line of root?.querySelectorAll('.hint-ui .title, .hint-ui .subtitle') ?? []) {
      for (const node of line.childNodes)
        if (node.nodeType === 3 && node.textContent === original) {
          this.#changed.set(node, original);
          node.textContent = replacement;
        }
    }
  }
}
