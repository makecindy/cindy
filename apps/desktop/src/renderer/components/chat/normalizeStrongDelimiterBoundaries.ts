/**
 * 放宽 AI 常见的中文加粗写法。
 *
 * CommonMark 的双星号收尾规则要求：如果加粗内容以标点结束、而右侧
 * 双星号后面紧接普通字符，这组双星号只能被识别为“开始”而不能被识别为
 * “结束”。例如 `**重点。**下一句` 会整段按原文显示。
 *
 * 这里不改用户看到的文字，只在这类已经存在未闭合加粗起点的收尾后插入
 * 一个会被 MarkdownRenderer 的 `skipHtml` 丢弃的 HTML 注释。代码块、行内
 * 代码、转义星号和三颗以上的星号序列保持原样。
 */

const HIDDEN_SEPARATOR = '<!--cindy-strong-boundary-->';
const UNICODE_WHITESPACE_RE = /^\s$/u;
const UNICODE_PUNCTUATION_RE = /^[\p{P}\p{S}]$/u;

interface NormalizationState {
  fencedCode: { marker: '`' | '~'; length: number } | null;
  inlineCodeLength: number | null;
  openStrongCount: number;
}

function classifyCharacter(character: string | undefined): 'whitespace' | 'punctuation' | 'other' {
  if (!character || UNICODE_WHITESPACE_RE.test(character)) return 'whitespace';
  if (UNICODE_PUNCTUATION_RE.test(character)) return 'punctuation';
  return 'other';
}

function characterBefore(text: string, index: number): string | undefined {
  if (index === 0) return undefined;
  const characters = Array.from(text.slice(Math.max(0, index - 2), index));
  return characters.length > 0 ? characters[characters.length - 1] : undefined;
}

function characterAfter(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isFenceStart(line: string): { marker: '`' | '~'; length: number } | null {
  const match = line.match(/^ {0,3}([`~]{3,})/);
  if (!match) return null;
  const run = match[1];
  if (!run || run.split('').some((character) => character !== run[0])) return null;
  return { marker: run[0] as '`' | '~', length: run.length };
}

function isFenceEnd(line: string, fence: NonNullable<NormalizationState['fencedCode']>): boolean {
  const match = line.match(/^ {0,3}([`~]+)[ \t]*$/);
  if (!match || match[1][0] !== fence.marker) return false;
  return match[1].length >= fence.length;
}

function normalizeInlineLine(line: string, state: NormalizationState): string {
  let output = '';
  let cursor = 0;

  while (cursor < line.length) {
    const character = line[cursor];

    if (character === '`') {
      let runEnd = cursor + 1;
      while (runEnd < line.length && line[runEnd] === '`') runEnd += 1;
      const runLength = runEnd - cursor;

      if (state.inlineCodeLength === null) {
        if (!isEscaped(line, cursor)) state.inlineCodeLength = runLength;
      } else if (state.inlineCodeLength === runLength) {
        state.inlineCodeLength = null;
      }

      output += line.slice(cursor, runEnd);
      cursor = runEnd;
      continue;
    }

    if (state.inlineCodeLength !== null || character !== '*') {
      output += character;
      cursor += 1;
      continue;
    }

    let runEnd = cursor + 1;
    while (runEnd < line.length && line[runEnd] === '*') runEnd += 1;
    const runLength = runEnd - cursor;

    // `***` 及更长序列使用另一套配对规则。这里不猜测其意图，同时清掉
    // 当前配对状态，避免后续双星号跨过不支持的序列发生误配。
    if (runLength !== 2 || isEscaped(line, cursor)) {
      output += line.slice(cursor, runEnd);
      state.openStrongCount = 0;
      cursor = runEnd;
      continue;
    }

    const before = classifyCharacter(characterBefore(line, cursor));
    const after = classifyCharacter(characterAfter(line, runEnd));
    const canOpen = after !== 'whitespace' && (after !== 'punctuation' || before !== 'other');
    const canClose = before !== 'whitespace' && (before !== 'punctuation' || after !== 'other');

    if (canClose && state.openStrongCount > 0) {
      state.openStrongCount -= 1;
      output += '**';
    } else if (before === 'punctuation' && after === 'other' && state.openStrongCount > 0) {
      // CommonMark 因右侧紧接普通字符而把它视为起点；前面尚未配对的
      // `**` 表明这其实是 AI 句子想表达的收尾。
      state.openStrongCount -= 1;
      output += `**${HIDDEN_SEPARATOR}`;
    } else {
      if (canOpen) state.openStrongCount += 1;
      output += '**';
    }

    cursor = runEnd;
  }

  return output;
}

/**
 * 让“以标点结束、后面紧接正文”的加粗片段能被解析，同时不改变可见
 * 消息和代码示例。
 */
export function normalizeStrongDelimiterBoundaries(markdown: string): string {
  if (!markdown.includes('**')) return markdown;

  const state: NormalizationState = {
    fencedCode: null,
    inlineCodeLength: null,
    openStrongCount: 0,
  };
  const parts = markdown.split(/(\r\n|\n|\r)/);
  let output = '';

  for (const part of parts) {
    if (/^(?:\r\n|\n|\r)$/.test(part)) {
      output += part;
      continue;
    }

    if (state.fencedCode) {
      output += part;
      if (isFenceEnd(part, state.fencedCode)) {
        state.fencedCode = null;
        state.inlineCodeLength = null;
        state.openStrongCount = 0;
      }
      continue;
    }

    if (part.trim() === '' || /^(?: {4}|\t)/.test(part)) {
      output += part;
      state.inlineCodeLength = null;
      state.openStrongCount = 0;
      continue;
    }

    const fence = state.inlineCodeLength === null ? isFenceStart(part) : null;
    if (fence) {
      output += part;
      state.fencedCode = fence;
      state.openStrongCount = 0;
      continue;
    }

    output += normalizeInlineLine(part, state);
  }

  return output;
}
