import { describe, expect, it } from 'vitest';

import {
  BOT_SETTINGS_TAB_IDS,
  BOT_SETTINGS_TABS,
  DEFAULT_BOT_SETTINGS_TAB,
  isBotSettingsTab,
  parseBotSettingsTab,
} from '../botSettingsNav';

describe('Bot settings nav tab ids', () => {
  it('lists the seven groups in the canonical left-nav order, Basic info first', () => {
    expect(BOT_SETTINGS_TAB_IDS).toEqual([
      'identity',
      'channels',
      'capabilities',
      'automation',
      'notifications',
      'projects',
      'advanced',
    ]);
    expect(BOT_SETTINGS_TABS.map((tab) => tab.id)).toEqual(BOT_SETTINGS_TAB_IDS);
  });

  it('defaults to identity (Basic info)', () => {
    expect(DEFAULT_BOT_SETTINGS_TAB).toBe('identity');
  });

  it('recognizes only the seven canonical slugs', () => {
    for (const id of BOT_SETTINGS_TAB_IDS) {
      expect(isBotSettingsTab(id)).toBe(true);
    }
    expect(isBotSettingsTab('bogus')).toBe(false);
    expect(isBotSettingsTab(null)).toBe(false);
    expect(isBotSettingsTab(undefined)).toBe(false);
    expect(isBotSettingsTab('')).toBe(false);
  });

  it('falls back to identity for a missing or unrecognized ?tab= value, never a blank panel', () => {
    expect(parseBotSettingsTab(null)).toBe('identity');
    expect(parseBotSettingsTab(undefined)).toBe('identity');
    expect(parseBotSettingsTab('')).toBe('identity');
    expect(parseBotSettingsTab('not-a-real-tab')).toBe('identity');
  });

  it('parses every canonical slug back to itself', () => {
    for (const id of BOT_SETTINGS_TAB_IDS) {
      expect(parseBotSettingsTab(id)).toBe(id);
    }
  });

  it('gives every tab a unique English slug and an i18n label key under bots.settingsNav', () => {
    const ids = new Set(BOT_SETTINGS_TABS.map((tab) => tab.id));
    expect(ids.size).toBe(BOT_SETTINGS_TABS.length);
    for (const tab of BOT_SETTINGS_TABS) {
      expect(tab.labelKey).toBe(`bots.settingsNav.${tab.id === 'identity' ? 'identity' : tab.id}`);
      expect(tab.labelKey.startsWith('bots.settingsNav.')).toBe(true);
    }
  });
});
