/**
 * OpenAI Web Search may encode source references in assistant text with
 * private-use delimiters such as `\uE200cite\uE202...\uE201`. Those tokens are
 * transport metadata, not user-facing prose. Some Codex app-server versions
 * expose only the flattened text and omit the structured URL annotations, so
 * client boundaries must remove the opaque marker deterministically.
 *
 * Grok / xAI may also leak stop tokens such as `<|eos|>` as visible
 * assistant text, typically as a wrap-up after a tool-only turn. One token,
 * several in a row, or the same tokens split across stream deltas are still
 * transport control, not user-facing prose. Mentions that follow real
 * prose, such as `The token is <|eos|>`, stay intact.
 *
 * Non-Claude models running behind Anthropic-compatible proxies in Claude Code
 * (for example `gemini-4-neon` in long-context sessions with repeated
 * background tasks) may also fail to emit EOS at turn end and hallucinate a
 * synthetic user turn containing Claude Code's internal notification block:
 *
 *   user
 *   <system-reminder>
 *   [SYSTEM NOTIFICATION - NOT USER INPUT]
 *   ...
 *   </system-reminder>
 *
 * Because the hallucinated block arrives inside `assistant` text rather than a
 * real injected `user` turn, client boundaries strip confirmed blocks outside
 * fenced code blocks and hold partial line-start prefixes during streaming.
 */
const MODEL_STOP_TOKEN_LIST = ['<|endoftext|>', '<|eot_id|>', '<|im_end|>', '<|eos|>'];
const LONGEST_MODEL_STOP_TOKEN = Math.max(
  ...MODEL_STOP_TOKEN_LIST.map((token) => token.length),
);
const WEB_CITATION_OPEN = '\uE200cite\uE202';
const WEB_CITATION_CLOSE = '\uE201';
const LEAKED_USER_ROLE = 'user';
const LEAKED_SYSTEM_REMINDER_OPEN = '<system-reminder>';
const LEAKED_SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const LEAKED_SYSTEM_NOTIFICATION_MARKER = '[SYSTEM NOTIFICATION - NOT USER INPUT]';

interface FenceState {
  char: '`' | '~';
  length: number;
}

interface StreamNotificationState {
  openFence: FenceState | null;
  atLineStart: boolean;
  /** Partial line buffer when the current unfinished line could still be a fence. */
  linePrefix: string;
  /** True right after a leading leaked block was stripped with nothing visible emitted yet. */
  strippedLeadingBlock: boolean;
}

const streamNotificationStateByHold = new WeakMap<
  StandaloneStopTokenHold,
  StreamNotificationState
>();

function createStreamNotificationState(): StreamNotificationState {
  return {
    openFence: null,
    atLineStart: true,
    linePrefix: '',
    strippedLeadingBlock: false,
  };
}

function getStreamNotificationState(buffer: StandaloneStopTokenHold): StreamNotificationState {
  let state = streamNotificationStateByHold.get(buffer);
  if (!state) {
    state = createStreamNotificationState();
    streamNotificationStateByHold.set(buffer, state);
  }
  return state;
}

function isHorizontalSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function isBlankHorizontal(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (!isHorizontalSpace(text[i])) return false;
  }
  return true;
}

function isAsciiWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function nextFenceState(line: string, current: FenceState | null): FenceState | null {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i += 1;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return current;
  let end = i;
  while (end < line.length && line[end] === ch) end += 1;
  const runLength = end - i;
  if (runLength < 3) return current;

  if (current === null) {
    if (ch === '`' && line.indexOf('`', end) !== -1) return null;
    return { char: ch, length: runLength };
  }
  if (ch === current.char && runLength >= current.length) {
    for (let k = end; k < line.length; k += 1) {
      if (!isHorizontalSpace(line[k])) return current;
    }
    return null;
  }
  return current;
}

function couldBeFenceLinePrefix(prefix: string): boolean {
  let i = 0;
  while (i < prefix.length && i < 3 && prefix[i] === ' ') i += 1;
  if (i === prefix.length) return true;
  const ch = prefix[i];
  return ch === '`' || ch === '~';
}

