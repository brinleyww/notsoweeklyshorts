import { element as h } from './dom.ts';
import { presetSummary } from './preset-summary.ts';
import { rosterOpen } from './draft.ts';
import type { CupUI } from './ui.ts';
import {
  PresetLibrary,
  parsePreset,
  presetText,
  presetKey,
  quickplayPreset,
  rulesFor,
  standardPreset,
  validPreset,
  type CupPreset,
  type CupRules,
} from './presets.ts';

export class PresetEditor {
  #ui: CupUI;
  #library = new PresetLibrary();
  #draft: CupPreset = standardPreset();
  #cupId = '';
  #base = '';
  #advanced = false;
  #customizing = false;
  #renaming = false;
  #renameValue = '';
  #applyTimer: ReturnType<typeof setTimeout> | undefined;
  #rulesStage = '';
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
    const rulesStage = `${state.id}:${state.phase === 'registration'}:${state.draft?.stage}`;
    const rulesOpen =
      this.#rulesStage === rulesStage
        ? this.#panel?.querySelector<HTMLDetailsElement>('.preset-details')?.open
        : undefined;
    this.#rulesStage = rulesStage;
    if (this.#cupId !== state.id) {
      this.#customizing = false;
      this.#renaming = false;
      clearTimeout(this.#applyTimer);
      this.#advanced = false;
    } else if (this.#panel) {
      this.#customizing =
        this.#panel.querySelector<HTMLDetailsElement>('.preset-customize')?.open ??
        this.#customizing;
      this.#advanced =
        this.#panel.querySelector<HTMLDetailsElement>('.preset-advanced')?.open ?? this.#advanced;
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
    heading.append(h('h2', editable ? 'Cup preset' : current.name));
    if (!editable) {
      const details = h('details', undefined, 'preset-details');
      details.open = rulesOpen ?? (state.phase === 'registration' && rosterOpen(state));
      details.append(h('summary', `${current.name} · Cup rules`));
      details.append(presetSummary(rulesFor(state)));
      box.append(details);
      if (!rulesFor(state).finalist)
        details.append(h('p', 'A tied lead at the target continues into another round.', 'muted'));
      const footer = h('div', undefined, 'preset-tools');
      details.append(ui.button('Export preset', () => this.download(current), 'quiet'));
      if (c.isHost && state.phase === 'registration')
        footer.append(
          ui.button(
            'Reopen setup',
            () => {
              if (confirm('Reopen setup and clear all bans and picks?')) c.reopenRoster();
            },
            'quiet',
          ),
        );
      if (footer.childElementCount) box.append(footer);
      return box;
    }
    const r = this.#draft.rules;
    const select = h('select');
    select.setAttribute('aria-label', 'Choose a preset');
    const presets = [standardPreset(), quickplayPreset(), ...this.#library.list()];
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
    box.append(heading);
    box.append(presetSummary(r));
    const customize = h('details', undefined, 'preset-customize');
    customize.open = this.#customizing;
    customize.addEventListener('toggle', () => {
      if (customize.isConnected) this.#customizing = customize.open;
    });
    customize.append(h('summary', 'Customize rules'));
    const grid = h('div', undefined, 'preset-fields');
    const field = (label: string, input: HTMLElement) => {
      const row = h('label', label);
      row.append(input);
      grid.append(row);
    };
    field('Rounds per track', this.number('roundsPerTrack', 1, 30));
    field(
      r.finalist ? 'Points for finalist' : 'Points to win',
      this.number('pointsToWin', 1, 10000),
    );
    field(
      'Win condition',
      this.select(
        [
          ['true', 'Finalist'],
          ['false', 'Highest score at target'],
        ],
        String(r.finalist),
        (v) => {
          r.finalist = v === 'true';
        },
      ),
    );
    field(
      'Track selection',
      this.select(
        [
          ['draft', 'Racer bans and picks'],
          ['random', 'Random map rotation'],
        ],
        r.selection,
        (v) => {
          r.selection = v as CupRules['selection'];
          if (v === 'random') {
            r.bansPerRacer = 0;
            r.picksPerRacer = 0;
          } else {
            r.bansPerRacer = 1;
            r.picksPerRacer = 1;
          }
        },
      ),
    );
    if (r.selection === 'draft') {
      field('Bans per racer', this.number('bansPerRacer', 0, 3));
      field('Picks per racer', this.number('picksPerRacer', 1, 3));
    }
    field(
      'Warmup',
      this.select(
        [
          ['off', 'Disabled'],
          ['first-visit', 'First visit to each track'],
          ['every-visit', 'Every track visit'],
        ],
        r.warmup,
        (v) => {
          r.warmup = v as CupRules['warmup'];
        },
      ),
    );
    const pool = h('fieldset', undefined, 'preset-pool');
    pool.append(h('legend', 'Track pool'));
    // Not So Weekly Shorts: the maps were picked before the room opened.
    pool.append(h('small', 'Maps come from the pool picked when the cup was hosted.', 'muted'));
    for (const [category, label] of [['custom', 'Allow custom tracks']] as const) {
      const row = h('label'),
        input = h('input');
      input.type = 'checkbox';
      input.checked = r.pool.includes(category);
      input.dataset.trackCategory = category;
      input.disabled = category === 'custom' && r.bansPerRacer > 0;
      if (category === 'custom')
        row.title =
          r.bansPerRacer > 0
            ? 'Set bans per racer to 0 to allow custom tracks.'
            : r.selection === 'random'
              ? 'Include the organizer’s saved custom tracks.'
              : 'Allow saved custom tracks and track share codes during picks.';
      input.addEventListener('change', () => {
        r.pool = input.checked ? [...r.pool, category] : r.pool.filter((c) => c !== category);
        this.changed();
      });
      row.append(input, label);
      pool.append(row);
    }
    const banHint = h(
      'small',
      'Set bans per racer to 0 to allow custom tracks.',
      'custom-ban-hint muted',
    );
    banHint.hidden = r.bansPerRacer === 0;
    pool.append(banHint);
    grid.append(pool);
    const membership = h('label', undefined, 'preset-join-rule'),
      allow = h('input');
    allow.type = 'checkbox';
    allow.checked = r.allowRacerChanges;
    allow.addEventListener('change', () => {
      r.allowRacerChanges = allow.checked;
      this.changed();
    });
    membership.append(allow, 'Allow mid-Cup racer changes');
    grid.append(membership);
    const uploads = h('label', undefined, 'preset-join-rule'),
      upload = h('input');
    upload.type = 'checkbox';
    upload.checked = r.uploadLeaderboardTimes === true;
    uploads.title =
      'Checked: Casual mode, with native leaderboard uploads. Unchecked: Competitive mode, with session-only times.';
    upload.addEventListener('change', () => {
      r.uploadLeaderboardTimes = upload.checked;
      this.changed();
    });
    uploads.append(upload, 'Upload leaderboard times');
    grid.append(uploads);
    customize.append(grid);
    const advanced = h('details', undefined, 'preset-advanced');
    advanced.open = this.#advanced;
    advanced.addEventListener('toggle', () => {
      if (advanced.isConnected) this.#advanced = advanced.open;
    });
    advanced.append(h('summary', 'Timing and scoring'));
    const extras = h('div', undefined, 'preset-fields');
    const extra = (label: string, input: HTMLElement) => {
      const row = h('label', label);
      row.append(input);
      extras.append(row);
    };
    extra('Finish window (seconds)', this.number('finishTimeoutSeconds', 5, 120));
    extra('Between rounds (seconds)', this.number('roundBreakSeconds', 3, 60));
    if (r.warmup !== 'off') {
      extra(
        'Warmup duration',
        this.select(
          [
            ['wr', 'Based on WR time'],
            ['fixed', 'Fixed duration'],
          ],
          r.warmupTiming,
          (v) => {
            r.warmupTiming = v as CupRules['warmupTiming'];
          },
        ),
      );
      extra(
        r.warmupTiming === 'fixed' ? 'Warmup seconds' : 'Seconds when WR is unavailable',
        this.number('warmupSeconds', 10, 600),
      );
      if (r.warmupTiming === 'wr') {
        extra('WR multiplier', this.number('warmupMultiplier', 0.5, 5, 0.1));
        extra('Minimum warmup seconds', this.number('warmupMinimumSeconds', 10, 300));
      }
      extra(
        'Everyone ready ends warmup',
        this.select(
          [
            ['true', 'Enabled'],
            ['false', 'Disabled'],
          ],
          String(r.readyEndsWarmup),
          (v) => {
            r.readyEndsWarmup = v === 'true';
          },
        ),
      );
    }
    const scoring = h('fieldset', undefined, 'preset-scoring');
    scoring.append(h('legend', 'Points by finishing position'));
    r.points.forEach((points, i) => {
      const row = h('label', `${i + 1}${['st', 'nd', 'rd'][i] ?? 'th'}`),
        input = h('input');
      input.type = 'number';
      input.min = '0';
      input.max = '1000';
      input.step = '1';
      input.value = String(points);
      input.setAttribute('aria-label', `Points for place ${i + 1}`);
      input.dataset.presetField = `points-${i}`;
      input.addEventListener('input', () => {
        r.points[i] = input.valueAsNumber;
        this.changed(false);
      });
      row.append(input);
      scoring.append(row);
    });
    extras.append(scoring);
    advanced.append(extras);
    customize.append(advanced);
    box.append(customize);
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
    const icon = (
      kind: 'save' | 'import' | 'export' | 'delete' | 'edit' | 'check',
      label: string,
      action: () => void,
    ) => {
      const button = ui.button(label, action, 'quiet preset-icon');
      button.replaceChildren(presetIcon(kind));
      button.setAttribute('aria-label', label);
      button.title = label;
      return button;
    };
    const rename = icon(
      this.#renaming ? 'check' : 'edit',
      this.#renaming ? 'Apply preset name' : 'Rename preset',
      () => (this.#renaming ? this.finishRename() : this.beginRename()),
    );
    const save = icon('save', 'Save preset', () => {
      if (this.#renaming) this.finishRename();
      if (['standard', 'quickplay', 'custom', ''].includes(this.#draft.name.trim().toLowerCase())) {
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
    const remove = icon('delete', 'Delete saved preset', () => {
      if (!this.#library.list().some((p) => p.name === this.#draft.name)) return;
      this.#library.remove(this.#draft.name);
      this.#draft = standardPreset();
      this.applyDraft();
      ui.showNotice('Preset deleted. Standard rules applied.', 3000);
    });
    remove.dataset.deletePreset = '';
    remove.disabled = !this.#library.list().some((p) => p.name === this.#draft.name);
    const exportButton = icon('export', 'Export preset', () => this.download(this.#draft));
    save.dataset.validPreset = '';
    exportButton.dataset.validPreset = '';
    save.disabled = exportButton.disabled = !validPreset(this.#draft);
    chooser.append(
      rename,
      save,
      icon('import', 'Import preset', () => file.click()),
      exportButton,
      remove,
      file,
    );
    const status = h(
      'p',
      this.dirty
        ? validPreset(this.#draft)
          ? 'Updating rules…'
          : 'Check the fields: select a valid pool, use the allowed ranges, and keep points in descending order.'
        : '',
      'preset-status',
    );
    status.hidden = !this.dirty;
    status.setAttribute('role', 'status');
    box.append(status);
    return box;
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
    const valid = validPreset(this.#draft);
    for (const input of panel.querySelectorAll<HTMLInputElement>('[data-track-category]')) {
      input.checked = this.#draft.rules.pool.some(
        (category) => category === input.dataset.trackCategory,
      );
      input.disabled =
        input.dataset.trackCategory === 'custom' && this.#draft.rules.bansPerRacer > 0;
    }
    const banHint = panel.querySelector<HTMLElement>('.custom-ban-hint');
    if (banHint) banHint.hidden = this.#draft.rules.bansPerRacer === 0;
    for (const input of panel.querySelectorAll<HTMLInputElement>('input[type=number]'))
      input.setAttribute('aria-invalid', String(!input.validity.valid || input.value === ''));
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-valid-preset]'))
      button.disabled = !valid;
    const remove = panel.querySelector<HTMLButtonElement>('[data-delete-preset]');
    if (remove) remove.disabled = !this.#library.list().some((p) => p.name === this.#draft.name);
    const status = panel.querySelector<HTMLElement>('.preset-status');
    if (status) {
      status.textContent = this.dirty
        ? valid
          ? 'Updating rules…'
          : 'Check the fields: select a valid pool, use the allowed ranges, and keep points in descending order.'
        : `${this.#draft.name} rules applied.`;
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
    if (start)
      start.disabled = this.#ui.c.cup.roster.length < 2 || this.dirty || !!this.#ui.c.startingCup;
    const summary = panel.querySelector('.preset-overview');
    if (summary && valid) summary.replaceWith(presetSummary(this.#draft.rules));
  }
  applyDraft() {
    clearTimeout(this.#applyTimer);
    if (!validPreset(this.#draft)) return;
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
    if (this.#draft.rules.bansPerRacer > 0) {
      this.#draft.rules.pool = this.#draft.rules.pool.filter((category) => category !== 'custom');
      if (!this.#draft.rules.pool.length) this.#draft.rules.pool = ['official', 'community'];
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
  number(key: keyof CupRules, min: number, max: number, step = 1) {
    const input = h('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(this.#draft.rules[key]);
    input.title = `${min}–${max}`;
    input.dataset.presetField = key;
    input.addEventListener('input', () => {
      Object.assign(this.#draft.rules, { [key]: input.valueAsNumber });
      this.changed(false);
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
      import: 'M4 15v6h16v-6 M12 3v13 M7 11l5 5 5-5',
      export: 'M4 15v6h16v-6 M12 16V3 M7 8l5-5 5 5',
    }[kind],
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
