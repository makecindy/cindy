/**
 * Monochrome logos for the menu bar panel, as standalone SVG documents.
 *
 * The helper loads them with NSImage and draws them as template images, so every shape is
 * black and the panel tints it for Light and Dark. Unknown providers get a lettered tile
 * instead of a borrowed brand.
 */

import {
  PROVIDER_LOGO_PATHS,
  resolveProviderLogoKind,
  type ProviderLogoKind,
  type ProviderLogoRouting,
} from '@cindy/model-providers/branding';

import {
  ANTHROPIC_MARK_PATH,
  CLAUDE_CODE_MARK_PATH,
  CODEX_FLOWER_OUTLINE,
  CODEX_PROMPT_GLYPHS,
  OPENAI_MARK_PATH,
} from '../../shared/brandMarkPaths.js';
import type { MenubarFamily, MenubarHarness } from './snapshot.js';

/** Sentinel the helper resolves to the built-in Cindy mark, so the long path crosses once. */
export const MENUBAR_CINDY_LOGO = 'cindy:mark';

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;

const filled = (d: string, evenOdd = false): string =>
  svg(`<path fill="#000"${evenOdd ? ' fill-rule="evenodd"' : ''} d="${d}"/>`);

const BRAND_SVG: Partial<Record<ProviderLogoKind, string>> = {
  anthropic: filled(ANTHROPIC_MARK_PATH),
  openai: filled(OPENAI_MARK_PATH),
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Rounded tile with the first letter of the name, for providers without an official mark. */
export function monogramLogo(name: string): string {
  const letter = escapeXml([...name.trim()][0]?.toUpperCase() ?? '?');
  return svg(
    '<rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="#000" stroke-width="1.6"/>' +
      `<text x="12" y="16.2" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="11" font-weight="600" fill="#000">${letter}</text>`,
  );
}

export function logoForKind(kind: ProviderLogoKind | null, fallbackName: string): string {
  if (!kind) return monogramLogo(fallbackName);
  const brand = BRAND_SVG[kind];
  if (brand) return brand;
  if (kind in PROVIDER_LOGO_PATHS) return filled(PROVIDER_LOGO_PATHS[kind as keyof typeof PROVIDER_LOGO_PATHS]);
  return monogramLogo(fallbackName);
}

export function providerLogo(providerId: string, name: string, routing?: ProviderLogoRouting): string {
  return logoForKind(resolveProviderLogoKind(providerId, routing), name);
}

/** Subscription logos follow the model maker: Anthropic for Claude, OpenAI for Codex, xAI for Grok. */
export function familyLogo(family: MenubarFamily): string {
  if (family === 'claude') return logoForKind('anthropic', 'Claude');
  if (family === 'codex') return logoForKind('openai', 'Codex');
  return logoForKind('xai', 'Grok');
}

/** Agent identity marks for task rows and the usage chart legend. */
export const MENUBAR_HARNESS_LOGOS: Record<MenubarHarness, string> = {
  'claude-code': filled(CLAUDE_CODE_MARK_PATH, true),
  codex: svg(
    '<g transform="translate(12 12) scale(1.1) translate(-12 -12)">' +
      `<path fill="none" stroke="#000" stroke-width="1.6" stroke-linejoin="round" d="${CODEX_FLOWER_OUTLINE}z"/>` +
      `<path fill="#000" stroke="#000" stroke-width="0.5" stroke-linejoin="round" d="${CODEX_PROMPT_GLYPHS}"/>` +
      '</g>',
  ),
  pi: svg(
    '<g fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3.6 6.6h16.8"/><path d="M8.4 6.6v11.8"/><path d="M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2"/>' +
      '</g>',
  ),
};
