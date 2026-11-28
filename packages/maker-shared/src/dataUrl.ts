/**
 * Linear-time, constant-stack `data:` URL and Base64 parsing/validation helpers.
 *
 * Large inline images/media commonly exceed 4M base64 characters (~3 MiB raw).
 * Running greedy quantifiers or repeating character-group regexes over the
 * payload (such as `/^data:(image\/...);base64,(.+)$/` or
 * `/^(?:[A-Za-z0-9+/]{4})*...$/`) can exhaust V8's Irregexp backtracking stack
 * and throw `RangeError: Maximum call stack size exceeded` (#5081).
 *
 * Every helper here bounds header matching to the short prefix before the
 * first comma and validates or scans the Base64 payload with linear char-code
 * loops instead of regexes.
 */

export interface ParsedDataUrl {
  /** Lowercased MIME type (the segment between `data:` and the first `;` or `,`). */
  mimeType: string;
  /** Whether any header parameter is `;base64`. */
  base64: boolean;
  /** Raw payload after the first comma (whitespace preserved). */
  payload: string;
}

export interface ParsedBase64DataUrl {
  /** RegExp match array from running `headerPattern` on the prefix before `,`. */
  header: RegExpExecArray;
  /** Raw payload after the first comma. */
  payload: string;
}

export interface ParseBase64DataUrlOptions {
  /** Allow an empty payload after the comma (default `false`). */
  allowEmpty?: boolean;
  /**
   * Allow line terminators (`\r`, `\n`, `\u2028`, `\u2029`) inside the payload.
   * Defaults to `false` to preserve single-line `.+` semantics; set `true` to
   * match `/s` or `[\s\S]+` semantics.
   */
  allowLineTerminators?: boolean;
  /** Maximum index of the first comma before rejecting the header (default `2048`). */
  maxHeaderLength?: number;
}

export interface InlineBase64DataUrlOptions {
  /** Match `data:` and `;base64` case-insensitively (default `false`). */
  caseInsensitive?: boolean;
  /**
   * Anchored pattern tested only against the bounded segment between `data:`
   * and `;base64,`. Never runs over the payload.
   */
  headerPattern: RegExp;
  /** Maximum length of the segment between `data:` and `;base64,` (default `256`). */
  maxHeaderLength?: number;
  /**
   * Payload character class to consume after `;base64,`:
   * - `'strict-padding'`: `[A-Za-z0-9+/]+={0,2}`
   * - `'loose'`: `[A-Za-z0-9+/=]+`
   * - `'loose-whitespace'`: `[A-Za-z0-9+/=\s]+`
   */
  payloadMode: 'strict-padding' | 'loose' | 'loose-whitespace';
}

function isBase64DataChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) // A-Z
    || (code >= 0x61 && code <= 0x7a) // a-z
    || (code >= 0x30 && code <= 0x39) // 0-9
    || code === 0x2b // +
    || code === 0x2f // /
  );
}

function isJsWhitespace(code: number): boolean {
  if (code <= 0x20) {
    return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  }
  if (code < 0xa0) return false;
  return (
    code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff
  );
}

