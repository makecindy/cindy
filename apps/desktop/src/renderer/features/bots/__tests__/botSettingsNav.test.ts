import { describe, expect, it } from 'vitest';

import {
  BOT_SETTINGS_ANCHOR_IDS,
  BOT_SETTINGS_ANCHORS,
  isBotSettingsAnchor,
  resolveBotSettingsAnchor,
} from '../botSettingsNav';

describe('Bot settings anchors', () => {
  it('lists the four blocks plus Advanced, in page order', () => {
    expect(BOT_SETTINGS_ANCHOR_IDS).toEqual(['who', 'can', 'understand', 'schedule', 'advanced']);
    expect(BOT_SETTINGS_ANCHORS.map((anchor) => anchor.id)).toEqual([...BOT_SETTINGS_ANCHOR_IDS]);
  });

  it('recognizes only the five canonical anchor ids', () => {
    for (const id of BOT_SETTINGS_ANCHOR_IDS) {
      expect(isBotSettingsAnchor(id)).toBe(true);
    }
    expect(isBotSettingsAnchor('bogus')).toBe(false);
    expect(isBotSettingsAnchor(null)).toBe(false);
    expect(isBotSettingsAnchor(undefined)).toBe(false);
    expect(isBotSettingsAnchor('')).toBe(false);
  });

  it('resolves every canonical anchor id back to itself', () => {
    for (const id of BOT_SETTINGS_ANCHOR_IDS) {
      expect(resolveBotSettingsAnchor(id)).toBe(id);
    }
  });

  it('falls back to top-of-page (null) for a missing value', () => {
    expect(resolveBotSettingsAnchor(null)).toBeNull();
    expect(resolveBotSettingsAnchor(undefined)).toBeNull();
    expect(resolveBotSettingsAnchor('')).toBeNull();
  });

  it('falls back to top-of-page (null) for an unrecognized value, not a hardcoded section', () => {
    expect(resolveBotSettingsAnchor('not-a-real-anchor')).toBeNull();
  });

  it('maps every legacy tab id from the seven-tab settings page to its new home', () => {
    expect(resolveBotSettingsAnchor('identity')).toBe('who');
    expect(resolveBotSettingsAnchor('channels')).toBe('can');
    expect(resolveBotSettingsAnchor('capabilities')).toBe('advanced');
    expect(resolveBotSettingsAnchor('automation')).toBe('schedule');
    expect(resolveBotSettingsAnchor('notifications')).toBe('advanced');
    expect(resolveBotSettingsAnchor('projects')).toBe('understand');
    expect(resolveBotSettingsAnchor('advanced')).toBe('advanced');
  });

  it('gives every anchor a unique id and an i18n label key under bots.settingsBlocks', () => {
    const ids = new Set(BOT_SETTINGS_ANCHORS.map((anchor) => anchor.id));
    expect(ids.size).toBe(BOT_SETTINGS_ANCHORS.length);
    for (const anchor of BOT_SETTINGS_ANCHORS) {
      expect(anchor.labelKey).toBe(`bots.settingsBlocks.${anchor.id}`);
    }
  });
});
