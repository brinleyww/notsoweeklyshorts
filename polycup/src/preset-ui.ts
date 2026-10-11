import { element as h } from './dom.ts';
import { presetSummary } from './preset-summary.ts';
import { rosterOpen } from './draft.ts';
import type { CupUI } from './ui.ts';
import {
  PresetLibrary,
  bundledPresets,
  isBundledName,
  parsePreset,
  presetProblems,
  presetText,
  presetKey,
  quickplayPreset,
  rulesFor,
  standardPreset,
  validPreset,
  type CupPreset,
  type FullRules,
} from './presets.ts';

// Not So Weekly Shorts: every option explains itself on screen (tooltips don't work on touch), a
// wrong value is marked on its own field, and the tool buttons have text labels.
const HINTS: Partial<Record<keyof FullRules, string>> = {
  roundsPerTrack: 'Rounds raced on a track before the next one.',
  finalist: 'Reach the target to become a finalist, then win a round to take the cup.',
  uploadLeaderboardTimes: 'On: personal bests set in the cup go to the leaderboards (Race Control reviews them first). Off: cup times stay in the cup.',
  selection: 'Random: the cup draws tracks from the room’s maps. Draft: each racer bans and picks tracks first.',
  nextTrack: 'How the next random track is chosen when a track is done.',
  roundStyle: 'Single: one run, a restart retires you. Time attack: unlimited runs in a time window, your best counts.',
  knockout: 'Racers knocked out after every round (no finish goes first). The last one in wins.',
  roundTimeLimit: 'Ends a round nobody can finish. Auto: three times the best known time, 1 to 10 minutes.',
  collisions: 'Cars bump into each other. Times never count as personal bests, upload, or go to review.',
  finishTimeoutSeconds: 'Time for everyone else to finish after the first racer does.',
  roundBreakSeconds: 'Pause between rounds.',
  allowRacerChanges: 'Players can join or leave between rounds. New racers start on 0 points.',
  allowSpectatorFreecam: 'Let spectators fly around the track. Turn off for puzzle or discovery maps.',
  readyEndsWarmup: 'Warmup ends early once every racer presses Ready.',
};

