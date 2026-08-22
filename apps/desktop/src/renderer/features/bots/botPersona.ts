/**
 * The "调整性格" (Adjust personality) wizard's compile target.
 *
 * The wizard never owns a field of its own — a persisted teammate only has
 * `identitySource` (free-text prompt material, see `botTemplates.ts`). So the
 * three-step selection is compiled into a small, clearly-delimited block that
 * lives *inside* `identitySource`, written in the same voice as the shipped
 * templates (a Chinese first-person line + an English durable-instruction
 * line — see `BOT_TEMPLATES` in `botTemplates.ts`). That block is real prompt
 * material the model reads, not a settings echo.
 *
 * The block is fenced by a stable HTML-comment marker
 * (`<!--persona:v1:{...json...}-->`) so re-opening the wizard can find its own
 * output again and *replace* it in place, without disturbing anything the user
 * hand-wrote before or after it. A user who never opens the wizard has no
 * marker at all — `extractPersonaFromIdentitySource` returns `null` and the
 * "TA 是谁" block falls back to showing nothing rather than a fabricated
 * summary.
 */

export type PersonaStyle = 'concise' | 'lively' | 'steady';
export type PersonaProactivity = 'reactive' | 'proactive' | 'reportAll';
export type PersonaCallForm = 'name' | 'boss' | 'custom';

export interface PersonaSelection {
  style: PersonaStyle;
  proactivity: PersonaProactivity;
  /** How the teammate addresses the owner. */
  call: PersonaCallForm;
  /** Required and non-empty iff `call === 'custom'`. */
  customCall?: string;
}

export const PERSONA_STYLE_OPTIONS: readonly PersonaStyle[] = ['concise', 'lively', 'steady'];
export const PERSONA_PROACTIVITY_OPTIONS: readonly PersonaProactivity[] = [
  'reactive',
  'proactive',
  'reportAll',
];
export const PERSONA_CALL_OPTIONS: readonly PersonaCallForm[] = ['name', 'boss', 'custom'];

const MARKER_PREFIX = '<!--persona:v1:';
const MARKER_SUFFIX = '-->';
/** Fixed: the marker line is always followed by exactly one zh line and one en line. */
const DESCRIPTION_LINE_COUNT = 2;

const STYLE_FRAGMENTS: Record<PersonaStyle, { zh: string; en: string }> = {
  concise: {
    zh: '说话简洁利落，直接说重点。',
    en: 'Keep replies concise and to the point.',
  },
  lively: {
    zh: '说话活泼爱聊，带点热络的语气。',
    en: 'Keep a lively, chatty tone.',
  },
  steady: {
    zh: '说话稳重周到，先讲清楚再动手。',
    en: 'Keep a steady, thorough tone; explain before acting.',
  },
};

const PROACTIVITY_FRAGMENTS: Record<PersonaProactivity, { zh: string; en: string }> = {
  reactive: {
    zh: '有事才说，没事不主动打扰。',
    en: 'Only speak up when there is something to report; do not proactively interrupt.',
  },
  proactive: {
    zh: '该提醒的会主动提醒。',
    en: 'Proactively remind about things that matter, without waiting to be asked.',
  },
  reportAll: {
    zh: '但凡有进展都主动汇报。',
    en: 'Proactively report every bit of progress, however small.',
  },
};

function callFragment(selection: PersonaSelection): { zh: string; en: string } {
  if (selection.call === 'boss') {
    return { zh: '称呼对方「老板」。', en: 'Address the owner as "老板" (boss).' };
  }
  if (selection.call === 'custom') {
    const label = (selection.customCall ?? '').trim();
    if (!label) return { zh: '直呼对方名字即可。', en: 'Address the owner by their name.' };
    return { zh: `称呼对方「${label}」。`, en: `Address the owner as "${label}".` };
  }
  return { zh: '直呼对方名字即可。', en: 'Address the owner by their name.' };
}

function isPersonaStyle(value: unknown): value is PersonaStyle {
  return typeof value === 'string' && (PERSONA_STYLE_OPTIONS as readonly string[]).includes(value);
}

function isPersonaProactivity(value: unknown): value is PersonaProactivity {
  return (
    typeof value === 'string' && (PERSONA_PROACTIVITY_OPTIONS as readonly string[]).includes(value)
  );
}

function isPersonaCallForm(value: unknown): value is PersonaCallForm {
  return typeof value === 'string' && (PERSONA_CALL_OPTIONS as readonly string[]).includes(value);
}

/** Validates an arbitrary decoded JSON value into a `PersonaSelection`, or `null`. */
function validateSelection(value: unknown): PersonaSelection | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isPersonaStyle(record.style)) return null;
  if (!isPersonaProactivity(record.proactivity)) return null;
  if (!isPersonaCallForm(record.call)) return null;
  if (record.call === 'custom') {
    if (typeof record.customCall !== 'string' || !record.customCall.trim()) return null;
    return { style: record.style, proactivity: record.proactivity, call: 'custom', customCall: record.customCall };
  }
  return { style: record.style, proactivity: record.proactivity, call: record.call };
}

function renderPersonaBlock(selection: PersonaSelection): string {
  const json = JSON.stringify(
    selection.call === 'custom'
      ? { style: selection.style, proactivity: selection.proactivity, call: 'custom', customCall: selection.customCall }
      : { style: selection.style, proactivity: selection.proactivity, call: selection.call },
  );
  const style = STYLE_FRAGMENTS[selection.style];
  const proactivity = PROACTIVITY_FRAGMENTS[selection.proactivity];
  const call = callFragment(selection);
  const zhLine = `${style.zh}${proactivity.zh}${call.zh}`;
  const enLine = `${style.en} ${proactivity.en} ${call.en}`;
  return `${MARKER_PREFIX}${json}${MARKER_SUFFIX}\n${zhLine}\n${enLine}`;
}

