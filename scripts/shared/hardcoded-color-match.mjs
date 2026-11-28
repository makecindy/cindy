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

/** Advance through each prefix once, retaining precisely the old lexical
 * predicates rather than truncating long declarations. Each candidate pass owns
 * its cursor; no per-character tables or whole-prefix copies are needed. */
function colorContext(source) {
  let cursor = 0;
  let lastContent = -1;
  let declaration = false;
  let declarationWhitespace = false;
  let hexFunction = false;
  let numericFunction = false;
  let arbitrary = false;
  const previousContent = index => {
    while (index >= 0 && /\s/.test(source[index])) index--;
    return index;
  };
  const wordBefore = index => {
    let start = index;
    while (start >= 0 && /[\w$-]/.test(source[start])) start--;
    return source.slice(start + 1, index + 1);
  };
  let style = false;
  return index => {
    while (cursor < index) {
      const ch = source[cursor];
      if (/[;{}]/.test(ch)) { declaration = false; hexFunction = false; }
      if (/[;{}=:]/.test(ch)) { style = false; numericFunction = false; }
      if (ch === '\n') {
        if (!declarationWhitespace) declaration = false;
        hexFunction = false;
        arbitrary = false;
      }
      if (ch === ']') arbitrary = false;
      if (!/\s/.test(ch)) declarationWhitespace = false;
      if (ch === ':' || ch === '=') {
        let end = previousContent(cursor - 1);
        const quote = /["']/.test(source[end] ?? '') ? source[end--] : '';
        const word = wordBefore(end);
        // Reuse the colour-word segmentation contract for numeric functions.
        style = stylePropContext(word + quote + ch);
        if (ch === ':' && !quote
          && (/color$/i.test(word)
            || /\b(?:background(?:-[\w-]+)?|border(?:-[\w-]+)?|fill|stroke|(?:box|text)-shadow|boxShadow|textShadow|outline)$/i.test(word))) {
          declaration = true;
          declarationWhitespace = true;
        }
      }
      if (ch === '(' && /\b(?:var|(?:repeating-)?(?:linear|radial|conic)-gradient|color-mix|(?:rgb|hsl)a?|drop-shadow)$/i.test(wordBefore(cursor - 1))) {
        hexFunction = true;
        numericFunction = true;
      }
      if (ch === '[' && /[\w-]-$/.test(source.slice(Math.max(0, cursor - 2), cursor))) arbitrary = true;
      if (!/\s/.test(ch)) lastContent = cursor;
      cursor++;
    }
    const before = source.slice(Math.max(0, lastContent - 8), lastContent + 1);
    // href/url permit whitespace on both sides of =/( and an optional quote.
    let end = lastContent;
    const quote = /["']/.test(source[end] ?? '');
    const trailingSpaceAfterQuote = quote && end !== index - 1;
    if (quote) end = previousContent(end - 1);
    const url = !trailingSpaceAfterQuote && /[=(]/.test(source[end] ?? '')
      && /(?:href|url)$/i.test(source.slice(Math.max(0, previousContent(end - 1) - 3), previousContent(end - 1) + 1));
    return {
      declaration, hexFunction, numericFunction, arbitrary, style,
      prose: /\b(?:PR|issue|pull)$/i.test(before),
      literalStart: /["'`:=\[]$/.test(before), url,
    };
  };
}

/** Cache the next closing parenthesis for every opener in one traversal. */
function closingParens(source) {
  const closes = new Map();
  const opens = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') opens.push(i);
    else if (source[i] === ')' && opens.length) closes.set(opens.pop(), i);
  }
  return closes;
}

/** Traverse semantic wrappers too: var() must never hide a literal fallback. */
export function findBareColors(text) {
  const source = maskColorComments(text);
  const hits = [];
  // One trim, inspired by Battleplus's #8543 boundary optimisation. No fixed
  // context window: legitimate declarations and labels have no length cap.
  const trimmed = source.trim();
  const wholeStart = source.length - source.trimStart().length;
  const wholeEnd = wholeStart + trimmed.length;
  const wholeSource = (start, end) => start === wholeStart && end === wholeEnd;
  let contextAt = colorContext(source);
  let nextBracket = -1;
  let nextNewline = -1;
  const add = (value, index, end = index + value.length) => hits.push({ value, index, end });
  for (const match of source.matchAll(/#[\da-f]+\b/gi)) {
    const value = match[0];
    if (![4, 5, 7, 9].includes(value.length)) continue;
    const context = contextAt(match.index);
    // Preserve the immediate-[#...] predicate; a computed call's entire
    // bracket range must not hide quoted colours inside the expression.
    if (context.prose || context.url) continue;
    const end = match.index + value.length;
    if (source[match.index - 1] === '[') {
      if (nextBracket < end) nextBracket = source.indexOf(']', end);
      if (nextNewline < end) nextNewline = source.indexOf('\n', end);
      if (nextBracket < 0) nextBracket = source.length;
      if (nextNewline < 0) nextNewline = source.length;
      if (nextBracket < nextNewline && source[nextBracket + 1] === '(') continue;
    }
    let after = end;
    while (after < source.length && /\s/.test(source[after])) after++;
    if (source[after] === '{') continue;
    if (!context.literalStart && !context.declaration && !context.hexFunction && !context.arbitrary
      && !wholeSource(match.index, end)) continue;
    add(value, match.index);
  }
  contextAt = colorContext(source);
  let parens;
  for (const match of source.matchAll(/\b(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb|color)\s*\(/gi)) {
    const open = match.index + match[0].length - 1;
    parens ??= closingParens(source);
    const close = parens.get(open);
    if (close === undefined) continue; // e.g. a documented function prefix, not a colour value
    // A nested function cannot be a fully numeric channel list. Avoid copying
    // overlapping bodies for deeply nested generated expressions.
    const nested = source.indexOf('(', open + 1);
    if (nested >= 0 && nested < close) continue;
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
    const context = contextAt(match.index);
    if (!context.style && !context.numericFunction && !context.arbitrary
      && !wholeSource(match.index, close + 1)) continue;
    add(source.slice(match.index, close + 1), match.index, close + 1);
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function matchBareColors(text) {
  return findBareColors(text).map((hit) => hit.value);
}
