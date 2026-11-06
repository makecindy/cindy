import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.userData } }));
vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { DEFAULT_APPEARANCE_SETTINGS } from '../../shared/appearanceSettings';
import {
  readAppearanceSettingsState,
  writeAppearanceSettingsPatch,
  updateAppearanceSettingsAtomic,
} from '../appearance-settings-store';

describe('terminal appearance overrides', () => {
  // C11/configuration §2: new plugin fields share the original override owner;
  // removing one override must not freeze defaults or erase manual font choices.
  it('stores content appearance overrides without copying defaults', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    await writeAppearanceSettingsPatch({ uiFamily: 'Inter', reading: { maxWidth: 720 },
      themeColors: { dark: { text: '#eeeeee' } } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ uiFamily: 'Inter',
      reading: { maxWidth: 720 }, themeColors: { dark: { text: '#eeeeee' } } });
    await updateAppearanceSettingsAtomic(() => ({ reading: undefined }));
    expect(readAppearanceSettingsState().customizedKeys).not.toContain('reading');
    expect(readAppearanceSettingsState().value.uiFamily).toBe('Inter');
  });
  beforeEach(() => {
    fixture.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-terminal-appearance-'));
  });
  afterEach(() => fs.rmSync(fixture.userData, { recursive: true, force: true }));

  it('reads old overrides with unchanged values and adds terminal defaults only in memory', () => {
    const oldOverrides = { uiFamily: 'Inter', codeFamily: 'JetBrains Mono', uiSize: 16, codeSize: 18, windowZoom: 1.2 };
    const file = path.join(fixture.userData, 'appearance-settings.json');
    fs.writeFileSync(file, JSON.stringify(oldOverrides));
    const state = readAppearanceSettingsState();
    expect(state.value).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...oldOverrides });
    expect(state.customizedKeys).not.toContain('terminalFamily');
    expect(state.customizedKeys).not.toContain('terminalSize');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(oldOverrides);
  });

  it('persists only terminal overrides and clears each one without changing other preferences', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    const otherOverrides = { uiFamily: 'Inter', codeFamily: 'JetBrains Mono', uiSize: 16, codeSize: 18, windowZoom: 1.2 };
    await writeAppearanceSettingsPatch(otherOverrides);
    await writeAppearanceSettingsPatch({ terminalFamily: '  Menlo  ', terminalSize: 19 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...otherOverrides, terminalFamily: 'Menlo', terminalSize: 19,
    });

    await writeAppearanceSettingsPatch({ terminalFamily: '' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...otherOverrides, terminalSize: 19 });
    expect(readAppearanceSettingsState().value.terminalFamily).toBe('');
    expect(readAppearanceSettingsState().customizedKeys).not.toContain('terminalFamily');

    await writeAppearanceSettingsPatch({ terminalSize: 13 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(otherOverrides);
    expect(readAppearanceSettingsState().value).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, ...otherOverrides });
  });

  it('does not persist a defaults snapshot when restoring the only terminal override', async () => {
    const file = path.join(fixture.userData, 'appearance-settings.json');
    await writeAppearanceSettingsPatch({ terminalSize: 20 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ terminalSize: 20 });
    await writeAppearanceSettingsPatch({ terminalSize: 13 });
    expect(fs.existsSync(file)).toBe(false);
    expect(readAppearanceSettingsState().isCustomized).toBe(false);
  });
});