function indexAfterLines(source: string, fromIndex: number, lineCount: number): number {
  let idx = fromIndex;
  for (let i = 0; i < lineCount; i += 1) {
    const nl = source.indexOf('\n', idx);
    if (nl === -1) return source.length;
    idx = nl + 1;
  }
  return idx;
}

interface MarkerBlockLocation {
  start: number;
  end: number;
  json: string;
}

/** Locates the wizard's own block; returns `null` if no marker is present. */
function findMarkerBlock(source: string): MarkerBlockLocation | null {
  const start = source.indexOf(MARKER_PREFIX);
  if (start === -1) return null;
  const jsonStart = start + MARKER_PREFIX.length;
  const suffixIndex = source.indexOf(MARKER_SUFFIX, jsonStart);
  if (suffixIndex === -1) return null;
  const json = source.slice(jsonStart, suffixIndex);
  // Consume the marker line's own newline plus the fixed description lines
  // that follow it (or the end of the string, whichever comes first).
  const end = indexAfterLines(source, suffixIndex + MARKER_SUFFIX.length, 1 + DESCRIPTION_LINE_COUNT);
  return { start, end, json };
}

/**
 * Reads back a previously-compiled selection, e.g. to pre-fill the wizard on
 * reopen. Returns `null` when there is no marker, or the marker is malformed
 * (hand-edited, truncated, from a future format version) — callers must treat
 * that the same as "never configured", never throw it at the user.
 */
export function extractPersonaFromIdentitySource(identitySource: string): PersonaSelection | null {
  const block = findMarkerBlock(identitySource);
  if (!block) return null;
  try {
    return validateSelection(JSON.parse(block.json));
  } catch {
    return null;
  }
}

/**
 * Writes `selection` into `identitySource`, replacing a previous wizard block
 * in place if one exists, or appending a new one. Everything outside the
 * marked segment — including content the user typed by hand before ever
 * opening the wizard — passes through untouched (module whitespace right at
 * the join point is normalized to a single blank line, which is the same
 * separator the shipped templates use between their own lines).
 */
export function compilePersonaIntoIdentitySource(identitySource: string, selection: PersonaSelection): string {
  const block = renderPersonaBlock(selection);
  const existing = findMarkerBlock(identitySource);
  const before = existing ? identitySource.slice(0, existing.start) : identitySource;
  const after = existing ? identitySource.slice(existing.end) : '';
  const trimmedBefore = before.replace(/\s+$/, '');
  const trimmedAfter = after.replace(/^\s+/, '');
  return [trimmedBefore, block, trimmedAfter].filter((part) => part.length > 0).join('\n\n');
}

/**
 * Removes the wizard's block entirely, leaving any surrounding hand-written
 * content intact. This is also the read side of the "背景设定" editor — see
 * {@link readBotBackground}.
 */
export function removePersonaFromIdentitySource(identitySource: string): string {
  const existing = findMarkerBlock(identitySource);
  if (!existing) return identitySource;
  const before = identitySource.slice(0, existing.start).replace(/\s+$/, '');
  const after = identitySource.slice(existing.end).replace(/^\s+/, '');
  return [before, after].filter((part) => part.length > 0).join('\n\n');
}

/*
  ── 分段管理:向导段 vs 背景正文段 ─────────────────────────────────────────

  `identitySource` 是一份自由文本,但它其实住着**两个作者**:

    1. 「调整性格」向导 —— 只写 marker 围起来的那一段(说话风格 / 主动程度 /
       称呼)。它已经会原地替换自己那段,不碰别人的字。
    2. 用户和模板 —— 剩下的全部,也就是这个伙伴到底是谁、负责什么。模板选卡时
       写进来的那几行完整背景设定就在这一段里。

  在这一批之前,第二段在界面上**根本没有入口**:设置页只显示向导编译出的人格
  摘要,模板写进来的背景正文用户看不到也改不了,唯一能碰到它的地方是向导里那个
  折叠起来的「高级:自己写设定」——它一次性覆盖**整份** identitySource,既藏得深
  又容易连 marker 一起被删掉。

  所以本批把第二段提到设置页「TA 是谁」里做成一等公民(「背景设定」子块),并把
  向导里那个手写逃生口撤掉:两段各有各的编辑入口,谁也不会整体覆盖谁。下面这对
  读 / 写函数就是这条边界的实现——读时剥掉向导段,写时把向导段原样接回去。
*/

/** 向导段的原文(含 marker 行与它后面的固定描述行);没有 marker 时返回 null。 */
export function extractPersonaBlockText(identitySource: string): string | null {
  const block = findMarkerBlock(identitySource);
  if (!block) return null;
  return identitySource.slice(block.start, block.end).replace(/\s+$/, '');
}

/**
 * 背景正文段 = identitySource 去掉向导段之后剩下的全部。
 *
 * 从没开过向导的伙伴(含刚从模板建出来的)没有 marker,整份就是背景正文。
 */
export function readBotBackground(identitySource: string): string {
  return removePersonaFromIdentitySource(identitySource).trim();
}

/**
 * 用新的背景正文替换掉背景段,**原样保留**向导段。
 *
 * 拼接顺序固定为「背景正文 → 向导段」,与 `compilePersonaIntoIdentitySource` 首次
 * 追加向导段时的落点一致(它把已有内容留在前面、把自己的块接在后面),所以来回
 * 编辑两段不会让文本在两种顺序之间反复跳。
 */
export function writeBotBackground(identitySource: string, background: string): string {
  const block = extractPersonaBlockText(identitySource);
  return [background.trim(), block ?? ''].filter((part) => part.length > 0).join('\n\n');
}