function appendLinePrefix(prefix: string, fragment: string): string {
  if (prefix === '!') return '!';
  const next = prefix + fragment;
  return couldBeFenceLinePrefix(next) ? next : '!';
}

function advanceStreamNotificationState(state: StreamNotificationState, text: string): void {
  if (!text) return;
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      const tail = text.slice(pos);
      if (state.atLineStart) {
        state.linePrefix = appendLinePrefix('', tail);
        state.atLineStart = false;
      } else {
        state.linePrefix = appendLinePrefix(state.linePrefix, tail);
      }
      return;
    }
    const lineEnd = nl > pos && text[nl - 1] === '\r' ? nl - 1 : nl;
    const part = text.slice(pos, lineEnd);
    const fullLine = state.atLineStart ? part : appendLinePrefix(state.linePrefix, part);
    if (fullLine !== '!') {
      state.openFence = nextFenceState(fullLine, state.openFence);
    }
    state.linePrefix = '';
    state.atLineStart = true;
    pos = nl + 1;
  }
}

function matchLiteralOrPrefix(
  text: string,
  pos: number,
  literal: string,
): { matched: true; next: number } | { matched: false; isPrefix: boolean } {
  const remaining = text.length - pos;
  if (remaining === 0) return { matched: false, isPrefix: true };
  if (remaining < literal.length) {
    return { matched: false, isPrefix: literal.startsWith(text.slice(pos)) };
  }
  if (text.startsWith(literal, pos)) {
    return { matched: true, next: pos + literal.length };
  }
  return { matched: false, isPrefix: false };
}

type LeakedNotificationHeaderMatch =
  | { kind: 'none' }
  | { kind: 'incomplete' }
  | { kind: 'confirmed'; afterMarker: number };

function matchLeakedNotificationHeader(
  text: string,
  start: number,
): LeakedNotificationHeaderMatch {
  let pos = start;

  // Optional standalone `user` role line before `<system-reminder>`.
  const roleMatch = matchLiteralOrPrefix(text, pos, LEAKED_USER_ROLE);
  if (!roleMatch.matched && roleMatch.isPrefix) {
    return { kind: 'incomplete' };
  }
  if (roleMatch.matched) {
    let p = roleMatch.next;
    while (p < text.length && isHorizontalSpace(text[p])) p += 1;
    if (p === text.length) return { kind: 'incomplete' };
    if (text[p] === '\r') {
      if (p + 1 === text.length) return { kind: 'incomplete' };
      if (text[p + 1] !== '\n') return { kind: 'none' };
      p += 2;
    } else if (text[p] === '\n') {
      p += 1;
    } else {
      return { kind: 'none' };
    }
    while (p < text.length && isAsciiWhitespace(text[p])) p += 1;
    if (p === text.length) return { kind: 'incomplete' };
    pos = p;
  }

  const openMatch = matchLiteralOrPrefix(text, pos, LEAKED_SYSTEM_REMINDER_OPEN);
  if (!openMatch.matched) {
    return openMatch.isPrefix ? { kind: 'incomplete' } : { kind: 'none' };
  }
  pos = openMatch.next;

  while (pos < text.length && isAsciiWhitespace(text[pos])) pos += 1;
  if (pos === text.length) return { kind: 'incomplete' };

  const markerMatch = matchLiteralOrPrefix(text, pos, LEAKED_SYSTEM_NOTIFICATION_MARKER);
  if (!markerMatch.matched) {
    return markerMatch.isPrefix ? { kind: 'incomplete' } : { kind: 'none' };
  }
  return { kind: 'confirmed', afterMarker: markerMatch.next };
}

function consumeLeadingBlankLines(text: string, from: number): number {
  let pos = from;
  for (;;) {
    let p = pos;
    while (p < text.length && isHorizontalSpace(text[p])) p += 1;
    if (p < text.length && text[p] === '\r' && text[p + 1] === '\n') {
      pos = p + 2;
      continue;
    }
    if (p < text.length && text[p] === '\n') {
      pos = p + 1;
      continue;
    }
    return pos;
  }
}

