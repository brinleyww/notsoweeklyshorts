import type { CupUI } from './ui.ts';
import { element as h } from './dom.ts';
import { banTurn, banEntries } from './draft.ts';
import { chosenTracks, picksComplete } from './cup.ts';
import { rulesFor } from './presets.ts';
import type { CupState } from './types.ts';
export function countryFlag(code: unknown) {
  return typeof code === 'string' && /^[a-z]{2}$/i.test(code)
    ? 'images/countries/' + code.toLowerCase() + '.svg'
    : null;
}
export function lobbyView(s: CupState, selfId: number, editing = false) {
  const stage = s.draft?.stage ?? 'picks',
    joined = s.roster.some((p) => p.id === selfId);
  const turn = banTurn(s),
    pick = s.tracks.find((t) => t.id === s.picks[selfId]);
  const mode =
    stage === 'roster'
      ? 'join'
      : stage === 'bans'
        ? 'ban'
        : !joined
          ? 'spectator'
          : pick && picksComplete(s, selfId) && !editing
            ? 'selected'
            : 'pick';
  return {
    stage,
    joined,
    turn,
    pick,
    mode,
    ready: s.roster.filter((p) => picksComplete(s, p.id)).length,
    title:
      mode === 'join'
        ? joined
          ? 'You’re on the grid'
          : 'Join the race'
        : mode === 'ban'
          ? turn === selfId
            ? 'Your ban'
            : `${s.roster.find((p) => p.id === turn)?.name ?? 'Racer'}’s ban`
          : mode === 'selected'
            ? rulesFor(s).picksPerRacer > 1
              ? 'Your picks are ready'
              : 'Your pick is ready'
            : mode === 'pick'
              ? 'Choose your track'
              : 'Racers are picking',
  };
}
export function lobbyPanel(ui: CupUI) {
  const c = ui.c,
    s = c.state!,
    view = lobbyView(s, c.selfId!, ui.editingPick);
  const shell = h('section', undefined, 'cup-lobby'),
    roster = h('aside', undefined, 'lobby-roster'),
    action = h('section', undefined, 'lobby-action');
  roster.setAttribute('aria-label', 'Racer roster');
  action.setAttribute('aria-label', 'Current lobby action');
  const preset = ui.presetPanel(),
    rules = rulesFor(s);
  const heading = h('div', undefined, 'lobby-roster-heading');
  heading.append(h('h2', `Racers · ${s.roster.length}/8`));
  roster.append(heading);
  const order = s.draft?.order.length ? s.draft.order : s.roster.map((p) => p.id);
  if (!order.length) roster.append(h('p', 'No racers yet.', 'muted'));
  for (const id of order) {
    const row = h(
      'div',
      undefined,
      `lobby-racer${view.turn === id ? ' current-turn' : ''}${id === c.selfId ? ' you' : ''}`,
    );
    const identity = ui.racerName(id, ui.name(id), true);
    const car = identity.querySelector('.car-skin');
    if (car) row.append(car);
    row.append(identity, ui.playerTools(id));
    if (!c.lobby.some((p) => p.id === id) || c.needsRebind?.has(id))
      row.append(h('small', 'Disconnected', 'ban-label'));
    const bans = banEntries(s).filter((b) => b.racerId === id),
      picks = s.tracks.filter((t) => chosenTracks(s, id).includes(t.id));
    const choices = h('div', undefined, 'lobby-choices');
    if (s.draft && rules.bansPerRacer && view.stage !== 'roster') {
      for (const ban of bans) choices.append(h('span', `× ${ban.track.name}`, 'draft-ban'));
      if (view.turn === id) choices.append(h('span', 'Banning…', 'draft-ban'));
    }
    if (view.stage === 'picks') {
      for (const pick of picks) choices.append(h('span', `✓ ${pick.name}`, 'draft-pick'));
      if (!picksComplete(s, id))
        choices.append(h('span', `${picks.length}/${rules.picksPerRacer} picks`, 'muted'));
    }
    row.append(choices);
    roster.append(row);
  }
  if (view.mode === 'join') {
    const join = ui.button(
      view.joined ? 'Joined' : 'Join',
      () => c.action('join'),
      view.joined ? 'quiet' : 'primary',
    );
    join.disabled = view.joined || s.roster.length >= 8;
    roster.append(join);
  }
  const spectators = c.lobby.filter((p) => !s.roster.some((r) => r.id === p.id));
  const more = h('section', undefined, 'lobby-spectators');
  more.append(h('h2', `Spectators · ${spectators.length}`));
  if (!spectators.length) more.append(h('p', 'No spectators.', 'muted'));
  for (const p of spectators) {
    const row = h('div', undefined, `lobby-racer${p.id === c.selfId ? ' you' : ''}`);
    const identity = ui.racerName(p.id, p.nickname, true),
      car = identity.querySelector('.car-skin');
    if (car) row.append(car);
    row.append(identity, ui.playerTools(p.id));
    more.append(row);
  }
  if (view.mode === 'join') {
    const spectate = ui.button(
      view.joined ? 'Spectate' : 'Spectating',
      () => c.action('leave'),
      'quiet',
    );
    spectate.disabled = !view.joined;
    more.append(spectate);
  }
  roster.append(more);
  const actionTitle = h('h2', view.title);
  if (view.mode === 'ban' && view.turn !== c.selfId && view.turn !== null) {
    actionTitle.replaceChildren(ui.playerLabel(view.turn, ui.name(view.turn), true), '’s ban');
  }
  if (view.mode !== 'join') action.append(actionTitle);
  if (!s.draft && !view.joined) action.append(ui.joinControls());
  if (view.mode === 'join') {
    if (c.isHost) {
      const begin = ui.button(
        rules.selection === 'random'
          ? c.startingCup
            ? 'Preparing tracks…'
            : 'Start Cup'
          : rules.bansPerRacer
            ? 'Begin bans'
            : 'Begin picks',
        () => (rules.selection === 'random' ? c.startCup() : c.beginBans()),
        'primary',
      );
      begin.disabled = s.roster.length < 2 || ui.presetDirty || !!c.startingCup;
      begin.dataset.setupStart = '';
      if (s.roster.length < 2)
        roster.append(h('p', 'At least two racers are needed to begin.', 'muted'));
      ui.setLobbyStart(begin);
    } else
      roster.append(
        h(
          'p',
          `Waiting for the organizer to ${rules.selection === 'random' ? 'start the Cup' : rules.bansPerRacer ? 'begin bans' : 'begin picks'}.`,
          'muted',
        ),
      );
  } else if (view.mode === 'selected') {
    for (const picked of s.tracks.filter((t) => chosenTracks(s, c.selfId!).includes(t.id))) {
      const card = h('div', undefined, 'selected-track');
      card.append(h('strong', picked.name));
      try {
        const entry = c.availableTracks().find((t) => t.id === picked.id);
        if (entry) {
          const image = h('img');
          image.alt = '';
          Promise.resolve(entry.thumbnail)
            .then((src) => {
              if (src && image.isConnected) image.src = src;
            })
            .catch(() => {});
          card.prepend(image);
        }
      } catch {}
      action.append(card);
    }
    action.append(
      ui.button(
        rules.picksPerRacer > 1 ? 'Edit picks' : 'Change pick',
        () => ui.editPick(true),
        'quiet',
      ),
    );
    if (!c.isHost)
      action.append(
        h('p', 'You’re ready. The organizer starts the Cup once everyone has picked.', 'muted'),
      );
    action.append(h('p', `${view.ready}/${s.roster.length} racers have picked`, 'muted'));
  } else if (view.mode === 'ban' || view.mode === 'pick') {
    if (view.mode === 'ban')
      action.append(
        h(
          'p',
          `Ban ${banEntries(s).length + 1}/${s.roster.length * rules.bansPerRacer}`,
          'lobby-turn-count',
        ),
      );
    if (view.pick && picksComplete(s, c.selfId!))
      action.append(
        ui.button(
          rules.picksPerRacer > 1 ? 'Done editing' : 'Keep current pick',
          () => {
            ui.editPick(false);
          },
          'quiet',
        ),
      );
    if (view.mode === 'pick' && rules.picksPerRacer > 1) {
      for (const track of s.tracks.filter((t) => chosenTracks(s, c.selfId!).includes(t.id))) {
        const row = h('div', undefined, 'row');
        row.append(
          h('span', `✓ ${track.name}`, 'grow'),
          ui.button(
            'Remove',
            () => c.action('remove-pick', track.id),
            'quiet',
            `remove-pick:${track.id}`,
          ),
        );
        action.append(row);
      }
      action.append(
        h('p', `${chosenTracks(s, c.selfId!).length}/${rules.picksPerRacer} picks`, 'muted'),
      );
    }
    ui.renderTrackChoices(action);
  } else action.append(h('p', `${view.ready}/${s.roster.length} racers have picked`, 'muted'));
  if (c.isHost && view.stage === 'picks') {
    const start = ui.button(
      c.startingCup ? 'Preparing tracks…' : 'Start Cup',
      () => c.startCup(),
      'primary lobby-start',
    );
    start.disabled =
      !!c.startingCup || s.roster.length < 2 || view.ready !== s.roster.length || ui.presetDirty;
    ui.setLobbyStart(start);
  }
  if (view.mode === 'join') preset.classList.add('preset-at-top');
  action.append(preset);
  shell.append(roster, action);
  return shell;
}