export class PresetEditor {
  #ui: CupUI;
  #library = new PresetLibrary();
  #draft: CupPreset = standardPreset();
  #cupId = '';
  #base = '';
  #renaming = false;
  #renameValue = '';
  #applyTimer: ReturnType<typeof setTimeout> | undefined;
  #panel?: HTMLElement;
  constructor(ui: CupUI) {
    this.#ui = ui;
  }
  get dirty() {
    return presetKey(this.#draft) !== this.#base;
  }

  render() {
    const ui = this.#ui,
      c = ui.c,
      state = c.cup;
    const current = state.preset ?? {
      ...standardPreset(),
      name: 'Imported rules',
      rules: rulesFor(state),
    };
    if (this.#cupId !== state.id) {
      this.#renaming = false;
      clearTimeout(this.#applyTimer);
    }
    if (this.#cupId !== state.id || !this.dirty) {
      this.#cupId = state.id;
      this.#draft = structuredClone(current);
      this.#base = presetKey(current);
    }
    const editable = c.isHost && rosterOpen(state),
      box = h('section', undefined, 'preset-panel');
    this.#panel = box;
    box.setAttribute('aria-label', 'Cup preset');
    const heading = h('div', undefined, 'preset-heading');
    heading.append(h('h2', editable ? 'Cup format' : current.name));
    if (!editable) {
      const details = h('section', undefined, 'preset-details');
      details.append(h('h3', `${current.name} · Cup rules`));
      details.append(presetSummary(rulesFor(state)));
      box.append(details);
      if (!rulesFor(state).finalist && !rulesFor(state).knockout)
        details.append(h('p', 'A tied lead at the target continues into another round.', 'muted'));
      const footer = h('div', undefined, 'preset-tools');
      details.append(ui.button('Export preset', () => this.download(current), 'quiet'));
      if (c.isHost && state.phase === 'registration')
        footer.append(
          ui.button(
            'Reopen setup',
            ui.confirmed('Reopen setup and clear all bans and picks?', 'Reopen setup', () => c.reopenRoster()),
            'quiet',
          ),
        );
      if (footer.childElementCount) box.append(footer);
      return box;
    }
    const r = this.#draft.rules as FullRules;
    const select = h('select');
    select.setAttribute('aria-label', 'Choose a preset');
    const presets = [...bundledPresets(), ...this.#library.list()];
    const selected = presets.findIndex((p) => presetKey(p) === presetKey(this.#draft));
    {
      const option = h('option', selected < 0 ? this.#draft.name || 'Custom' : 'Custom');
      option.hidden = selected >= 0;
      option.value = 'custom';
      option.disabled = true;
      option.selected = selected < 0;
      select.append(option);
    }
    presets.forEach((preset, i) => {
      const option = h('option', preset.name);
      option.value = String(i);
      option.selected = i === selected;
      select.append(option);
    });
    select.addEventListener('change', () => {
      if (select.value === 'custom') return;
      this.#renaming = false;
      this.#draft = structuredClone(presets[Number(select.value)]);
      this.applyDraft();
    });
    const chooser = h('div', undefined, 'preset-chooser');
    const nameControl = h('div', undefined, 'preset-name-control');
    if (this.#renaming) {
      const name = h('input');
      name.value = this.#renameValue;
      name.maxLength = 64;
      name.setAttribute('aria-label', 'Preset name');
      name.dataset.presetField = 'name';
      name.addEventListener('input', () => {
        this.#renameValue = name.value;
      });
      nameControl.append(name);
    } else nameControl.append(select);
    chooser.append(nameControl);
    heading.append(chooser);
    box.append(heading, h('p', presetBlurb(r), 'preset-blurb'));
    box.append(this.editableRules(r));
    const file = h('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.addEventListener('change', async () => {
      try {
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > 32000) throw new Error('Preset files must be smaller than 32 KB.');
        const preset = parsePreset(await selected.text());
        if (c.state !== state || !rosterOpen(state))
          throw new Error('The Cup changed. Import the preset again during setup.');
        this.#draft = preset;
        this.applyDraft();
      } catch (error) {
        c.fail(error);
      }
    });
    const tool = (
      kind: 'save' | 'import' | 'export' | 'delete' | 'edit' | 'check',
      text: string,
      label: string,
      action: () => void,
    ) => {
      const button = ui.button(label, action, 'quiet preset-tool');
      button.replaceChildren(presetIcon(kind), h('span', text));
      button.setAttribute('aria-label', label);
      return button;
    };
    const tools = h('div', undefined, 'preset-tools-row');
    const rename = tool(
      this.#renaming ? 'check' : 'edit',
      this.#renaming ? 'Done' : 'Rename',
      this.#renaming ? 'Apply preset name' : 'Rename preset',
      () => (this.#renaming ? this.finishRename() : this.beginRename()),
    );
    const save = tool('save', 'Save', 'Save preset', () => {
      if (this.#renaming) this.finishRename();
      if (isBundledName(this.#draft.name) || ['custom', ''].includes(this.#draft.name.trim().toLowerCase())) {
        this.beginRename();
        ui.showNotice('Name your preset, then save it.', 3500);
        const input = this.#panel?.querySelector<HTMLInputElement>('[data-preset-field="name"]');
        input?.focus();
        input?.select();
        return;
      }
      this.#draft.name = this.#draft.name.trim();
      this.#library.save(this.#draft);
      this.applyDraft();
      ui.showNotice(`Saved ${this.#draft.name}`, 2500);
    });
    const remove = tool('delete', 'Delete', 'Delete saved preset', () => {
      if (!this.#library.list().some((p) => p.name === this.#draft.name)) return;
      this.#library.remove(this.#draft.name);
      this.#draft = quickplayPreset();
      this.applyDraft();
      ui.showNotice('Preset deleted. Quickplay rules applied.', 3000);
    });
    remove.dataset.deletePreset = '';
    remove.disabled = !this.#library.list().some((p) => p.name === this.#draft.name);
    const exportButton = tool('export', 'Export', 'Export preset', () => this.download(this.#draft));
    save.dataset.validPreset = '';
    exportButton.dataset.validPreset = '';
    save.disabled = exportButton.disabled = !validPreset(this.#draft);
    tools.append(rename, save, tool('import', 'Import', 'Import preset', () => file.click()), exportButton, remove, file);
    box.append(tools);
    const status = h('p', '', 'preset-status');
    status.setAttribute('role', 'status');
    box.append(status);
    queueMicrotask(() => this.sync());
    return box;
  }
  editableRules(r: FullRules) {
    const overview = h('div', undefined, 'preset-overview preset-editable');
    const columns = h('div', undefined, 'rule-columns');
    const group = (title: string) => {
      const section = h('section', undefined, 'rule-group');
      section.setAttribute('aria-label', `${title} rules`);
      section.append(h('h3', title));
      columns.append(section);
      return section;
    };
    const field = (section: HTMLElement, key: keyof FullRules, label: string, input: HTMLElement, disabled = false) => {
      const row = h('label', undefined, 'rule-edit');
      row.dataset.rule = key;
      row.append(h('strong', `${label}:`), input);
      input.setAttribute('aria-label', label);
      if (disabled) (input as HTMLInputElement).disabled = true;
      const hint = HINTS[key];
      if (hint) row.append(h('small', hint, 'rule-hint'));
      row.append(h('small', '', 'rule-error'));
      section.append(row);
    };
    const checkbox = (key: 'finalist' | 'uploadLeaderboardTimes' | 'allowRacerChanges' | 'allowSpectatorFreecam' | 'readyEndsWarmup' | 'collisions') => {
      const input = h('input');
      input.type = 'checkbox';
      input.checked = r[key] === true;
      input.dataset.presetField = key;
      input.addEventListener('change', () => {
        r[key] = input.checked;
        this.changed();
      });
      return input;
    };
    const knockout = r.knockout > 0;
    const race = group('Scoring');
    if (!knockout) {
      field(race, 'pointsToWin', r.finalist ? 'Finalist target' : 'Points to win', this.number('pointsToWin', 1, 10000));
      field(race, 'finalist', 'Finalist', checkbox('finalist'));
    }
    field(race, 'knockout', 'Knock out per round', this.number('knockout', 0, 7));
    field(race, 'uploadLeaderboardTimes', 'Upload times', checkbox('uploadLeaderboardTimes'), r.collisions);
    const format = group('Rounds');
    field(
      format,
      'roundStyle',
      'Round style',
      this.select([['single', 'Single run'], ['time-attack', 'Time attack']], r.roundStyle, (v) => (r.roundStyle = v as FullRules['roundStyle'])),
    );
    if (r.roundStyle === 'time-attack') field(format, 'timeAttackSeconds', 'Time attack (s)', this.number('timeAttackSeconds', 30, 1800));
    else {
      field(
        format,
        'roundTimeLimit',
        'Time limit',
        this.select([['auto', 'Auto'], ['fixed', 'Fixed'], ['off', 'None']], r.roundTimeLimit, (v) => (r.roundTimeLimit = v as FullRules['roundTimeLimit'])),
      );
      if (r.roundTimeLimit === 'fixed') field(format, 'roundTimeSeconds', 'Limit (s)', this.number('roundTimeSeconds', 30, 1800));
      field(format, 'finishTimeoutSeconds', 'Finish window (s)', this.number('finishTimeoutSeconds', 5, 120));
    }
    field(format, 'roundBreakSeconds', 'Round break (s)', this.number('roundBreakSeconds', 3, 60));
    field(format, 'collisions', 'Player collisions', checkbox('collisions'));
    const tracks = group('Tracks');
    field(
      tracks,
      'selection',
      'Selection',
      this.select([['random', 'Random'], ['draft', 'Racer draft']], r.selection, (value) => {
        r.selection = value as FullRules['selection'];
        r.bansPerRacer = value === 'random' ? 0 : 1;
        r.picksPerRacer = value === 'random' ? 0 : 1;
        if (value === 'draft') r.nextTrack = 'random';
      }),
    );
    if (r.selection === 'random')
      field(
        tracks,
        'nextTrack',
        'Next track',
        this.select(
          [['random', 'Random'], ['vote', 'Racers vote'], ['winner', 'Round winner picks'], ['last', 'Last place picks']],
          r.nextTrack,
          (v) => (r.nextTrack = v as FullRules['nextTrack']),
        ),
      );
    field(tracks, 'roundsPerTrack', 'Rounds per track', this.number('roundsPerTrack', 1, 30));
    {
      const input = h('input');
      input.type = 'checkbox';
      input.checked = r.pool.includes('custom');
      input.dataset.trackCategory = 'custom';
      input.addEventListener('change', () => {
        r.pool = input.checked ? [...r.pool, 'custom'] : r.pool.filter((c) => c !== 'custom');
        this.changed();
      });
      field(tracks, 'pool', 'Custom tracks', input, r.bansPerRacer > 0);
    }
    if (r.selection === 'draft') {
      field(tracks, 'bansPerRacer', 'Bans per racer', this.number('bansPerRacer', 0, 3));
      field(tracks, 'picksPerRacer', 'Picks per racer', this.number('picksPerRacer', 1, 3));
    }
    const timing = group('Warmup');
    field(
      timing,
      'warmup',
      'Warmup',
      this.select([['off', 'None'], ['first-visit', 'First visit'], ['every-visit', 'Every visit']], r.warmup, (v) => (r.warmup = v as FullRules['warmup'])),
    );
    if (r.warmup !== 'off') {
      field(
        timing,
        'warmupTiming',
        'Length',
        this.select([['wr', 'Based on WR'], ['fixed', 'Fixed time']], r.warmupTiming, (v) => (r.warmupTiming = v as FullRules['warmupTiming'])),
      );
      if (r.warmupTiming === 'wr') {
        field(timing, 'warmupMultiplier', 'WR multiplier', this.number('warmupMultiplier', 0.5, 5, 0.1));
        field(timing, 'warmupMinimumSeconds', 'Minimum (s)', this.number('warmupMinimumSeconds', 10, 300));
      }
      field(timing, 'warmupSeconds', r.warmupTiming === 'fixed' ? 'Length (s)' : 'Without a WR (s)', this.number('warmupSeconds', 10, 600));
      field(timing, 'readyEndsWarmup', 'Ready ends warmup', checkbox('readyEndsWarmup'));
    }
    const racers = group('Racers');
    field(racers, 'allowRacerChanges', 'Join or leave mid-cup', checkbox('allowRacerChanges'), knockout);
    field(racers, 'allowSpectatorFreecam', 'Spectator free camera', checkbox('allowSpectatorFreecam'));
    overview.append(columns);
    if (!knockout) {
      const scoring = h('fieldset', undefined, 'preset-scoring rule-points-editor');
      scoring.append(h('legend', 'Points by finishing position'));
      r.points.forEach((points, i) => {
        const place = `${i + 1}${['st', 'nd', 'rd'][i] ?? 'th'}`,
          row = h('label', place),
          input = h('input');
        input.type = 'number';
        input.min = '0';
        input.max = '1000';
        input.step = '1';
        input.value = String(points);
        input.setAttribute('aria-label', `Points for ${place}`);
        input.dataset.presetField = `points-${i}`;
        input.addEventListener('input', () => {
          r.points[i] = input.valueAsNumber;
          this.changed(false);
        });
        row.append(input);
        scoring.append(row);
      });
      scoring.append(h('small', 'Places after 8th score 0 points.', 'rule-hint'), h('small', '', 'rule-error points-error'));
      overview.append(scoring);
    }
    return overview;
  }
  nameKey(event: KeyboardEvent) {
    if (!this.#renaming || event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.finishRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.#renaming = false;
      this.#ui.redraw();
    }
  }
  beginRename() {
    this.#renameValue = this.#draft.name;
    this.#renaming = true;
    this.#ui.redraw();
    const input = this.#panel?.querySelector<HTMLInputElement>('[data-preset-field="name"]');
    input?.focus();
    input?.select();
  }
  finishRename() {
    this.#draft.name = this.#renameValue.trim() || 'Custom';
    this.#renaming = false;
    this.applyDraft();
  }
  sync() {
    const panel = this.#panel;
    if (!panel) return;
    const problems = presetProblems(this.#draft),
      valid = !problems.length;
    for (const row of panel.querySelectorAll<HTMLElement>('[data-rule]')) {
      const problem = problems.find((p) => p.field === row.dataset.rule);
      const error = row.querySelector<HTMLElement>('.rule-error');
      if (error) error.textContent = problem?.message ?? '';
      row.querySelector('input,select')?.setAttribute('aria-invalid', String(!!problem));
    }
    const points = problems.find((p) => p.field.startsWith('points-'));
    const pointsError = panel.querySelector<HTMLElement>('.points-error');
    if (pointsError) pointsError.textContent = points?.message ?? '';
    for (const input of panel.querySelectorAll<HTMLInputElement>('[data-preset-field^="points-"]'))
      input.setAttribute('aria-invalid', String(problems.some((p) => p.field === input.dataset.presetField)));
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-valid-preset]'))
      button.disabled = !valid;
    const remove = panel.querySelector<HTMLButtonElement>('[data-delete-preset]');
    if (remove) remove.disabled = !this.#library.list().some((p) => p.name === this.#draft.name);
    const status = panel.querySelector<HTMLElement>('.preset-status');
    if (status) {
      status.textContent = this.dirty
        ? valid
          ? 'Updating rules…'
          : `Fix the marked field: ${problems[0].message}`
        : '';
      status.hidden = !this.dirty;
    }
    const select = panel.querySelector<HTMLSelectElement>('select[aria-label="Choose a preset"]');
    if (select && this.dirty) {
      select.value = 'custom';
      select.options[0].textContent = this.#draft.name || 'Custom';
      select.options[0].hidden = false;
    }
    const start = (panel.getRootNode() as ShadowRoot).querySelector<HTMLButtonElement>(
      '[data-setup-start]',
    );
    if (start) {
      start.disabled = this.#ui.c.cup.roster.length < 2 || this.dirty || !!this.#ui.c.startingCup;
      const note = (panel.getRootNode() as ShadowRoot).querySelector<HTMLElement>(
        '.setup-start-note',
      );
      if (note) {
        note.textContent =
          this.#ui.c.cup.roster.length < 2
            ? 'At least two racers are needed. Share the code to bring players in.'
            : this.dirty
              ? 'Finish editing the rules to continue.'
              : '';
        note.hidden = !note.textContent;
      }
    }
  }
  applyDraft() {
    clearTimeout(this.#applyTimer);
    if (!validPreset(this.#draft)) {
      this.#ui.redraw();
      return;
    }
    try {
      this.#ui.c.setPreset(this.#draft);
      this.#base = presetKey(this.#draft);
      this.#ui.redraw();
    } catch (error) {
      this.#ui.c.fail(error);
    }
  }
  scheduleApply() {
    clearTimeout(this.#applyTimer);
    if (!validPreset(this.#draft)) return;
    const cupId = this.#cupId;
    this.#applyTimer = setTimeout(() => {
      if (this.#ui.c.state?.id === cupId && rosterOpen(this.#ui.c.state)) this.applyDraft();
    }, 300);
  }
  changed(redraw = true) {
    clearTimeout(this.#applyTimer);
    this.#draft.name = 'Custom';
    const r = this.#draft.rules as FullRules;
    if (r.bansPerRacer > 0) {
      r.pool = r.pool.filter((category) => category !== 'custom');
      if (!r.pool.length) r.pool = ['official', 'community'];
    }
    // Options that rule each other out follow along instead of failing validation.
    if (r.collisions) r.uploadLeaderboardTimes = false;
    if (r.knockout > 0) {
      r.finalist = false;
      r.allowRacerChanges = false;
    }
    const name = this.#panel?.querySelector<HTMLInputElement>('[data-preset-field="name"]');
    if (name) name.value = 'Custom';
    if (redraw && validPreset(this.#draft)) this.applyDraft();
    else {
      if (redraw) this.#ui.redraw();
      else this.sync();
      this.scheduleApply();
    }
  }
  number(key: keyof FullRules, min: number, max: number, step = 1) {
    const input = h('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String((this.#draft.rules as FullRules)[key]);
    input.dataset.presetField = key;
    input.addEventListener('input', () => {
      Object.assign(this.#draft.rules, { [key]: input.valueAsNumber });
      this.changed(key === 'knockout');
    });
    return input;
  }
  select(options: string[][], value: string, change: (value: string) => void) {
    const select = h('select');
    for (const [v, label] of options) {
      const option = h('option', label);
      option.value = v;
      option.selected = v === value;
      select.append(option);
    }
    select.addEventListener('change', () => {
      change(select.value);
      this.changed();
    });
    return select;
  }
  download(preset: CupPreset) {
    const url = URL.createObjectURL(new Blob([presetText(preset)], { type: 'application/json' }));
    const a = h('a');
    a.href = url;
    a.download = `${preset.name.replace(/[^a-z0-9-]/gi, '-')}.polycup-preset.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
// A one-line description of the format, above the options.
export function presetBlurb(r: FullRules) {
  const parts: string[] = [];
  if (r.knockout) parts.push(`Knockout: the slowest ${r.knockout === 1 ? 'racer is' : `${r.knockout} racers are`} out after every round until one is left.`);
  else if (r.finalist) parts.push(`Reach ${r.pointsToWin} points to become a finalist, then win a round to take the cup.`);
  else parts.push(`First to ${r.pointsToWin} points wins.`);
  parts.push(r.roundStyle === 'time-attack' ? `Each round is a ${Math.round(r.timeAttackSeconds / 60 * 10) / 10}-minute time attack; your best run counts.` : 'One run per round.');
  parts.push(r.selection === 'draft' ? 'Racers draft the tracks.' : `${r.roundsPerTrack} round${r.roundsPerTrack === 1 ? '' : 's'} per random track.`);
  if (r.collisions) parts.push('Cars collide.');
  return parts.join(' ');
}
function presetIcon(kind: 'save' | 'import' | 'export' | 'delete' | 'edit' | 'check') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute(
    'd',
    {
      edit: 'M4 16l-1 5 5-1L21 7l-5-5z M13 5l6 6',
      check: 'M4 12l5 5L20 6',
      delete: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
      save: 'M4 3h13l3 3v15H4z M7 3v6h9V3 M7 21v-8h10v8',
      import: 'M4 15v6h16v-6 M12 16V3 M7 8l5-5 5 5',
      export: 'M4 15v6h16v-6 M12 3v13 M7 11l5 5 5-5',
    }[kind],
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
