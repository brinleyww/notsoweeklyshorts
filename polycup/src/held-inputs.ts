import type { DrivingControls } from './types.ts';

export type DrivingDirection = 'up' | 'right' | 'down' | 'left';
export type DrivingBindings = Record<DrivingDirection, (string | null)[]>;

export function isEditing(event: Event) {
  return event.composedPath().some((target) => {
    const element = target as HTMLElement;
    return (
      ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(element.tagName) ||
      element.isContentEditable
    );
  });
}

export class HeldDrivingInputs {
  #bindings = new Map<string, DrivingDirection>();
  #held = new Set<string>();

  bind(bindings: DrivingBindings) {
    this.#bindings.clear();
    for (const direction of ['up', 'right', 'down', 'left'] as const)
      for (const code of bindings[direction])
        if (code && !this.#bindings.has(code)) this.#bindings.set(code, direction);
    for (const code of this.#held) if (!this.#bindings.has(code)) this.#held.delete(code);
  }

  press(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || isEditing(event))
      return;
    if (this.#bindings.has(event.code)) this.#held.add(event.code);
  }

  release(code: string) {
    this.#held.delete(code);
  }

  clear() {
    this.#held.clear();
  }

  controls(): DrivingControls {
    const controls = { up: false, right: false, down: false, left: false, reset: false };
    for (const code of this.#held) {
      const direction = this.#bindings.get(code);
      if (direction) controls[direction] = true;
    }
    return controls;
  }
}
