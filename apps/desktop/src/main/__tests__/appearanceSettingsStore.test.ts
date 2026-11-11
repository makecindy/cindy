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
  appearancePortableSettings,
  readAppearanceSettingsState,
  writeAppearanceSettingsPatch,
} from '../appearance-settings-store';

describe('terminal appearance overrides', () => {
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

  // PR #9496 / discussion_r4537053002: exporting no resource pointer must not
  // leave its generated family on another computer. Existing terminal tests
  // do not cover portable export. Minimum: selected fonts in three roles; unit.
  it('exports font traits without device-local plugin resources or their matching families', async () => {
    const [ui, code, body] = ['a', 'b', 'c'].map(letter => ({
      source: { instanceId: 'example', key: 'd'.repeat(64) }, reference: `asset:font-${letter}`,
      hash: letter.repeat(64), family: `CindyPlugin_${letter.repeat(64)}`,
    }));
    await writeAppearanceSettingsPatch({ uiFamily: ui.family, codeFamily: code.family,
      uiSize: 17, codeSize: 19, uiFontResource: ui, codeFontResource: code, bodyFontResource: body,
      bodyFont: { family: body.family, size: 20, weight: 600, style: 'italic' } });
    expect(appearancePortableSettings.readCustomized()).toEqual({ uiSize: 17, codeSize: 19,
      bodyFont: { size: 20, weight: 600, style: 'italic' } });
    expect(readAppearanceSettingsState().value.uiFamily).toBe(ui.family);
    expect(readAppearanceSettingsState().value.bodyFont?.family).toBe(body.family);
  });

  it('keeps manually chosen families instead of filtering by a generated-name prefix', async () => {
    const hash = 'a'.repeat(64), family = `CindyPlugin_${hash}`;
    const resource = { source: { instanceId: 'example', key: 'b'.repeat(64) }, reference: 'asset:font', hash, family };
    await writeAppearanceSettingsPatch({ uiFamily: 'Inter', uiFontResource: resource,
      codeFamily: family, bodyFontResource: resource, bodyFont: { family: 'Local Body', size: 20 } });
    expect(appearancePortableSettings.readCustomized()).toEqual({
      uiFamily: 'Inter', codeFamily: family, bodyFont: { family: 'Local Body', size: 20 },
    });
  });

  it('does not export an empty body override when its only trait is a plugin family', async () => {
    const hash = 'a'.repeat(64), family = `CindyPlugin_${hash}`;
    await writeAppearanceSettingsPatch({ bodyFont: { family }, bodyFontResource: {
      source: { instanceId: 'example', key: 'b'.repeat(64) }, reference: 'asset:font', hash, family,
    } });
    expect(appearancePortableSettings.readCustomized()).toEqual({});
    expect(readAppearanceSettingsState().value.bodyFont?.family).toBe(family);
  });

  it('still reports a locally selected plugin font to the migration write conflict guard', async () => {
    const hash = 'a'.repeat(64), family = `CindyPlugin_${hash}`;
    await writeAppearanceSettingsPatch({ uiFamily: family, uiFontResource: {
      source: { instanceId: 'example', key: 'b'.repeat(64) }, reference: 'asset:font', hash, family,
    } });
    let localFamily: unknown;
    await appearancePortableSettings.applyPatch(customizedHere => {
      localFamily = customizedHere.uiFamily;
      return { uiSize: 20 };
    });
    expect(localFamily).toBe(family);
    expect(readAppearanceSettingsState().value.uiFamily).toBe(family);
  });
});