function isOnlyAsciiWhitespaceFrom(text: string, from: number): boolean {
  for (let i = from; i < text.length; i += 1) {
    if (!isAsciiWhitespace(text[i])) return false;
  }
  return true;
}

/**
 * Strip leaked Claude Code synthetic background-task notification blocks from
 * assistant text (outside fenced code blocks). Complete blocks ending in
 * `</system-reminder>` and truncated blocks after the confirmed
 * `[SYSTEM NOTIFICATION - NOT USER INPUT]` header are removed. Incomplete
 * prefixes (such as a bare `user` line or `<system-reminder>` without the
 * synthetic-notification marker) are left untouched.
 */
export function stripLeakedSystemNotificationBlocks(
  text: string,
  initialState?: Readonly<StreamNotificationState>,
): string {
  if (!text.includes(LEAKED_SYSTEM_NOTIFICATION_MARKER)) {
    if (initialState?.strippedLeadingBlock) {
      return text.slice(consumeLeadingBlankLines(text, 0));
    }
    return text;
  }
  return stripLeakedSystemNotificationBlocksInternal(text, initialState, false).text;
}

function stripLeakedSystemNotificationBlocksInternal(
  text: string,
  initialState: Readonly<StreamNotificationState> | undefined,
  emittedBefore: boolean,
): { text: string; strippedLeadingBlock: boolean } {
  let openFence: FenceState | null = initialState?.openFence ?? null;
  let linePrefix = initialState?.linePrefix ?? '';
  let strippedLeading = initialState?.strippedLeadingBlock ?? false;
  let pos = 0;
  let cursor = 0;
  let gapStart = 0;
  let output = '';
  let lastStrippedEnd = -1;

  if (initialState && !initialState.atLineStart) {
    const nl = text.indexOf('\n', 0);
    if (nl === -1) {
      return { text, strippedLeadingBlock: strippedLeading };
    }
    const lineEnd = nl > 0 && text[nl - 1] === '\r' ? nl - 1 : nl;
    const fullLine = appendLinePrefix(linePrefix, text.slice(0, lineEnd));
    if (fullLine !== '!') {
      openFence = nextFenceState(fullLine, openFence);
    }
    linePrefix = '';
    gapStart = lineEnd;
    pos = nl + 1;
  } else if (strippedLeading) {
    const skipped = consumeLeadingBlankLines(text, 0);
    pos = skipped;
    cursor = skipped;
    gapStart = skipped;
  }

  while (pos < text.length) {
    if (openFence === null) {
      const header = matchLeakedNotificationHeader(text, pos);
      if (header.kind === 'confirmed') {
        const closeIdx = text.indexOf(LEAKED_SYSTEM_REMINDER_CLOSE, header.afterMarker);
        output += text.slice(cursor, gapStart);
        if (closeIdx === -1) {
          return {
            text: output,
            strippedLeadingBlock: !emittedBefore && output.length === 0,
          };
        }
        const blockEnd = closeIdx + LEAKED_SYSTEM_REMINDER_CLOSE.length;
        pos = blockEnd;
        if (!emittedBefore && output.length === 0) {
          pos = consumeLeadingBlankLines(text, pos);
          strippedLeading = true;
          cursor = pos;
          gapStart = pos;
          lastStrippedEnd = pos;
          continue;
        }
        strippedLeading = false;
        cursor = pos;
        gapStart = pos;
        lastStrippedEnd = pos;
        // If only whitespace follows the final stripped block, drop it cleanly.
        if (pos < text.length && isOnlyAsciiWhitespaceFrom(text, pos)) {
          return { text: output, strippedLeadingBlock: false };
        }
        // If the line continues immediately on the same line after `</system-reminder>`,
        // advance to the next newline before checking for another line-start header.
        const nlAfter = text.indexOf('\n', pos);
        if (nlAfter === -1) {
          output += text.slice(cursor);
          return { text: output, strippedLeadingBlock: false };
        }
        const lineEndAfter = nlAfter > pos && text[nlAfter - 1] === '\r' ? nlAfter - 1 : nlAfter;
        const tailOnLine = text.slice(pos, lineEndAfter);
        if (isBlankHorizontal(tailOnLine)) {
          pos = nlAfter + 1;
          continue;
        }
        openFence = nextFenceState(tailOnLine, openFence);
        gapStart = lineEndAfter;
        lastStrippedEnd = -1;
        pos = nlAfter + 1;
        continue;
      }
    }

    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      if (lastStrippedEnd === gapStart && isOnlyAsciiWhitespaceFrom(text, gapStart)) {
        output += text.slice(cursor, gapStart);
      } else {
        output += text.slice(cursor);
      }
      return {
        text: output,
        strippedLeadingBlock: strippedLeading && !emittedBefore && output.length === 0,
      };
    }

    const lineEnd = nl > pos && text[nl - 1] === '\r' ? nl - 1 : nl;
    const line = text.slice(pos, lineEnd);
    openFence = nextFenceState(line, openFence);
    if (openFence === null && isBlankHorizontal(line)) {
      if (gapStart === pos && pos > 0 && lastStrippedEnd !== gapStart) {
        gapStart = lineEnd;
      }
    } else {
      gapStart = lineEnd;
      lastStrippedEnd = -1;
      strippedLeading = false;
    }
    pos = nl + 1;
  }

  if (lastStrippedEnd === gapStart && isOnlyAsciiWhitespaceFrom(text, gapStart)) {
    output += text.slice(cursor, gapStart);
  } else {
    output += text.slice(cursor);
  }
  return {
    text: output,
    strippedLeadingBlock: strippedLeading && !emittedBefore && output.length === 0,
  };
}