function hasLineTerminator(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

export function parseDataUrl(value: string): ParsedDataUrl | null {
  if (value.length < 6 || value.slice(0, 5).toLowerCase() !== 'data:') return null;
  const comma = value.indexOf(',');
  if (comma < 5) return null;
  const header = value.slice(5, comma);
  const segments = header.split(';');
  const mimeType = segments[0].trim().toLowerCase();
  if (!mimeType) return null;
  const base64 = segments.slice(1).some((segment) => segment.trim().toLowerCase() === 'base64');
  return { mimeType, base64, payload: value.slice(comma + 1) };
}

/**
 * Split a `data:` URL at the first comma and run `headerPattern` strictly on
 * the bounded header slice (never on the payload).
 */
export function parseBase64DataUrl(
  value: string,
  headerPattern: RegExp,
  options?: ParseBase64DataUrlOptions,
): ParsedBase64DataUrl | null {
  const comma = value.indexOf(',');
  const maxHeaderLength = options?.maxHeaderLength ?? 2048;
  if (comma < 5 || comma > maxHeaderLength) return null;
  const header = headerPattern.exec(value.slice(0, comma));
  if (!header) return null;
  const payload = value.slice(comma + 1);
  if (!options?.allowEmpty && payload.length === 0) return null;
  if (!options?.allowLineTerminators && hasLineTerminator(payload)) return null;
  return { header, payload };
}

/**
 * Exact constant-stack equivalent of
 * `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`.
 */
export function isCanonicalBase64(value: string): boolean {
  const len = value.length;
  if (len === 0) return true;
  if (len % 4 !== 0) return false;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = len - pad;
  for (let index = 0; index < end; index += 1) {
    if (!isBase64DataChar(value.charCodeAt(index))) return false;
  }
  return true;
}

/**
 * Exact constant-stack equivalent of `/^[A-Za-z0-9+/]+={0,2}$/` (or with `*`
 * when `allowEmpty` is `true`).
 */
export function isStrictBase64Chars(
  value: string,
  options?: { allowEmpty?: boolean },
): boolean {
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - pad;
  if (!options?.allowEmpty && end === 0) return false;
  for (let index = 0; index < end; index += 1) {
    if (!isBase64DataChar(value.charCodeAt(index))) return false;
  }
  return true;
}

/**
 * Constant-stack check that `value` contains only `[A-Za-z0-9+/=]` (plus
 * optional `\r`/`\n` or arbitrary JS `\s` whitespace).
 */
export function isLooseBase64Chars(
  value: string,
  options?: { allowEmpty?: boolean; allowWhitespace?: boolean; allowLineBreaks?: boolean },
): boolean {
  if (!options?.allowEmpty && value.length === 0) return false;
  const allowWhitespace = options?.allowWhitespace === true;
  const allowLineBreaks = options?.allowLineBreaks === true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isBase64DataChar(code) || code === 0x3d) continue;
    if (allowWhitespace && isJsWhitespace(code)) continue;
    if (allowLineBreaks && (code === 0x0d || code === 0x0a)) continue;
    return false;
  }
  return true;
}

/**
 * Validate that a Base64 payload contains only `A-Za-z0-9+/=` and CR/LF,
 * returning the string with line breaks stripped (or `null` on invalid chars).
 */
export function normalizeBase64Payload(payload: string): string | null {
  let hasLineBreak = false;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (isBase64DataChar(code) || code === 0x3d) continue;
    if (code === 0x0d || code === 0x0a) {
      hasLineBreak = true;
      continue;
    }
    return null;
  }
  if (!hasLineBreak) return payload;
  let cleaned = '';
  let start = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (code === 0x0d || code === 0x0a) {
      if (index > start) cleaned += payload.slice(start, index);
      start = index + 1;
    }
  }
  if (start < payload.length) cleaned += payload.slice(start);
  return cleaned;
}

/** Compute decoded byte length of a Base64 payload ignoring whitespace without decoding. */
export function base64DecodedByteLength(payload: string): number {
  let chars = 0;
  let padding = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (isJsWhitespace(code)) continue;
    chars += 1;
    if (code === 0x3d) padding += 1;
    else padding = 0;
  }
  return Math.max(0, Math.floor((chars * 3) / 4) - Math.min(padding, 2));
}

