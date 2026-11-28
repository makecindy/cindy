/**
 * remarkStrictInlineMath — 在 micromark 词法层收紧 remark-math 的 inline math 规则。
 *
 * 背景:micromark-extension-math 默认的 `mathText` 沿用 code-span 语义,允许内容
 * 首尾空白、跨行、横跨反引号与 Markdown 链接。此前在 AST 层事后把松散配对降级成
 * 纯文本 `Text` 节点,虽然挡住了 KaTeX 误渲染,但两个货币 `$` 之间夹着的行内代码、
 * 链接、加粗等(如「$11,629.25 … `GST31032027` … [链接](url) … NZ$5M」)已经在词法
 * 阶段被吞成裸文本,降级后永久丢失格式;前面一个货币 `$5` 也会抢走同一行后方真实
 * `$x+1$` 公式的开定界符。
 *
 * 本插件紧随 `remarkMath` 注册,在 parse 阶段替换其 `text[36]` (`mathText`)
 * construct,将与移动端 parser (`apps/mobile messageMarkdown.ts`) 同口径的严格规则
 * 前移到分词期——不满足时直接返回 `nok`,由 micromark 回退把开 `$` 当普通字符继续
 * 正常解析后续 Markdown:
 *
 * - 单 `$`(Pandoc 紧贴规则):开 `$` 后与闭 `$` 前均不得为空白;内容不得跨行、不得含
 *   反引号 `` ` `` 或其它 `$` 序列;闭 `$` 后不得紧跟 ASCII 数字(`$5和$10`、`NZ$5M`)。
 * - 双 `$$` 及以上行内形态:允许首尾空白与后接数字(`$$ a + b $$`),仍禁止纯空白、
 *   跨行、反引号及不匹配的 `$` 序列。
 *
 * 只替换 inline `mathText`;块级 display math (`mathFlow`, `$$` 围栏)保持原样。
 */

import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import type {
  Code,
  Construct,
  Effects,
  Event,
  Extension,
  State,
  Token,
  TokenizeContext,
} from 'micromark-util-types';

const DOLLAR_SIGN = 36;
const SPACE = 32;
const BACKTICK = 96;

// `micromark-extension-math` 是 remark-math 的传递依赖,不会在 desktop 直接 import;
// 其扩展的 math token 名由 mdast-util-math 在运行期消费,此处统一收口为 Token['type']。
const TOKEN_MATH_TEXT = 'mathText' as Token['type'];
const TOKEN_MATH_TEXT_SEQUENCE = 'mathTextSequence' as Token['type'];
const TOKEN_MATH_TEXT_DATA = 'mathTextData' as Token['type'];
const TOKEN_MATH_TEXT_PADDING = 'mathTextPadding' as Token['type'];

function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

function isWhitespace(code: Code): boolean {
  if (code === null) return false;
  if (code < 0 || code === SPACE) return true;
  return code > 127 && /\s/.test(String.fromCharCode(code));
}

function isAsciiDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

function previous(this: TokenizeContext, code: Code): boolean {
  return (
    code !== DOLLAR_SIGN ||
    this.events[this.events.length - 1]?.[1].type === 'characterEscape'
  );
}