/**
 * Return the append-only prefix of a streaming assistant snapshot with respect
 * to leaked synthetic system notifications. Incomplete
 * `(user\n)?<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]...`
 * tails at a line start outside fenced code blocks are held until they either
 * resolve as ordinary prose or complete with `</system-reminder>`. Ordinary
 * newlines without a matching prefix are never held.
 */
export function stableLeakedSystemNotificationBoundary(
  text: string,
  initialState?: Readonly<StreamNotificationState>,
): number {
  let openFence: FenceState | null = initialState?.openFence ?? null;
  let linePrefix = initialState?.linePrefix ?? '';
  const strippedLeading = initialState?.strippedLeadingBlock ?? false;
  let pos = 0;

  if (initialState && !initialState.atLineStart) {
    const nl = text.indexOf('\n', 0);
    if (nl === -1) return text.length;
    const lineEnd = nl > 0 && text[nl - 1] === '\r' ? nl - 1 : nl;
    const fullLine = appendLinePrefix(linePrefix, text.slice(0, lineEnd));
    if (fullLine !== '!') {
      openFence = nextFenceState(fullLine, openFence);
    }
    linePrefix = '';
    pos = nl + 1;
  } else if (strippedLeading) {
    pos = consumeLeadingBlankLines(text, 0);
    if (pos === text.length) return text.length;
    let p = pos;
    while (p < text.length && isHorizontalSpace(text[p])) p += 1;
    if (p === text.length || (p === text.length - 1 && text[p] === '\r')) {
      return pos;
    }
  }

  while (pos < text.length) {
    if (openFence === null) {
      const header = matchLeakedNotificationHeader(text, pos);
      if (header.kind === 'incomplete') {
        return pos;
      }
      if (header.kind === 'confirmed') {
        const closeIdx = text.indexOf(LEAKED_SYSTEM_REMINDER_CLOSE, header.afterMarker);
        if (closeIdx === -1) {
          return pos;
        }
        pos = closeIdx + LEAKED_SYSTEM_REMINDER_CLOSE.length;
        if (pos === text.length) return text.length;
        const nlAfter = text.indexOf('\n', pos);
        if (nlAfter === -1) return text.length;
        const lineEndAfter = nlAfter > pos && text[nlAfter - 1] === '\r' ? nlAfter - 1 : nlAfter;
        const tailOnLine = text.slice(pos, lineEndAfter);
        if (!isBlankHorizontal(tailOnLine)) {
          openFence = nextFenceState(tailOnLine, openFence);
        }
        pos = nlAfter + 1;
        continue;
      }
    }

    const nl = text.indexOf('\n', pos);
    if (nl === -1) return text.length;
    const lineEnd = nl > pos && text[nl - 1] === '\r' ? nl - 1 : nl;
    const line = text.slice(pos, lineEnd);
    openFence = nextFenceState(line, openFence);
    pos = nl + 1;
  }

  return text.length;
}

