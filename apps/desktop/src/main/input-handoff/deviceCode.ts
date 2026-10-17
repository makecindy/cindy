import { isInputHandoffDeviceCode, type InputHandoffDeviceCode } from '@cindy/device-link';
import type { NativeAxNode } from './types.js';
import { classifyOrigin } from './originPolicy.js';

/**
 * Device-code sign-in (代输入): a screen that only shows a short code and a
 * link to open elsewhere (“go to example.com/device and enter ABCD-1234”).
 *
 * Generic shape detection, no product knowledge: one code-shaped token and one
 * https link on a screen with nothing to fill in. The owner opens the link on
 * their own device; nothing is typed into the target.
 */

/** Grouped codes (WDJB-MJHT, ABCD-1234) may sit inside a sentence. */
const GROUPED = /(?<![A-Za-z0-9-])([A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5}){1,3})(?![A-Za-z0-9-])/g;
/** Ungrouped codes (F3QWE9R2L) only when they are a whole text of their own. */
const WHOLE = /^[A-Z0-9]{6,10}$/;
const URL_IN_TEXT = /\b(?:https:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s"'<>)]*/gi;

const mixed = (code: string) => /[A-Z]/.test(code) && /[0-9]/.test(code);
/**
 * Grouped codes may be all letters (WDJB-MJHT); all-digit groups are left out
 * because phone numbers look the same, and plain hyphenated words are lowercase.
 */
const groupedCode = (code: string) => code.replace(/-/g, '').length >= 6 && /[A-Z]/.test(code);

function codesIn(text: string, whole: boolean): string[] {
  const found = [...text.matchAll(GROUPED)].map((match) => match[1]).filter(groupedCode);
  const trimmed = text.trim();
  if (whole && WHOLE.test(trimmed) && mixed(trimmed)) found.push(trimmed);
  return found;
}

function httpsLink(raw: string): { url: string; origin: string } | null {
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate.replace(/[.,;:!?]+$/, ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  // Only a plain public https origin: no IP, local host, or look-alike (punycode) domain.
  const { origin, warning } = classifyOrigin(parsed.href, true);
  if (!origin || warning) return null;
  return { url: parsed.href, origin };
}

export function findDeviceCode(nodes: NativeAxNode[], hasInputs: boolean): InputHandoffDeviceCode | null {
  if (hasInputs) return null;
  const codes = new Set<string>();
  const links = new Map<string, { url: string; origin: string }>();
  for (const node of nodes) {
    if (node.role === 'AXLink' && node.url) {
      const link = httpsLink(node.url);
      if (link) links.set(link.url, link);
    }
    if (node.role !== 'AXStaticText' && node.role !== 'AXHeading' && node.role !== 'AXLink') continue;
    for (const text of [node.value, node.title, node.desc]) {
      if (!text) continue;
      for (const code of codesIn(text, node.role !== 'AXLink')) codes.add(code);
      for (const match of text.matchAll(URL_IN_TEXT)) {
        const link = httpsLink(match[0]);
        if (link) links.set(link.url, link);
      }
    }
  }
  // Exactly one of each: anything ambiguous stays an ordinary step.
  if (codes.size !== 1 || links.size !== 1) return null;
  const [code] = codes;
  const [link] = links.values();
  const result = { code, ...link };
  return isInputHandoffDeviceCode(result) ? result : null;
}
