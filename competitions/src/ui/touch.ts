// Whether the cup shows its touch controls, and taps made while other fingers hold the pedals.

const COARSE = matchMedia('(pointer: coarse)');
let touched = false;

// A phone or tablet: the layer is drawn larger and the panel is one column.
export const isPhone = () => COARSE.matches;
// Touch is in use. Like the game's touch layout, a key press ends it, but not on a phone, whose
// on-screen keyboard sends key presses too.
export const isTouch = () => touched || COARSE.matches;

export function watchTouch(changed: () => void) {
  const set = (on: boolean) => {
    if (touched === on) return;
    touched = on;
    changed();
  };
  window.addEventListener('touchstart', () => set(true), { capture: true, passive: true });
  window.addEventListener('keydown', () => !COARSE.matches && set(false), true);
  COARSE.addEventListener?.('change', changed);
}

const SLOP_PX = 16;

// Browsers only make a click from the first finger down, so a button tapped while a thumb holds
// accelerate is clicked here.
export function tapWithOtherFingers(host: HTMLElement) {
  const taps = new Map<number, { button: HTMLButtonElement; x: number; y: number }>();
  window.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length < 2) return;
      const path = e.composedPath();
      if (!path.includes(host)) return;
      const button = path.find((t): t is HTMLButtonElement => t instanceof HTMLButtonElement);
      if (!button) return;
      for (const t of e.changedTouches) taps.set(t.identifier, { button, x: t.clientX, y: t.clientY });
    },
    { capture: true, passive: true },
  );
  const end = (e: TouchEvent) => {
    for (const t of e.changedTouches) {
      const tap = taps.get(t.identifier);
      if (!tap) continue;
      taps.delete(t.identifier);
      if (e.type === 'touchcancel' || Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > SLOP_PX) continue;
      // No click of the browser's own on top of this one.
      if (e.cancelable) e.preventDefault();
      if (tap.button.isConnected) tap.button.click();
    }
  };
  window.addEventListener('touchend', end, { capture: true, passive: false });
  window.addEventListener('touchcancel', end, { capture: true });
}