function tokenizeStrictMathText(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  let sizeOpen = 0;
  let size = 0;
  let hasContent = false;
  let hasNonSpace = false;
  let lastWasWhitespace = false;

  return start;

  function start(code: Code): State | undefined {
    effects.enter(TOKEN_MATH_TEXT);
    effects.enter(TOKEN_MATH_TEXT_SEQUENCE);
    return sequenceOpen(code);
  }

  function sequenceOpen(code: Code): State | undefined {
    if (code === DOLLAR_SIGN) {
      effects.consume(code);
      sizeOpen += 1;
      return sequenceOpen;
    }

    if (
      code === null ||
      isLineEnding(code) ||
      code === BACKTICK ||
      (sizeOpen === 1 && isWhitespace(code))
    ) {
      return nok(code);
    }

    effects.exit(TOKEN_MATH_TEXT_SEQUENCE);
    return between(code);
  }

  function between(code: Code): State | undefined {
    if (code === null || isLineEnding(code) || code === BACKTICK) {
      return nok(code);
    }

    if (code === DOLLAR_SIGN) {
      effects.enter(TOKEN_MATH_TEXT_SEQUENCE);
      size = 0;
      return sequenceClose(code);
    }

    if (code === SPACE) {
      effects.enter('space');
      effects.consume(code);
      effects.exit('space');
      hasContent = true;
      lastWasWhitespace = true;
      return between;
    }

    effects.enter(TOKEN_MATH_TEXT_DATA);
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (
      code === null ||
      code === SPACE ||
      code === DOLLAR_SIGN ||
      code === BACKTICK ||
      isLineEnding(code)
    ) {
      effects.exit(TOKEN_MATH_TEXT_DATA);
      return between(code);
    }

    effects.consume(code);
    hasContent = true;
    const ws = isWhitespace(code);
    if (!ws) hasNonSpace = true;
    lastWasWhitespace = ws;
    return data;
  }

  function sequenceClose(code: Code): State | undefined {
    if (code === DOLLAR_SIGN) {
      effects.consume(code);
      size += 1;
      return sequenceClose;
    }

    // 与移动端 `[^$`\n]` 口径对齐:行内公式内不允许其它长度的 `$` 序列,同时
    // 保证任意 `$` 序列都在遇到下一个 `$` 时立即收敛,维持严格 O(n) 线性时间。
    if (size !== sizeOpen) {
      return nok(code);
    }

    if (
      !hasContent ||
      !hasNonSpace ||
      (sizeOpen === 1 && (lastWasWhitespace || isAsciiDigit(code)))
    ) {
      return nok(code);
    }

    effects.exit(TOKEN_MATH_TEXT_SEQUENCE);
    effects.exit(TOKEN_MATH_TEXT);
    return ok(code);
  }
}

function resolveStrictMathText(events: Event[]): Event[] {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;

  // 双 dollar 行内公式(`$$ a + b $$`)沿用 micromark-extension-math 规则剥掉
  // 首尾各一格 space padding。
  if (
    headEnterIndex < tailExitIndex &&
    events[headEnterIndex][1].type === 'space' &&
    events[tailExitIndex][1].type === 'space'
  ) {
    let probe = headEnterIndex;
    while (++probe < tailExitIndex) {
      if (events[probe][1].type === TOKEN_MATH_TEXT_DATA) {
        events[tailExitIndex][1].type = TOKEN_MATH_TEXT_PADDING;
        events[headEnterIndex][1].type = TOKEN_MATH_TEXT_PADDING;
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  // 把正文内相邻的 space 与 mathTextData 合并为单个 mathTextData,供 mdast-util-math 消费。
  let index = headEnterIndex - 1;
  tailExitIndex += 1;
  let enter: number | undefined;
  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex) enter = index;
    } else if (index === tailExitIndex) {
      events[enter][1].type = TOKEN_MATH_TEXT_DATA;
      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }
      enter = undefined;
    }
  }

  return events;
}

const STRICT_MATH_TEXT_CONSTRUCT: Construct = {
  name: 'mathText',
  tokenize: tokenizeStrictMathText,
  resolve: resolveStrictMathText,
  previous,
};

const remarkStrictInlineMath: Plugin<[], Root> = function remarkStrictInlineMath() {
  const data = this.data() as { micromarkExtensions?: Extension[] };
  const extensions = data.micromarkExtensions;
  if (!Array.isArray(extensions)) return;
  for (let i = 0; i < extensions.length; i += 1) {
    const ext = extensions[i];
    if (ext?.text && DOLLAR_SIGN in ext.text) {
      extensions[i] = {
        ...ext,
        text: {
          ...ext.text,
          [DOLLAR_SIGN]: STRICT_MATH_TEXT_CONSTRUCT,
        },
      };
    }
  }
};

export default remarkStrictInlineMath;
