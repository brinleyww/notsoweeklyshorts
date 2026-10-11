import { element as h } from './dom.ts';
import { fullRules, type CupRules } from './presets.ts';

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
  // Not So Weekly Shorts: knockout, time attack, time limits, track votes and collisions.
  const r = fullRules(rules);
  group('Race', [
    ['Rounds per track', String(r.roundsPerTrack)],
    ...(r.knockout
      ? ([['Knockout', `${r.knockout} out per round`], ['To win', 'Be the last racer in']] as [string, string][])
      : ([
          [r.finalist ? 'Finalist target' : 'Points to win', String(r.pointsToWin)],
          ['To win', r.finalist ? 'Reach the target, then win a round' : 'Lead at the target'],
        ] as [string, string][])),
    ['Rounds', r.roundStyle === 'time-attack' ? `Time attack, ${r.timeAttackSeconds}s, best run counts` : 'One run each'],
    ['Time limit', r.roundStyle === 'time-attack' ? '—' : r.roundTimeLimit === 'off' ? 'None' : r.roundTimeLimit === 'fixed' ? `${r.roundTimeSeconds}s` : 'Auto'],
    ['Collisions', r.collisions ? 'On · times don’t count anywhere' : 'Off'],
    ['Leaderboard uploads', r.collisions ? 'Off' : r.uploadLeaderboardTimes ? 'On · reviewed by Race Control' : 'Off · cup only'],
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
  else
    tracks.push([
      'Next track',
      { random: 'Random', vote: 'Racers vote', winner: 'Round winner picks', last: 'Last place picks' }[r.nextTrack],
    ]);
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
  racers.push([
    'Spectator free camera',
    rules.allowSpectatorFreecam !== false ? 'Allowed' : 'Disabled',
  ]);
  group('Racers', racers);

  if (r.knockout) return summary;
  const scoring = h('table', undefined, 'rule-points');
  scoring.append(h('caption', 'Points by finishing position'));
  const body = h('tbody');
  // Not So Weekly Shorts: 25 places, in rows of 9.
  for (let start = 0; start < rules.points.length; start += 9) {
    const places = h('tr'),
      points = h('tr');
    rules.points.slice(start, start + 9).forEach((value, i) => {
      const index = start + i,
        place = h('th', `${index + 1}${['st', 'nd', 'rd'][index] ?? 'th'}`);
      place.scope = 'col';
      places.append(place);
      points.append(h('td', String(value)));
    });
    body.append(places, points);
  }
  scoring.append(body);
  summary.append(scoring);
  return summary;
}
