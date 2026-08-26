import { describe, expect, it } from 'vitest';

import type { LocalThemesResult } from '../../../shared/local-themes.js';
import {
  resolveReviewArtifactConfirmPalette,
  __testing,
} from '../reviewArtifactConfirmTheme.js';

describe('Review artifact confirmation theme', () => {
  it('uses the selected built-in family instead of a generic light/dark palette', () => {
    expect(resolveReviewArtifactConfirmPalette('eclipse', true)).toMatchObject({
      surface: '#0d1117',
      surfaceRaised: '#161b22',
      accent: '#0CD2A5',
      accentText: '#0d1117',
    });
    expect(resolveReviewArtifactConfirmPalette('atom-one', false)).toMatchObject({
      surface: '#FAFAFA',
      accent: '#4078F2',
    });
  });

  it('reads the selected local family through Main and accepts a readable hex palette', () => {
    const localThemes: LocalThemesResult = {
      success: true,
      diagnostics: [],
      themes: [
        {
          id: 'custom-dark-local',
          family: 'custom',
          name: 'Custom Dark',
          type: 'dark',
          colors: {
            surface: '#101010',
            'surface-elevated': '#202020',
            'text-primary': '#f4f4f4',
            'text-secondary': '#a0a0a0',
            'border-default': '#404040',
            'accent-cta-bg': '#f0c040',
            'accent-pure-cta-fg': '#101010',
            'surface-hover': '#303030',
          },
        },
      ],
    };

    expect(
      resolveReviewArtifactConfirmPalette('custom-local', true, () => localThemes),
    ).toEqual({
      surface: '#101010',
      surfaceRaised: '#202020',
      text: '#f4f4f4',
      muted: '#a0a0a0',
      border: '#404040',
      accent: '#f0c040',
      accentText: '#101010',
      hover: '#303030',
    });
  });

  it('falls back to Cindy when a local palette could hide consent details', () => {
    const unreadable: LocalThemesResult = {
      success: true,
      diagnostics: [],
      themes: [
        {
          id: 'unsafe-local',
          name: 'Unsafe',
          type: 'dark',
          colors: {
            surface: '#111111',
            'text-primary': '#111111',
            'text-secondary': '#111111',
            'accent-cta-bg': '#222222',
            'accent-pure-cta-fg': '#222222',
          },
        },
      ],
    };

    expect(resolveReviewArtifactConfirmPalette('unsafe-local', true, () => unreadable)).toEqual(
      __testing.CINDY_DARK,
    );
    expect(resolveReviewArtifactConfirmPalette('missing-family', false)).toEqual(
      __testing.CINDY_LIGHT,
    );
    expect(__testing.normalizeHexColor('#111111; color: transparent')).toBeNull();
  });

  it('rejects a local card surface that hides artifact labels or paths', () => {
    const unreadableCard: LocalThemesResult = {
      success: true,
      diagnostics: [],
      themes: [
        {
          id: 'unsafe-card-local',
          name: 'Unsafe Card',
          type: 'dark',
          colors: {
            surface: '#111111',
            'surface-elevated': '#f4f4f4',
            'text-primary': '#f4f4f4',
            'text-secondary': '#b0b0b0',
            'accent-cta-bg': '#ffffff',
            'accent-pure-cta-fg': '#000000',
          },
        },
      ],
    };

    expect(
      resolveReviewArtifactConfirmPalette('unsafe-card-local', true, () => unreadableCard),
    ).toEqual(__testing.CINDY_DARK);
  });
});
