import {
  LOCAL_THEME_SUFFIX,
  type LocalThemeWire,
  type LocalThemesResult,
} from '../../shared/local-themes.js';
import { loadLocalThemesSync } from '../local-themes/loader.js';

export interface ReviewArtifactConfirmPalette {
  surface: string;
  surfaceRaised: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  hover: string;
}

interface ReviewArtifactConfirmPaletteVariants {
  light?: ReviewArtifactConfirmPalette;
  dark?: ReviewArtifactConfirmPalette;
}

const CINDY_LIGHT: ReviewArtifactConfirmPalette = {
  surface: '#F2F2ED',
  surfaceRaised: '#FDFDF8',
  text: '#1A1A1A',
  muted: '#888883',
  border: '#E4E4DF',
  accent: '#3C3F43',
  accentText: '#FCFCFC',
  hover: '#EEEEE9',
};

const CINDY_DARK: ReviewArtifactConfirmPalette = {
  surface: '#181818',
  surfaceRaised: '#1F1F1F',
  text: '#D4D4D4',
  muted: '#6F6F6F',
  border: '#313131',
  accent: '#EEEEEE',
  accentText: '#151515',
  hover: '#1D1D1D',
};

const BUILTIN_PALETTES: Readonly<Record<string, ReviewArtifactConfirmPaletteVariants>> = {
  cindy: { light: CINDY_LIGHT, dark: CINDY_DARK },
  default: {
    light: {
      surface: '#f8f8f6',
      surfaceRaised: '#ffffff',
      text: '#262626',
      muted: '#737373',
      border: '#d7d7d4',
      accent: '#262626',
      accentText: '#ffffff',
      hover: '#e5e5e5',
    },
    dark: {
      surface: '#1f1f1e',
      surfaceRaised: '#2c2c2a',
      text: '#d4d4d4',
      muted: '#a3a3a3',
      border: '#3c3c3a',
      accent: '#ffffff',
      accentText: '#000000',
      hover: '#3c3c3a',
    },
  },
  'atom-one': {
    light: {
      surface: '#FAFAFA',
      surfaceRaised: '#FFFFFF',
      text: '#383A42',
      muted: '#696c77',
      border: '#D4D4D5',
      accent: '#4078F2',
      accentText: '#FFFFFF',
      hover: '#E4E4E5',
    },
    dark: {
      surface: '#282c34',
      surfaceRaised: '#21252b',
      text: '#abb2bf',
      muted: '#7f848e',
      border: '#3e4452',
      accent: '#61afef',
      accentText: '#282c34',
      hover: '#2c313a',
    },
  },
  'solarized-light': {
    light: {
      surface: '#fdf6e3',
      surfaceRaised: '#eee8d5',
      text: '#757575',
      muted: '#828282',
      border: '#e1dcc4',
      accent: '#859900',
      accentText: '#FFFFFF',
      hover: '#eee8d5',
    },
  },
  eclipse: {
    dark: {
      surface: '#0d1117',
      surfaceRaised: '#161b22',
      text: '#e6e6e6',
      muted: '#9ca3af',
      border: '#30363d',
      accent: '#0CD2A5',
      accentText: '#0d1117',
      hover: '#1c2128',
    },
  },
  'monokai-pro': {
    dark: {
      surface: '#2D2A2E',
      surfaceRaised: '#221F22',
      text: '#FCFCFA',
      muted: '#C1C0C0',
      border: '#5b595c',
      accent: '#FFD866',
      accentText: '#2D2A2E',
      hover: '#403E41',
    },
  },
  github: {
    dark: {
      surface: '#0d1117',
      surfaceRaised: '#161b22',
      text: '#e6edf3',
      muted: '#7d8590',
      border: '#30363d',
      accent: '#2f81f7',
      accentText: '#ffffff',
      hover: '#1c2128',
    },
  },
  'material-ocean-hc': {
    dark: {
      surface: '#0F111A',
      surfaceRaised: '#090B10',
      text: '#EEFFFF',
      muted: '#A6ACCD',
      border: '#2A2F45',
      accent: '#80CBC4',
      accentText: '#0F111A',
      hover: '#1A1C25',
    },
  },
};

function requestedPalette(
  variants: ReviewArtifactConfirmPaletteVariants,
  isDark: boolean,
): ReviewArtifactConfirmPalette | null {
  return (isDark ? variants.dark ?? variants.light : variants.light ?? variants.dark) ?? null;
}

function localFamilyId(theme: LocalThemeWire): string {
  return theme.family ? `${theme.family}${LOCAL_THEME_SUFFIX}` : theme.id;
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const short = /^#([0-9a-f]{3})$/iu.exec(trimmed);
  if (short) {
    return `#${[...short[1]!].map((part) => `${part}${part}`).join('')}`;
  }
  return /^#[0-9a-f]{6}$/iu.test(trimmed) ? trimmed : null;
}

function colorChannels(value: string): [number, number, number] {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function relativeLuminance(value: string): number {
  const channels = colorChannels(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function safeLocalPalette(
  theme: LocalThemeWire,
  fallback: ReviewArtifactConfirmPalette,
): ReviewArtifactConfirmPalette {
  const color = (key: string, fallbackValue: string) =>
    normalizeHexColor(theme.colors[key]) ?? fallbackValue;
  const palette = {
    surface: color('surface', fallback.surface),
    surfaceRaised: color('surface-elevated', fallback.surfaceRaised),
    text: color('text-primary', fallback.text),
    muted: color('text-secondary', fallback.muted),
    border: color('border-default', fallback.border),
    accent: color('accent-cta-bg', fallback.accent),
    accentText: color('accent-pure-cta-fg', fallback.accentText),
    hover: color('surface-hover', fallback.hover),
  };
  if (
    contrastRatio(palette.text, palette.surface) < 4.5 ||
    contrastRatio(palette.text, palette.surfaceRaised) < 4.5 ||
    contrastRatio(palette.muted, palette.surface) < 3 ||
    contrastRatio(palette.muted, palette.surfaceRaised) < 3 ||
    contrastRatio(palette.accentText, palette.accent) < 4.5
  ) {
    return fallback;
  }
  return palette;
}

export function resolveReviewArtifactConfirmPalette(
  familyId: string | null | undefined,
  isDark: boolean,
  loadLocalThemes: () => LocalThemesResult = loadLocalThemesSync,
): ReviewArtifactConfirmPalette {
  const fallback = isDark ? CINDY_DARK : CINDY_LIGHT;
  const builtin = familyId ? BUILTIN_PALETTES[familyId] : undefined;
  if (builtin) return requestedPalette(builtin, isDark) ?? fallback;
  if (!familyId?.endsWith(LOCAL_THEME_SUFFIX)) return fallback;

  const loaded = loadLocalThemes();
  if (!loaded.success) return fallback;
  const family = loaded.themes.filter((theme) => localFamilyId(theme) === familyId);
  const selected =
    family.find((theme) => theme.type === (isDark ? 'dark' : 'light')) ?? family[0];
  return selected ? safeLocalPalette(selected, fallback) : fallback;
}

export const __testing = {
  BUILTIN_PALETTES,
  CINDY_DARK,
  CINDY_LIGHT,
  contrastRatio,
  normalizeHexColor,
};
