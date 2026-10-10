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
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
