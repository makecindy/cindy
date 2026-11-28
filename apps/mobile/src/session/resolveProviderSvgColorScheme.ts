import type { ThemeMode } from '@/theme/tokens';

function resolveStyle(css: string, mode: ThemeMode): string {
  // Ignore braces and @media text inside CSS comments, strings and escapes.
  const tokens = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|@media\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*\{|[{}]/gi;
  let depth = 0;
  let media: { start: number; body: number; scheme: string } | undefined;
  let cursor = 0;
  let result = '';

  for (const match of css.matchAll(tokens)) {
    const [token, scheme] = match;
    const start = match.index;
    if (scheme || token === '{') {
      if (scheme && depth === 0) {
        media = { start, body: start + token.length, scheme: scheme.toLowerCase() };
      }
      depth += 1;
    } else if (token === '}') {
      depth -= 1;
      if (depth === 0 && media) {
        result += css.slice(cursor, media.start);
        if (media.scheme === mode) result += css.slice(media.body, start);
        cursor = start + token.length;
        media = undefined;
      }
    }
  }

  return result + css.slice(cursor);
}

/** Resolve simple color-scheme queries for expo-image's native SVG decoders. */
export function resolveProviderSvgColorScheme(svg: string, mode: ThemeMode): string {
  return svg.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|(<style(?:\s[^>]*)?>)([\s\S]*?)(<\/style\s*>)/gi,
    (match: string, open?: string, css?: string, close?: string) =>
      open && css ? open + resolveStyle(css, mode) + close : match,
  );
}
