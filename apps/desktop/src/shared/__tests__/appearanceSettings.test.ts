import { describe, expect, it } from 'vitest';

import { DEFAULT_APPEARANCE_SETTINGS, normalizeAppearanceSettings } from '../appearanceSettings';

describe('appearance background settings', () => {
  it('accepts only managed background URLs and clamps readability controls', () => {
    expect(
      normalizeAppearanceSettings({
        backgroundImage: 'cindy-background://current/background.jpg?v=123',
        backgroundOverlay: 1,
        backgroundBlur: -3,
      }),
    ).toMatchObject({
      backgroundImage: 'cindy-background://current/background.jpg?v=123',
      backgroundOverlay: 0.9,
      backgroundBlur: 0,
    });
  });

  it('rejects arbitrary local and malformed URLs', () => {
    for (const backgroundImage of [
      'file:///C:/secret.jpg',
      'cindy-background://current/../secret.jpg?v=1',
      'https://example.com/background.jpg',
    ]) {
      expect(normalizeAppearanceSettings({ backgroundImage }).backgroundImage).toBe(
        DEFAULT_APPEARANCE_SETTINGS.backgroundImage,
      );
    }
  });
});