function unfinishedWebCitationOpen(text: string): number {
  let from = 0;
  for (;;) {
    const open = text.indexOf(WEB_CITATION_OPEN, from);
    if (open === -1) return -1;
    const close = text.indexOf(WEB_CITATION_CLOSE, open + WEB_CITATION_OPEN.length);
    if (close === -1) return open;
    from = close + WEB_CITATION_CLOSE.length;
  }
}

function partialWebCitationPrefixStart(text: string): number {
  const maxProbe = Math.min(text.length, WEB_CITATION_OPEN.length - 1);
  for (let length = maxProbe; length > 0; length -= 1) {
    if (text.endsWith(WEB_CITATION_OPEN.slice(0, length))) return text.length - length;
  }
  return text.length;
}

/**
 * Return the append-only prefix of a streaming assistant snapshot. A Web
 * citation tail is withheld until its closing delimiter arrives, because the
 * whole marker will disappear from the visible text once complete.
 */
export function stableInternalWebCitationBoundary(text: string): number {
  const unfinished = unfinishedWebCitationOpen(text);
  return unfinished === -1 ? partialWebCitationPrefixStart(text) : unfinished;
}

/**
 * Strip complete Web citation markers plus an unfinished final marker/prefix,
 * leaked synthetic system-notification blocks, and standalone model stop
 * tokens. Ordinary prose and fenced code blocks are left untouched. The
 * transform is idempotent.
 */
export function stripInternalWebCitations(text: string): string {
  return stripStandaloneModelStopToken(
    stripLeakedSystemNotificationBlocks(stripInternalWebCitationMarkers(text)),
  );
}

function stripInternalWebCitationMarkers(text: string): string {
  if (!text.includes('\uE200')) return text;

  const stableEnd = stableInternalWebCitationBoundary(text);
  const stable = stableEnd === text.length ? text : text.slice(0, stableEnd);
  if (!stable.includes(WEB_CITATION_OPEN)) return stable;

  let output = '';
  let from = 0;
  for (;;) {
    const open = stable.indexOf(WEB_CITATION_OPEN, from);
    if (open === -1) return output + stable.slice(from);
    const close = stable.indexOf(WEB_CITATION_CLOSE, open + WEB_CITATION_OPEN.length);
    if (close === -1) return output + stable.slice(from, open);
    output += stable.slice(from, open);
    from = close + WEB_CITATION_CLOSE.length;
  }
}

function matchStopTokenAt(text: string, index: number): string | null {
  for (const token of MODEL_STOP_TOKEN_LIST) {
    if (text.startsWith(token, index)) return token;
  }
  return null;
}

function isIncompleteStopTokenPrefix(text: string): boolean {
  return text.length > 0
    && text.length <= LONGEST_MODEL_STOP_TOKEN
    && MODEL_STOP_TOKEN_LIST.some((token) => token.startsWith(text));
}

/**
 * Eat a leading run of known stop tokens and the whitespace around them.
 * Completed messages only disappear when nothing remains. The streaming
 * hold keeps a recognized run pending until later prose proves the block
 * is not stop-control-only, then emits that original text.
 */
