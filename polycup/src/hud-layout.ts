import { uiScale } from './dom.ts';
export interface HudElements {
  hud: HTMLElement;
  povHud: HTMLElement;
  povRecordHud: HTMLElement;
  inputHud: HTMLElement;
  practiceHud: HTMLElement;
  notice: HTMLElement;
  roundTimer?: HTMLElement;
  // Not So Weekly Shorts: the finish banner and the between-rounds label, kept below the native hint
  // and finish-time announcer at the top of the screen.
  banner?: HTMLElement;
  downtime?: HTMLElement;
}
const topParts = '.hint-ui .title,.hint-ui .subtitle,.time-announcer-ui > *';
interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
// Reserve only native panels that actually share this overlay's horizontal lane.
// Timer and toolbar wrappers span empty space, so measure their visible pieces.
const nativeParts =
  '.game-toolbar-ui > .button-container,.game-toolbar-ui > .info-container,.timer-ui > .left,.timer-ui > .center,.timer-ui > .right,.checkpoint-ui,.speedometer-ui';

export function edgeClearance(
  lane: Pick<Bounds, 'left' | 'right'>,
  obstacles: Bounds[],
  height: number,
  gap = 8,
) {
  let top = 0,
    bottom = 0;
  if (lane.right <= lane.left) return { top, bottom };
  for (const rect of obstacles) {
    if (
      rect.right <= lane.left ||
      rect.left >= lane.right ||
      rect.bottom <= 0 ||
      rect.top >= height
    )
      continue;
    if (rect.top < height / 2) top = Math.max(top, Math.ceil(rect.bottom + gap));
    else bottom = Math.max(bottom, Math.ceil(height - rect.top + gap));
  }
  return { top, bottom };
}

// Not So Weekly Shorts: the first top at or below base where an element of this height sits clear
// of every obstacle in its lane.
export function freeTop(lane: Pick<Bounds, 'left' | 'right'>, base: number, height: number, obstacles: Bounds[], gap = 8) {
  let top = base;
  for (let moved = true; moved; ) {
    moved = false;
    for (const rect of obstacles)
      if (rect.right > lane.left && rect.left < lane.right && rect.bottom + gap > top && rect.top < top + height + gap) {
        top = Math.ceil(rect.bottom + gap);
        moved = true;
      }
  }
  return top;
}

export function visibleHudRect(element: Element | null, styleOf = getComputedStyle) {
  if (!element) return null;
  for (
    let node: Element | null = element;
    node;
    node = node.parentElement ?? (node.getRootNode?.() as ShadowRoot | undefined)?.host ?? null
  ) {
    const style = styleOf(node);
    if (
      (node as HTMLElement).hidden ||
      style.display === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility)
    )
      return null;
    // Reserve a toolbar as soon as it starts appearing, and through its fade-out.
    if (Number(style.opacity) <= 0.01 && !node.classList.contains('visible')) return null;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

export function layoutCupHud({
  hud,
  povHud,
  povRecordHud,
  inputHud,
  practiceHud,
  notice,
  roundTimer,
  banner,
  downtime,
}: HudElements) {
  const native = [...document.querySelectorAll(nativeParts)]
    .map((e) => visibleHudRect(e))
    .filter((rect): rect is DOMRect => rect !== null);
  // Measurements are in window pixels; the scaled layer wants its own (the input HUD is outside it).
  const scale = uiScale();
  const set = (element: HTMLElement, property: string, measured: number) => {
    const value = element === inputHud ? measured : Math.round(measured / scale);
    if (element.style.getPropertyValue(property) !== `${value}px`)
      element.style.setProperty(property, `${value}px`);
  };
  const placed = [];
  for (const element of [povHud, povRecordHud, inputHud, practiceHud, notice, roundTimer]) {
    if (!element) continue;
    const clearance = edgeClearance(
      element.getBoundingClientRect(),
      [...native, ...placed],
      innerHeight,
    );
    set(element, '--pwc-bottom', clearance.bottom);
    const rect = visibleHudRect(element);
    if (rect) placed.push(rect);
  }
  const above: Bounds[] = [...native, ...[...document.querySelectorAll(topParts)].map((e) => visibleHudRect(e)).filter((rect): rect is DOMRect => rect !== null)];
  for (const [element, base] of [[banner, 0.18], [downtime, 0.27]] as const) {
    if (!element || element.hidden) continue;
    const lane = element.getBoundingClientRect();
    const top = freeTop(lane, Math.round(innerHeight * base), lane.height, above);
    set(element, '--pwc-top', top);
    above.push({ left: lane.left, right: lane.right, top, bottom: top + lane.height });
  }
  const overlayRects = [povHud, povRecordHud, inputHud, practiceHud]
    .map((e) => visibleHudRect(e))
    .filter((rect): rect is DOMRect => rect !== null);
  const clearance = edgeClearance(
    hud.getBoundingClientRect(),
    [...native, ...overlayRects],
    innerHeight,
  );
  const oldTop = parseFloat(hud.style.getPropertyValue('--pwc-hud-top')) || 0;
  hud.classList.toggle('settling', Math.round(clearance.top / scale) < oldTop);
  set(hud, '--pwc-hud-top', clearance.top);
  set(hud, '--pwc-hud-bottom', Math.max(60, clearance.bottom));
}
