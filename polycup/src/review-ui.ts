import type { CupUI } from './ui.ts';
import { element as h } from './dom.ts';
import { evidenceStatus } from './review.ts';
import { formatGap, formatTime } from './time.ts';
export function reviewPanel(ui: CupUI) {
  const c = ui.c,
    log = c.review,
    box = h('section', undefined, 'review-panel');

  box.append(
    h('h2', 'Run review'),
    h('p', 'Private · saved with Cup exports', 'muted'),
    h(
      'p',
      'Inputs are client-reported. Flags prompt a review; they never apply penalties.',
      'review-disclaimer',
    ),
  );
  const flags = log.runs.filter((r) => r.flag),
    controls = h('div', undefined, 'controls');
  controls.append(
    h('strong', `${flags.filter((r) => !r.reviewed).length} to review`),
    ui.button(
      'Export review log',
      () => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(log.data(), null, 2)], { type: 'application/json' }),
        );
        const a = h('a');
        a.href = url;
        a.download = 'polycup-review.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      'quiet',
    ),
  );
  box.append(controls);
  const records = [...log.runs]
    .reverse()
    .sort((a, b) => Number(!!b.flag && !b.reviewed) - Number(!!a.flag && !a.reviewed));
  if (!records.length) box.append(h('p', 'No scored runs yet.', 'muted'));
  for (const r of records) {
    const detail = h('details', undefined, `review-run${r.flag ? ' flagged' : ''}`);
    detail.open = ui.reviewExpanded.has(r.id);
    detail.addEventListener('toggle', () => {
      if (!detail.isConnected) return;
      detail.open ? ui.reviewExpanded.add(r.id) : ui.reviewExpanded.delete(r.id);
    });
    const summary = h('summary'),
      title = h('span', undefined, 'review-title');
    title.append(
      ui.playerLabel(
        Number(Object.entries(log.data().identities).find(([, key]) => key === r.racerKey)?.[0]),
        r.name,
      ),
      h(
        'span',
        `Round ${r.round} · ${c.cup.tracks.find((t) => t.id === r.trackId)?.name ?? 'Track'}`,
        'muted',
      ),
    );
    summary.append(
      title,
      h('span', r.finish ? formatTime(r.finish) : r.outcome.toUpperCase()),
      h(
        'span',
        r.flag ? (r.reviewed ? 'Reviewed' : 'Review') : evidenceStatus(r),
        r.flag ? 'review-tag' : 'muted',
      ),
    );
    detail.append(summary);
    if (r.flag) {
      const prior = log.runs.find((p) => p.id === r.flag!.otherId);
      detail.append(
        h(
          'p',
          r.flag.kind === 'inputs'
            ? `${r.flag.transitions} control changes match round ${prior?.round ?? '—'} within ${r.flag.maxDelta} ms.`
            : `${r.flag.repeats} runs share every checkpoint time and finish. Input evidence is incomplete or differs.`,
        ),
      );
      detail.append(
        ui.button(
          r.reviewed ? 'Mark unreviewed' : 'Mark reviewed',
          () => {
            log.markReviewed(r.id, !r.reviewed);
            c.save(true);
          },
          'quiet',
        ),
      );
      if (prior) {
        const table = h('table', undefined, 'review-splits'),
          heading = h('tr');
        for (const label of [
          'Checkpoint',
          `Round ${prior.round}`,
          `Round ${r.round}`,
          'Difference',
        ])
          heading.append(h('th', label));
        const head = h('thead');
        head.append(heading);
        table.append(head);
        const body = h('tbody');
        for (const [index, frames] of [...r.checkpoints, ['Finish', r.finish] as const]) {
          const other =
            index === 'Finish' ? prior.finish : prior.checkpoints.find((e) => e[0] === index)?.[1];
          const row = h('tr');
          for (const value of [
            typeof index === 'number' ? index + 1 : index,
            other ? formatTime(other) : '—',
            frames ? formatTime(frames) : '—',
            other && frames
              ? `${frames < other ? '−' : ''}${formatGap(Math.abs(frames - other))}`.replace(
                  '−+',
                  '−',
                )
              : '—',
          ])
            row.append(h('td', value));
          body.append(row);
        }
        table.append(body);
        detail.append(table);
      }
    }
    detail.append(
      h(
        'p',
        `${evidenceStatus(r)} · ${r.inputs.length} input samples · ${r.checkpoints.length}/${r.expectedCheckpoints} checkpoints · ${r.outcome}`,
        'muted',
      ),
    );
    box.append(detail);
  }
  if (log.dropped)
    box.append(h('p', `${log.dropped} older runs removed by the log size limit.`, 'muted'));
  return box;
}