function consumeLeadingStopControl(text: string): { remainder: string; consumedToken: boolean } {
  let index = 0;
  let consumedToken = false;
  while (index < text.length) {
    if ((text[index] ?? '').trim() === '') {
      index += 1;
      continue;
    }
    const token = matchStopTokenAt(text, index);
    if (!token) break;
    consumedToken = true;
    index += token.length;
  }
  return { remainder: text.slice(index), consumedToken };
}

/**
 * Drop a leaked stop-token run only when it is the whole assistant
 * message (optional surrounding whitespace). Repeated or mixed tokens
 * still count. Mentions such as `The token is <|eos|>`, or a token
 * glued to later prose (`<|eos|>answer`), stay intact.
 */
export function stripStandaloneModelStopToken(text: string): string {
  const { remainder, consumedToken } = consumeLeadingStopControl(text);
  return consumedToken && remainder.length === 0 ? '' : text;
}

/**
 * True while `text` is still only stop-token control: whitespace, one or
 * more known tokens, and at most one incomplete prefix (`<`, `<|eo`, …).
 * Used to hold streaming deltas until the leftover can be dropped or flushed.
 */
export function isPossibleStandaloneStopPrefix(text: string): boolean {
  const { remainder } = consumeLeadingStopControl(text);
  return remainder.length === 0 || isIncompleteStopTokenPrefix(remainder);
}

/**
 * Return the append-only prefix of a streaming snapshot. A standalone
 * leftover — including repeated tokens and an incomplete `<|eos` prefix —
 * is withheld until the closer arrives, because the completed control
 * will disappear.
 */
export function stableStandaloneModelStopTokenBoundary(text: string): number {
  return isPossibleStandaloneStopPrefix(text) ? 0 : text.length;
}

export interface StandaloneStopTokenHold {
  pending: string;
  emitted: boolean;
}

/**
 * Hold leftover stop-token control until this stream has either completed
 * it or proven it is ordinary prose. A recognized run stays pending so a
 * later `answer` can still reconstruct `<|eos|>answer`; only a later copy
 * of the same control run is dropped. After visible prose starts, still
 * hold an unfinished Web-citation tail so split markers are not emitted
 * raw. The buffer is per stream; callers must not share it across
 * concurrent text streams.
 */
export function holdStandaloneStopTokenDelta(
  buffer: StandaloneStopTokenHold,
  delta: string,
): string | null {
  const combined = buffer.pending + delta;
  if (!buffer.emitted) {
    const { remainder } = consumeLeadingStopControl(combined);
    if (remainder.length === 0 || isIncompleteStopTokenPrefix(remainder)) {
      buffer.pending = combined;
      return null;
    }
  }
  const streamState = getStreamNotificationState(buffer);
  const citationEnd = stableInternalWebCitationBoundary(combined);
  const notificationEnd = stableLeakedSystemNotificationBoundary(combined, streamState);
  const stableEnd = Math.min(citationEnd, notificationEnd);
  buffer.pending = combined.slice(stableEnd);
  const stable = combined.slice(0, stableEnd);
  if (stable.length === 0) return null;

  const withoutCitations = stripInternalWebCitationMarkers(stable);
  const stripped = stripLeakedSystemNotificationBlocksInternal(
    withoutCitations,
    streamState,
    buffer.emitted,
  );
  const visible = buffer.emitted
    ? stripped.text
    : stripStandaloneModelStopToken(stripped.text);
  streamState.strippedLeadingBlock = stripped.strippedLeadingBlock;
  if (!buffer.emitted && stripped.text.length > 0 && visible.length === 0) {
    // Stripping a leaked notification exposed a standalone stop-token run; keep
    // it pending so later prose can still reconstruct it, matching Grok handling.
    buffer.pending = stripped.text + buffer.pending;
    return null;
  }
  if (visible.length > 0) {
    advanceStreamNotificationState(streamState, visible);
    buffer.emitted = true;
    streamState.strippedLeadingBlock = false;
    return visible;
  }
  return null;
}
