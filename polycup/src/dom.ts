export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string | number,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
// Not So Weekly Shorts: the game's UI scale (1 on large windows), which PolyCup's layer also uses.
export function uiScale() {
  return parseFloat(document.documentElement.style.getPropertyValue('--ui-scale-factor')) || 1;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
