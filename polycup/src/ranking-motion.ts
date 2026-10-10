export interface RankingPosition {
  top: number;
  order: number;
  moving: boolean;
}
export function rankingPositions(root: ShadowRoot) {
  const positions = new Map<string, RankingPosition>();
  for (const row of root.querySelectorAll<HTMLElement>('[data-ranking-row]')) {
    if (!row.getClientRects().length) continue;
    positions.set(row.dataset.rankingRow!, {
      top: row.getBoundingClientRect().top,
      order: Number(row.dataset.rankingOrder),
      moving: row.getAnimations().some((animation) => animation.playState === 'running'),
    });
  }
  return positions;
}
export function animateRanking(root: ShadowRoot, before: Map<string, RankingPosition>) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const row of root.querySelectorAll<HTMLElement>('[data-ranking-row]')) {
    const old = before.get(row.dataset.rankingRow!);
    if (
      !old ||
      !row.getClientRects().length ||
      (old.order === Number(row.dataset.rankingOrder) && !old.moving)
    )
      continue;
    const delta = old.top - row.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
      duration: 260,
      easing: 'cubic-bezier(.2,.7,.25,1)',
    });
  }
}
