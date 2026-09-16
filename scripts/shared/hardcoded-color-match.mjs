/** Shared lexical colour scan for inventory and added-line audit. Offsets refer to
 * original source. Computed channels, named colours and concatenation still need
 * review; this scanner is not a CSS evaluator (governance §13). Numeric colour
 * functions additionally require a colour-bearing context (style property, CSS
 * function, arbitrary value or whole source): rgb()/hsl() mentioned inside a
 * plain string is documentation or diagnostics, not a palette value. */
export function maskColorComments(text) {
  return String(text).replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->/g,
    (part) => /^(?:\/\*|\/\/|<!--)/.test(part) ? part.replace(/[^\r\n]/g, ' ') : part,
  );
}

function closeParen(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Colour-word segments of the HEX declaration vocabulary. Compared per segment
 * (camelCase / dash / SCREAMING_SNAKE delimited) so `borderColor` and
 * `chat-input-border-focus` match while `fulfillment` or `label` do not. */
const COLOUR_WORDS = new Set(['color', 'background', 'border', 'fill', 'stroke', 'shadow', 'outline']);

/** A numeric colour function sits in a colour-bearing context when a style
 * property, CSS custom property or colour-ish assignment precedes it. Unlike
 * HEX, a bare quoted literal is not enough: prose and diagnostics routinely
 * mention rgb()/hsl() as text, so `const label = 'RGB(1, 2, 3)'` is not a
 * colour while `backgroundColor: 'rgb(1, 2, 3)'`, `style.boxShadow = '0 0 0
 * rgba(0,0,0,0)'` and `'--panel-shadow': 'inset 0 1px 0 rgb(1 2 3)'` are. */
function stylePropContext(before) {
  const prop = /["']?(--[\w-]+|[A-Za-z_$][\w$-]*)["']?\s*[:=]\s*[^;{}=:]*$/.exec(before);
  if (!prop) return false;
  if (prop[1].startsWith('--')) return true;
  const segments = prop[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_\s]+/);
  return segments.some(segment => COLOUR_WORDS.has(segment.toLowerCase()));
}

/** Traverse semantic wrappers too: var() must never hide a literal fallback. */
export function findBareColors(text) {
  const source = maskColorComments(text);
  const hits = [];
  const add = (value, index, end = index + value.length) => hits.push({ value, index, end });
  for (const match of source.matchAll(/#[\da-f]+\b/gi)) {
    const value = match[0];
    if (![4, 5, 7, 9].includes(value.length)) continue;
    const before = source.slice(0, match.index);
    const after = source.slice(match.index + value.length);
    // CSS/hash literals, quoted colour values and Tailwind arbitrary values.
    // Prose PR numbers, URLs, HTML entities and CSS ID selectors are not colours.
    if (/(?:\bPR|\bissue|\bpull)\s*$/i.test(before)) continue;
    if (/\[$/.test(before) && /^[^\]\n]*\]\(/.test(after)) continue;
    if (/^\s*\{/.test(after) || /(?:href|url)\s*[=(]\s*["']?$/i.test(before)) continue;
    const literalStart = /["'`:=\[]\s*$/.test(before);
    const declaration = /\b(?:[\w-]*color|background(?:-[\w-]+)?|border(?:-[\w-]+)?|fill|stroke|(?:box|text)-shadow|boxShadow|textShadow|outline)\s*:\s*[^;{}\n]*$/i.test(before);
    const cssFunction = /\b(?:var|(?:repeating-)?(?:linear|radial|conic)-gradient|color-mix|(?:rgb|hsl)a?|drop-shadow)\([^;{}\n]*$/i.test(before);
    const arbitrary = /[\w-]+-\[[^\]\n]*$/.test(before);
    if (!literalStart && !declaration && !cssFunction && !arbitrary && source.trim() !== value) continue;
    add(value, match.index);
  }
  for (const match of source.matchAll(/\b(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb|color)\s*\(/gi)) {
    const open = match.index + match[0].length - 1;
    const close = closeParen(source, open);
    if (close < 0) continue; // e.g. a documented function prefix, not a colour value
    const body = source.slice(open + 1, close);
    // Fully literal channels are bare colour. Nested literal functions and hex
    // remain independently visible even when the outer function uses variables.
    const channels = body.replace(/_/g, ' ').trim();
    const numeric = '(?:[+-]?(?:\\d*\\.)?\\d+(?:e[+-]?\\d+)?(?:%|deg|rad|grad|turn)?|none)';
    const channelList = new RegExp(`^${numeric}(?:[\\s,/]+${numeric}){2,3}$`, 'i');
    const literal = /^color\s*\(/i.test(match[0])
      ? /^(?:srgb(?:-linear)?|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz(?:-d50|-d65)?)\s+/i.test(channels)
        && channelList.test(channels.replace(/^\S+\s+/, ''))
      : channelList.test(channels);
    if (!literal) continue;
    // Same context discipline as the HEX branch, minus bare quoted literals:
    // require a style property, colour-bearing CSS function, arbitrary value or
    // whole-source position. Plain strings are prose, not palettes.
    const before = source.slice(0, match.index);
    const cssFunction = /\b(?:var|(?:repeating-)?(?:linear|radial|conic)-gradient|color-mix|(?:rgb|hsl)a?|drop-shadow)\([^;{}=:]*$/i.test(before);
    const arbitrary = /[\w-]+-\[[^\]\n]*$/.test(before);
    if (!stylePropContext(before) && !cssFunction && !arbitrary
      && source.trim() !== source.slice(match.index, close + 1)) continue;
    add(source.slice(match.index, close + 1), match.index, close + 1);
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function matchBareColors(text) {
  return findBareColors(text).map((hit) => hit.value);
}