function findDataPrefix(text: string, from: number, caseInsensitive: boolean): number {
  if (!caseInsensitive) return text.indexOf('data:', from);
  const limit = text.length - 5;
  for (let index = from; index <= limit; index += 1) {
    const c0 = text.charCodeAt(index);
    if (c0 !== 0x64 && c0 !== 0x44) continue; // d / D
    const c1 = text.charCodeAt(index + 1);
    if (c1 !== 0x61 && c1 !== 0x41) continue; // a / A
    const c2 = text.charCodeAt(index + 2);
    if (c2 !== 0x74 && c2 !== 0x54) continue; // t / T
    const c3 = text.charCodeAt(index + 3);
    if (c3 !== 0x61 && c3 !== 0x41) continue; // a / A
    if (text.charCodeAt(index + 4) === 0x3a) return index; // :
  }
  return -1;
}

function scanInlineBase64PayloadEnd(
  text: string,
  payloadStart: number,
  mode: InlineBase64DataUrlOptions['payloadMode'],
): number {
  let index = payloadStart;
  const len = text.length;
  if (mode === 'strict-padding') {
    while (index < len && isBase64DataChar(text.charCodeAt(index))) index += 1;
    if (index === payloadStart) return payloadStart;
    if (index < len && text.charCodeAt(index) === 0x3d) index += 1;
    if (index < len && text.charCodeAt(index) === 0x3d) index += 1;
    return index;
  }
  const allowWhitespace = mode === 'loose-whitespace';
  while (index < len) {
    const code = text.charCodeAt(index);
    if (isBase64DataChar(code) || code === 0x3d || (allowWhitespace && isJsWhitespace(code))) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/**
 * Visit every embedded `data:<header>;base64,<payload>` span in `text` without
 * running any regex over the Base64 payload.
 */
export function forEachInlineBase64DataUrl(
  text: string,
  options: InlineBase64DataUrlOptions,
  visitor: (start: number, end: number) => void,
): void {
  const caseInsensitive = options.caseInsensitive === true;
  const maxHeaderLength = options.maxHeaderLength ?? 256;
  let cursor = 0;
  while (cursor < text.length) {
    const start = findDataPrefix(text, cursor, caseInsensitive);
    if (start < 0) break;
    const headerStart = start + 5;
    const maxComma = Math.min(text.length, headerStart + maxHeaderLength + 8);
    let comma = -1;
    for (let index = headerStart; index < maxComma; index += 1) {
      if (text.charCodeAt(index) === 0x2c) {
        comma = index;
        break;
      }
    }
    if (comma < headerStart + 7) {
      cursor = headerStart;
      continue;
    }
    const base64Tag = text.slice(comma - 7, comma);
    const hasBase64Tag = caseInsensitive
      ? base64Tag.toLowerCase() === ';base64'
      : base64Tag === ';base64';
    if (!hasBase64Tag) {
      cursor = headerStart;
      continue;
    }
    const headerSegment = text.slice(headerStart, comma - 7);
    if (headerSegment.length > maxHeaderLength || !options.headerPattern.test(headerSegment)) {
      cursor = headerStart;
      continue;
    }
    const payloadStart = comma + 1;
    const end = scanInlineBase64PayloadEnd(text, payloadStart, options.payloadMode);
    if (end <= payloadStart) {
      cursor = headerStart;
      continue;
    }
    visitor(start, end);
    cursor = end;
  }
}

/**
 * Replace embedded `data:<header>;base64,<payload>` spans in `text` without
 * running regexes over large payloads. Returning `null` from `replace` keeps
 * the original span untouched; if nothing is replaced, returns `text` as-is.
 */
export function replaceInlineBase64DataUrls(
  text: string,
  options: InlineBase64DataUrlOptions,
  replace: (start: number, end: number) => string | null,
): string {
  let result = '';
  let lastCopied = 0;
  let changed = false;
  forEachInlineBase64DataUrl(text, options, (start, end) => {
    const replacement = replace(start, end);
    if (replacement === null) return;
    changed = true;
    if (start > lastCopied) result += text.slice(lastCopied, start);
    result += replacement;
    lastCopied = end;
  });
  if (!changed) return text;
  if (lastCopied < text.length) result += text.slice(lastCopied);
  return result;
}
