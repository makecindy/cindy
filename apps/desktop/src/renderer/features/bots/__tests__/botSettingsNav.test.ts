import { describe, expect, it } from 'vitest';

import {
  BOT_SETTINGS_ANCHOR_IDS,
  isBotSettingsAnchor,
  resolveBotSettingsAnchor,
} from '../botSettingsNav';

describe('Bot settings anchors', () => {
  it('lists every scroll target in page order', () => {
    // `grew` 夹在 understand 与 schedule 之间 —— 顺序就是页面上从上到下的顺序,
    // 错位会让「上一块/下一块」类的推断跟着错。
    expect(BOT_SETTINGS_ANCHOR_IDS).toEqual([
      'who',
      'can',
      'understand',
      'grew',
      'schedule',
      'advanced',
    ]);
  });

  it('recognizes only the canonical anchor ids', () => {
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

  it('has no duplicate anchor ids', () => {
    expect(new Set(BOT_SETTINGS_ANCHOR_IDS).size).toBe(BOT_SETTINGS_ANCHOR_IDS.length);
  });
});
