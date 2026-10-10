export interface HudElements {
  hud: HTMLElement;
  povHud: HTMLElement;
  povRecordHud: HTMLElement;
  inputHud: HTMLElement;
  practiceHud: HTMLElement;
  notice: HTMLElement;
  roundTimer?: HTMLElement;
}
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
}: HudElements) {
  const native = [...document.querySelectorAll(nativeParts)]
    .map((e) => visibleHudRect(e))
    .filter((rect): rect is DOMRect => rect !== null);
  const set = (element: HTMLElement, property: string, value: number) => {
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
  const overlayRects = [povHud, povRecordHud, inputHud, practiceHud]
    .map((e) => visibleHudRect(e))
    .filter((rect): rect is DOMRect => rect !== null);
  const clearance = edgeClearance(
    hud.getBoundingClientRect(),
    [...native, ...overlayRects],
    innerHeight,
  );
  const oldTop = parseFloat(hud.style.getPropertyValue('--pwc-hud-top')) || 0;
  hud.classList.toggle('settling', clearance.top < oldTop);
  set(hud, '--pwc-hud-top', clearance.top);
  set(hud, '--pwc-hud-bottom', Math.max(60, clearance.bottom));
}
