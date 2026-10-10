import { element as h } from './dom.ts';
import type { CupRules } from './presets.ts';

export function presetSummary(rules: CupRules) {
  const summary = h('div', undefined, 'preset-overview');
  const group = (title: string, entries: [string, string][]) => {
    const section = h('section', undefined, 'rule-group');
    section.setAttribute('aria-label', `${title} rules`);
    section.append(h('h3', title));
    const list = h('dl');
    for (const [label, value] of entries) {
      const row = h('div', undefined, 'rule-pair');
      row.append(h('dt', `${label}:`), h('dd', value));
      list.append(row);
    }
    section.append(list);
    summary.append(section);
  };
  group('Race', [
    ['Rounds per track', String(rules.roundsPerTrack)],
    [rules.finalist ? 'Finalist target' : 'Points to win', String(rules.pointsToWin)],
    ['Finalist', rules.finalist ? 'Enabled' : 'Disabled'],
    ['To win', rules.finalist ? 'Win as a finalist' : 'Lead at the target'],
    ['Leaderboard uploads', rules.uploadLeaderboardTimes ? 'On · Casual' : 'Off · Competitive'],
  ]);
  const tracks: [string, string][] = [
    ['Selection', rules.selection === 'random' ? 'Random rotation' : 'Racer draft'],
    [
      'Pool',
      // Not So Weekly Shorts: the pool the host picked before the room opened.
      (window as unknown as { __nswsCupPoolLabel?: () => string }).__nswsCupPoolLabel?.() ??
        'Not So Weekly Shorts',
    ],
    ['Custom tracks', rules.pool.includes('custom') ? 'Allowed' : 'Disabled'],
  ];
  if (rules.selection === 'draft')
    tracks.push(
      ['Bans per racer', String(rules.bansPerRacer)],
      ['Picks per racer', String(rules.picksPerRacer)],
    );
  else tracks.push(['Bans / picks', 'None']);
  group('Tracks', tracks);
  const timing: [string, string][] = [
    [
      'Warmup',
      rules.warmup === 'off'
        ? 'Disabled'
        : rules.warmup === 'first-visit'
          ? 'First visit only'
          : 'Every visit',
    ],
  ];
  if (rules.warmup !== 'off') {
    timing.push([
      'Duration',
      rules.warmupTiming === 'fixed'
        ? `${rules.warmupSeconds}s`
        : `${rules.warmupMultiplier}× WR, min. ${rules.warmupMinimumSeconds}s`,
    ]);
    if (rules.warmupTiming === 'wr') timing.push(['Without a WR', `${rules.warmupSeconds}s`]);
    timing.push(['End warmup early', rules.readyEndsWarmup ? 'All racers ready' : 'Disabled']);
  }
  timing.push(
    ['Finish window', `${rules.finishTimeoutSeconds}s`],
    ['Round break', `${rules.roundBreakSeconds}s`],
  );
  group('Timing', timing);
  const racers: [string, string][] = [
    ['Mid-Cup changes', rules.allowRacerChanges ? 'Allowed' : 'Locked'],
  ];
  if (rules.allowRacerChanges)
    racers.push(['New racers', '0 points, next round'], ['Returning racers', 'Score retained']);
  else racers.push(['Reconnection', 'Score retained']);
  group('Racers', racers);

  const scoring = h('table', undefined, 'rule-points');
  scoring.append(h('caption', 'Points by finishing position'));
  const head = h('thead'),
    places = h('tr'),
    body = h('tbody'),
    points = h('tr');
  rules.points.forEach((value, index) => {
    const place = h('th', `${index + 1}${['st', 'nd', 'rd'][index] ?? 'th'}`);
    place.scope = 'col';
    places.append(place);
    points.append(h('td', String(value)));
  });
  head.append(places);
  body.append(points);
  scoring.append(head, body);
  summary.append(scoring);
  return summary;
}
