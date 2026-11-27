import { parse } from 'smol-toml';

/** Match native Codex: accept one leading UTF-8 BOM, not arbitrary whitespace/BOMs.
 * Parse only; callers retain the original bytes for preservation and write guards.
 */
export function parseCodexConfigToml(text: string) {
  return parse(text.replace(/^\uFEFF/, ''));
}
