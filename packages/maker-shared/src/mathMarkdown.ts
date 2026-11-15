/**
 * mathMarkdown — LaTeX 数学公式在 markdown 消息里的共用纯逻辑层。
 * desktop(react-markdown + remark-math/KaTeX)与 mobile(自研 parser +
 * WebView KaTeX / Unicode 近似)共用,保证两端定界符识别语义一致。
 *
 * 包含两块能力:
 * 1. normalizeMathDelimiters —— 把 `\(...\)` / `\[...\]` 归一化成
 *    `$...$` / `$$...$$`(两端 parser 都只需理解 dollar 定界符)。
 * 2. latexToUnicodeApproximation —— LaTeX → Unicode 文本近似,供无法嵌入
 *    KaTeX 渲染面的场景使用(mobile 原生 Text 流里的 inline 公式)。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. 定界符归一化
// ─────────────────────────────────────────────────────────────────────────────
//
// 背景:remark-math 与 mobile parser 都只解析 dollar 定界符,而 GPT 系模型
// (Codex 会话)习惯输出 `\(...\)` / `\[...\]`。这两种定界符没法在 mdast 层
// 转换——CommonMark 把 `\(` 当成 `(` 的字符转义,parse 完之后 AST 里反斜杠
// 已经消失,后处理插件看不到原始定界符。所以只能在 parse 前做字符串级预处理。
//
// 规则:
// - fenced code block(``` / ~~~)内的内容原样保留。
// - inline code span(`...`)内的内容原样保留。
// - `\[x\]` → 独立的 `$$` 块(display math,前后补空行强制成块)。
// - `\(x\)` → `$x$`(inline math)。
// - 未闭合的定界符(streaming 中途)不动,等闭合后自然转换。
//
// 已知边界(接受,不做处理):
// - 4 空格缩进式 code block 内的定界符会被误转(LLM 输出几乎只用 fence)。
// - inline 内容里含裸 `$` 时 parser 会提前截断(math 内容里出现货币符本身
//   就是非法 LaTeX,罕见)。
// - display 展开会插入换行改变行号,需要 source-line 保真的调用方(desktop
//   TextLightbox 行锚点 doc 模式、mobile 文件阅读器 targetLine 定位)应跳过
//   本函数,由各端渲染层按对应开关门控。

// fence 开行:≤3 空格缩进 + ≥3 个 ` 或 ~(CommonMark 规则)。
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** normalizeMathDelimiters 选项。 */
export interface NormalizeMathDelimitersOptions {
  /**
   * 保行数模式:只做不改变行数的转换——单行内的 `\(...\)` → `$...$`;
   * `\[...\]`(展开会插行)与跨行的 `\(...\)` 原样保留。供需要
   * source-line 保真的调用方使用(desktop TextLightbox 行锚点 doc 模式、
   * mobile 文件阅读器 targetLine 定位):行内公式照常渲染,只牺牲
   * display 公式(保持源码展示)。
   */
  preserveLineCount?: boolean;
}

// ⚠️ 定界符与 code span 的匹配一律用 indexOf 线性扫描,不用回溯正则:
// 聊天内容是不受控输入,`\\[([\s\S]+?)\\]` / `(`+)[\s\S]*?\1` 这类非贪婪
// 回溯模式在「大量未闭合开定界符 / 大量反引号」的对抗性输入上是 O(n²)
// (CodeQL js/polynomial-redos,PR #656 实报)。

// reference 式链接定义行:≤3 空格缩进 + [label]:(单字符类 + 行锚点,线性)。
// 整行(destination + 可选 title)纳入保护——定义行不是 prose,行上不存在
// 合法的数学公式场景,整行保护安全且省去 destination/title 的精细切分。
const LINK_REFERENCE_DEFINITION_RE = /^ {0,3}\[[^\]\n]*\]:/gm;

/**
 * markdown 链接目标的保护区间,两类形态(review 分两轮实捉):
 * - inline:`](` 到与之配平的 `)`(反斜杠转义感知、不跨行);
 * - reference 定义:`[label]: dest` 整行。
 * `[log](./run\(1\).md)` / `[r]: ./run\(1\).md` 里的 URL 转义括号都不能被
 * 当成数学定界符改写。单调推进,线性复杂度;结果按起点排序供单指针消费。
 */
function findLinkDestinationRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('](', i);
    if (open === -1) break;
    let j = open + 2;
    let depth = 1;
    while (j < text.length && depth > 0) {
      const ch = text[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '\n') break; // destination 不跨行,视为未闭合
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      j += 1;
    }
    if (depth === 0) ranges.push([open, j]);
    // 无论是否闭合都推进到已扫过的位置,不回头重扫
    i = Math.max(open + 2, j);
  }
  for (const match of text.matchAll(LINK_REFERENCE_DEFINITION_RE)) {
    const lineEnd = text.indexOf('\n', match.index);
    ranges.push([match.index, lineEnd === -1 ? text.length : lineEnd]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * 单段纯文本(已排除 code)内做定界符替换。indexOf 单遍扫描,线性复杂度。
 * 双指针:consumed 是 out 已覆盖到的位置,scan 是扫描位置——跳过分支只推进
 * scan、不动 consumed,被跳过的文本由下一次成功替换或结尾统一搬运。
 */
function transformMathInText(text: string, preserveLineCount: boolean): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  // link destination 内的 \( \) \[ \] 是 URL 转义,整段保护不参与转换。
  // 惰性条件覆盖两种形态:inline 的 `](` 与 reference 定义的 `]:`。
  const protectedRanges =
    text.includes('](') || text.includes(']:') ? findLinkDestinationRanges(text) : [];
  let rangeIndex = 0;
  const inProtectedRange = (pos: number): number => {
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex][1] <= pos) rangeIndex += 1;
    const range = protectedRanges[rangeIndex];
    return range && pos >= range[0] && pos < range[1] ? range[1] : -1;
  };
  let out = '';
  let consumed = 0;
  let scan = 0;
  // closer 缺席记忆化:indexOf 一旦在某位置之后找不到 `\)` / `\]`,更靠后的
  // 搜索必然也找不到——没有这两个标记,大量未闭合 opener(如 `\[a` 重复
  // 五万次)会让每个 opener 都把 indexOf 扫到串尾,总量 O(n²)(本文件顶部
  // ReDoS 约束的 indexOf 版变体,回归测试实捉)。
  let noParenCloser = false;
  let noBracketCloser = false;
  while (scan < text.length) {
    const open = text.indexOf('\\', scan);
    if (open === -1 || open + 1 >= text.length) break;
    const kind = text[open + 1];
    if (kind !== '(' && kind !== '[') {
      // 普通反斜杠(LaTeX 命令等),跳过继续扫
      scan = open + 2;
      continue;
    }
    const protectedEnd = inProtectedRange(open);
    if (protectedEnd !== -1) {
      // 位于 link destination 内:整段跳过
      scan = protectedEnd;
      continue;
    }
    const isDisplay = kind === '[';
    if (isDisplay ? noBracketCloser : noParenCloser) {
      scan = open + 2;
      continue;
    }
    const closer = isDisplay ? '\\]' : '\\)';
    let close = -1;
    let probe = open + 2;
    while (probe < text.length) {
      const slash = text.indexOf('\\', probe);
      if (slash === -1) break;
      if (text.startsWith(closer, slash)) { close = slash; break; }
      probe = slash + 2; // Skip escaped backslashes, including \\) / \\].
    }
    if (close === -1) {
      if (isDisplay) noBracketCloser = true;
      else noParenCloser = true;
      scan = open + 2;
      continue;
    }
    // 空内容:原样保留,从定界符后继续
    if (close === open + 2) {
      scan = open + 2;
      continue;
    }
    const inner = text.slice(open + 2, close);
    // 保行数模式:display(必插行)与跨行 inline(trim 可能吃掉边缘换行)
    // 都不转换,只放行单行 inline——替换前后行数严格一致。
    if (preserveLineCount && (isDisplay || inner.includes('\n'))) {
      scan = close + 2;
      continue;
    }
    out += text.slice(consumed, open);
    out += isDisplay ? `\n\n$$\n${inner.trim()}\n$$\n\n` : `$${inner.trim()}$`;
    consumed = close + 2;
    scan = consumed;
  }
  return out + text.slice(consumed);
}

/**
 * 在非 fence 段内跳过 inline code span,只转换 span 之间的文本。
 * code span 按 CommonMark 语义定位:开 backtick 序列与**等长**闭合序列配对,
 * 长度不等的序列不闭合(indexOf 逐运行扫描,线性复杂度)。
 */
function transformOutsideInlineCode(segment: string, preserveLineCount: boolean): string {
  if (!segment.includes('`')) return transformMathInText(segment, preserveLineCount);
  let out = '';
  let cursor = 0;
  // 等长闭合缺席记忆化:某长度的闭合运行在位置 p 之后不存在,则更靠后也不
  // 存在(与 transformMathInText 的 closer 记忆化同理,防对抗性输入二次扫描)。
  const noCloserForLength = new Set<number>();
  while (cursor < segment.length) {
    const tick = segment.indexOf('`', cursor);
    if (tick === -1) break;
    let openEnd = tick;
    while (openEnd < segment.length && segment[openEnd] === '`') openEnd += 1;
    const runLength = openEnd - tick;
    // 找等长闭合序列(CommonMark 语义):逐个 backtick 运行推进
    let closeStart = -1;
    let closeEnd = openEnd;
    if (!noCloserForLength.has(runLength)) {
      let probe = openEnd;
      while (probe < segment.length) {
        const t = segment.indexOf('`', probe);
        if (t === -1) break;
        let e = t;
        while (e < segment.length && segment[e] === '`') e += 1;
        if (e - t === runLength) {
          closeStart = t;
          closeEnd = e;
          break;
        }
        probe = e;
      }
      if (closeStart === -1) noCloserForLength.add(runLength);
    }
    out += transformMathInText(segment.slice(cursor, tick), preserveLineCount);
    if (closeStart === -1) {
      // 无闭合:开序列按字面输出,其后文本继续参与转换
      out += segment.slice(tick, openEnd);
      cursor = openEnd;
      continue;
    }
    out += segment.slice(tick, closeEnd);
    cursor = closeEnd;
  }
  return out + (cursor < segment.length ? transformMathInText(segment.slice(cursor), preserveLineCount) : '');
}

export function normalizeMathDelimiters(
  markdown: string,
  options: NormalizeMathDelimitersOptions = {},
): string {
  const preserveLineCount = options.preserveLineCount === true;
  // 快速通路:绝大多数消息没有 LaTeX 定界符,零成本返回原引用
  // (引用不变 → 下游 useMemo / 渲染缓存不失效)。
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) return markdown;

  // 行级状态机切出 fenced code block,fence 内原样、fence 外做转换。
  const lines = markdown.split('\n');
  const out: string[] = [];
  let textBuf: string[] = [];
  let fenceMarker: string | null = null; // 开 fence 的字符序列,如 "```"

  const flushText = () => {
    if (textBuf.length === 0) return;
    out.push(transformOutsideInlineCode(textBuf.join('\n'), preserveLineCount));
    textBuf = [];
  };

  for (const line of lines) {
    if (fenceMarker == null) {
      const open = line.match(FENCE_OPEN_RE);
      if (open) {
        flushText();
        fenceMarker = open[1];
        out.push(line);
        continue;
      }
      textBuf.push(line);
    } else {
      out.push(line);
      // 闭 fence:同字符、长度 ≥ 开 fence、行内只剩空白(CommonMark 规则)。
      const close = line.match(FENCE_OPEN_RE);
      if (
        close &&
        close[1][0] === fenceMarker[0] &&
        close[1].length >= fenceMarker.length &&
        line.trim() === close[1]
      ) {
        fenceMarker = null;
      }
    }
  }
  flushText();
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. LaTeX → Unicode 近似
// ─────────────────────────────────────────────────────────────────────────────
//
// mobile 聊天气泡是 RN 原生 Text 流,inline 公式无法嵌 WebView/KaTeX,退而
// 求其次做文本近似:希腊字母、常用运算符映射成 Unicode,上下标尽量用
// Unicode sup/sub 字符,\frac → a/b 线性形式。目标是「简单公式可读」,
// 不追求复杂公式的完整还原(复杂公式在 display 块里走 WebView KaTeX)。

const LATEX_SYMBOL_MAP: Record<string, string> = {
  // 希腊字母(小写 + 常用大写)
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 运算符 / 关系符
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', propto: '∝',
  ll: '≪', gg: '≫',
  // 集合 / 逻辑
  in: '∈', notin: '∉', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', setminus: '∖',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  cong: '≅', perp: '⊥', parallel: '∥', angle: '∠',
  // 箭头
  rightarrow: '→', to: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔',
  mapsto: '↦', uparrow: '↑', downarrow: '↓',
  // 大型运算符 / 微积分
  sum: '∑', prod: '∏', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  partial: '∂', nabla: '∇', infty: '∞',
  // 其它常用
  degree: '°', circ: '∘', bullet: '•', star: '⋆', dagger: '†',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
  prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  therefore: '∴', because: '∵', qed: '∎',
  vert: '|', Vert: '‖', langle: '⟨', rangle: '⟩',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
};

// 函数名类命令:保留字面(sin/cos/log 等本来就是正文形态)。
const LATEX_FUNCTION_NAMES = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min',
  'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'mod', 'bmod', 'pmod',
]);

// 文本近似不还原字形,但必须按参数读取样式包装,保住命令边界与作用范围。
const LATEX_STYLE_WRAPPERS = new Set([
  'text', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal',
  'mathbb', 'mathfrak', 'boldsymbol', 'bm', 'operatorname', 'textbf', 'textit',
]);

const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽',
  ')': '⁾', n: 'ⁿ', i: 'ⁱ', k: 'ᵏ', m: 'ᵐ', t: 'ᵗ', x: 'ˣ', y: 'ʸ',
};

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍',
  ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', m: 'ₘ', n: 'ₙ',
  h: 'ₕ', l: 'ₗ', o: 'ₒ', p: 'ₚ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/** 仅读取对象自有字符串键值,防止读取 Object.prototype 上的方法(如 toString/constructor)。 */
function getOwnRecordValue(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** 整串字符都能映射时返回映射结果,否则 null(混排会破坏可读性,整体回退)。 */
function mapAllChars(text: string, map: Record<string, string>): string | null {
  let out = '';
  for (const ch of text) {
    const mapped = getOwnRecordValue(map, ch);
    if (mapped == null) return null;
    out += mapped;
  }
  return out;
}

/** 取 `^` / `_` 后面的参数:`{...}`(支持一层嵌套)或单字符/单命令。返回 [参数体, 消费长度]。 */
function readScriptArg(source: string, from: number): [string, number] {
  if (source[from] === '{') {
    let depth = 0;
    for (let i = from; i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return [source.slice(from + 1, i), i - from + 1];
      }
    }
    return [source.slice(from + 1), source.length - from];
  }
  if (source[from] === '\\') {
    const cmd = source.slice(from).match(/^\\[a-zA-Z]+/);
    if (cmd) return [cmd[0], cmd[0].length];
  }
  return [source[from] ?? '', source[from] ? 1 : 0];
}

/**
 * Read structural commands before stripping command names/grouping braces.
 * A flat-brace regexp cannot match e.g. \frac{2\sqrt{3}}{3}. Index balanced
 * groups once, including escaped braces, so malformed streaming input does not
 * repeatedly scan to EOF. Bound recursion for untrusted/deeply nested input.
 */
const LATEX_ACCENTS: Record<string, string> = {
  dot: '\u0307', ddot: '\u0308', hat: '\u0302', widehat: '\u0302',
  bar: '\u0305', overline: '\u0305', vec: '\u20d7', tilde: '\u0303', widetilde: '\u0303',
};

function replaceLatexStructures(source: string, depth: number): string {
  if (depth >= 32) return source;
  const groupEnds = new Map<number, number>();
  const braces: number[] = [];
  const brackets: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === '{') braces.push(i);
    else if (source[i] === '[') brackets.push(i);
    else if (source[i] === '}' || source[i] === ']') {
      const open = (source[i] === '}' ? braces : brackets).pop();
      if (open != null) groupEnds.set(open, i);
    }
  }
  type Argument = { text: string; end: number };
  const commandRanges = new Map<string, Argument>();
  const skipSpace = (from: number) => {
    while (from < source.length && /\s/.test(source[from])) from += 1;
    return from;
  };
  const readArg = (from: number, nesting: number): Argument | null => {
    const start = skipSpace(from);
    if (start === source.length || source[start] === '}') return null;
    if (source[start] === '{') {
      const end = groupEnds.get(start);
      return end == null ? null : {
        text: source.slice(start + 1, end), end: end + 1,
      };
    }
    // A single TeX token can itself take arguments: \frac\sqrt{3}2.
    if (source[start] === '\\') return readCommand(start, nesting + 1, true);
    const token = String.fromCodePoint(source.codePointAt(start)!);
    return { text: token, end: start + token.length };
  };
  // Keep an atomic operand's TeX boundary until flattenLatex has mapped its
  // commands: √{\alpha}x must not become the unknown command \alphax.
  const operand = (text: string) => Array.from(flattenLatex(text)).length === 1 ? `{${text}}` : `(${text})`;
  const readCommand = (start: number, nesting: number, scanOnly = false): Argument => {
    const rangeKey = `${start}:${nesting}`;
    const cached = scanOnly ? commandRanges.get(rangeKey) : undefined;
    if (cached) return cached;
    const remember = (range: Argument) => {
      if (scanOnly) commandRanges.set(rangeKey, range);
      return range;
    };
    let end = start + 1;
    while (end < source.length && /[a-zA-Z]/.test(source[end])) end += 1;
    if (end === start + 1) end = Math.min(source.length, end + 1);
    const raw = { text: source.slice(start, end), end };
    const name = source.slice(start + 1, end);
    const fraction = name === 'frac' || name === 'dfrac' || name === 'tfrac';
    const styleWrapper = LATEX_STYLE_WRAPPERS.has(name);
    const accent = getOwnRecordValue(LATEX_ACCENTS, name);
    if (nesting >= 32 || (!fraction && !styleWrapper && name !== 'sqrt' && accent == null)) return remember(raw);
    let rootIndexSource: string | undefined;
    const indexStart = skipSpace(end);
    if (name === 'sqrt' && source[indexStart] === '[') {
      const indexEnd = groupEnds.get(indexStart);
      if (indexEnd == null) return remember(raw);
      rootIndexSource = source.slice(indexStart + 1, indexEnd);
      end = indexEnd + 1;
    }
    const first = readArg(end, nesting);
    if (!first) return remember(raw);
    const second = fraction ? readArg(first.end, nesting) : null;
    if (fraction && !second) return remember(raw);
    const resultEnd = second?.end ?? first.end;
    // Locate every argument before rendering any of them. A malformed frac
    // otherwise renders its numerator, then returns only the command token,
    // causing the outer scan to render the same subtree again. Cache lexical
    // scans too, so nested unbraced commands cannot multiply this work.
    if (scanOnly) return remember({ text: source.slice(start, resultEnd), end: resultEnd });
    const body = replaceLatexStructures(first.text, nesting + 1);
    let text: string;
    if (styleWrapper) {
      // Retain grouping until command mapping: \in\mathcal{E} must not
      // become \inE, and \mathrm{\alpha}x must not become \alphax.
      // The same argument reader handles \mathcal E and nested wrappers.
      text = `{${body}}`;
    } else if (second) {
      text = `${operand(body)}/${operand(replaceLatexStructures(second.text, nesting + 1))}`;
    } else if (name === 'sqrt') {
      const rootIndex = rootIndexSource === undefined ? undefined
        : flattenLatex(replaceLatexStructures(rootIndexSource, nesting + 1));
      const root = rootIndex === undefined ? '√' : rootIndex === '3' ? '∛' : rootIndex === '4' ? '∜' : `√[${rootIndex}]`;
      text = `${root}${operand(body)}`;
    } else {
      const symbol = flattenLatex(body);
      text = Array.from(symbol).length === 1 ? symbol + accent! : `${name}(${body})`;
    }
    // Preserve postfix scripts and implicit products: (a/b)² and (a/b)c.
    // Without the parentheses both can be misread as part of the denominator.
    const next = source[skipSpace(resultEnd)] ?? '';
    if ((fraction && /[a-zA-Z0-9\\(^_]/.test(next)) || (name === 'sqrt' && /[\^_]/.test(next))) text = `(${text})`;
    return { text, end: resultEnd };
  };
  let out = '';
  for (let i = 0; i < source.length;) {
    if (source[i] !== '\\') { out += source[i]; i += 1; continue; }
    const command = readCommand(i, depth);
    out += command.text;
    i = command.end;
  }
  return out;
}

/**
 * LaTeX 片段 → Unicode 文本近似。转换尽力而为:认识的命令做映射,不认识的
 * 命令保留其字面参数,永不抛错。
 */
export function latexToUnicodeApproximation(latex: string): string {
  return flattenLatex(replaceLatexStructures(latex, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 结构化行内 LaTeX 分词(供移动端原生 Text 流区分正斜体与统一下标渲染)
// ─────────────────────────────────────────────────────────────────────────────

export type InlineMathSegment =
  | { kind: 'var'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'sup'; text: string; italic?: boolean }
  | { kind: 'sub'; text: string; italic?: boolean };

// 在标准 SUPERSCRIPT_MAP 基础上补齐常用小写字母上标,避免 x^z / a^b 等回退成 ^z。
const INLINE_SUPERSCRIPT_MAP: Record<string, string> = {
  ...SUPERSCRIPT_MAP,
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ',
  j: 'ʲ', l: 'ˡ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', u: 'ᵘ', v: 'ᵛ',
  w: 'ʷ', z: 'ᶻ',
};

// 下标小写希腊变量:TeX 排版里小写希腊字母为斜体变量,大写希腊字母(Δ/Σ/Ω)为正体。
const LOWERCASE_GREEK_RE = /^[\u03b1-\u03c9\u03d1\u03d5\u03f1\u03f5]+$/;
const LATEX_IGNORE_MODIFIERS = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr']);
const LATEX_UPRIGHT_WRAPPERS = new Set(['text', 'mathrm', 'mathbf', 'mathsf', 'mathtt', 'operatorname', 'textbf']);
const LATEX_SPACE_COMMANDS = new Set([',', ';', ':', ' ', 'quad', 'qquad']);

function isAlreadyWrappedAtom(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  if (t.startsWith('|') && t.endsWith('|')) {
    return t.indexOf('|', 1) === t.length - 1;
  }
  const open = t[0];
  const close = open === '(' ? ')' : open === '[' ? ']' : null;
  if (!close || t[t.length - 1] !== close) return false;
  const stack: string[] = [];
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '(' || ch === '[') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']') {
      const expected = ch === ')' ? '(' : '[';
      if (stack[stack.length - 1] !== expected) return false;
      stack.pop();
      if (stack.length === 0) return i === t.length - 1;
    }
  }
  return false;
}

function segmentsPlainText(segments: readonly InlineMathSegment[]): string {
  return segments.map((s) => s.text).join('');
}

function formatScriptBoundaryText(segments: readonly InlineMathSegment[]): string {
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'sub') {
      const mapped = mapAllChars(seg.text, SUBSCRIPT_MAP);
      if (mapped != null) out += mapped;
      else out += seg.text.length === 1 ? `_${seg.text}` : `_(${seg.text})`;
    } else if (seg.kind === 'sup') {
      out += seg.text.startsWith('^')
        ? seg.text
        : seg.text.length === 1
          ? `^${seg.text}`
          : `^(${seg.text})`;
    } else {
      out += seg.text;
    }
  }
  return out;
}

function pushCoalesced(out: InlineMathSegment[], seg: InlineMathSegment): void {
  if (!seg.text) return;
  const prev = out[out.length - 1];
  if (prev && prev.kind === seg.kind && (prev.kind !== 'sub' && prev.kind !== 'sup' || prev.italic === (seg as { italic?: boolean }).italic)) {
    prev.text += seg.text;
    return;
  }
  out.push({ ...seg });
}

function tokenizeInlineMathRange(source: string, upright: boolean, depth: number): InlineMathSegment[] {
  if (depth >= 32 || !source) {
    return source ? [{ kind: 'text', text: source }] : [];
  }

  const groupEnds = new Map<number, number>();
  const braces: number[] = [];
  const brackets: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === '{') braces.push(i);
    else if (source[i] === '[') brackets.push(i);
    else if (source[i] === '}' || source[i] === ']') {
      const open = (source[i] === '}' ? braces : brackets).pop();
      if (open != null) groupEnds.set(open, i);
    }
  }

  type ArgSlice = { text: string; end: number };
  const commandRanges = new Map<string, ArgSlice>();
  const skipSpace = (from: number) => {
    while (from < source.length && /\s/.test(source[from])) from += 1;
    return from;
  };

  const scanCommandRange = (start: number, nesting: number): ArgSlice => {
    const key = `${start}:${nesting}`;
    const cached = commandRanges.get(key);
    if (cached) return cached;
    const remember = (range: ArgSlice) => { commandRanges.set(key, range); return range; };
    let end = start + 1;
    while (end < source.length && /[a-zA-Z]/.test(source[end])) end += 1;
    if (end === start + 1) end = Math.min(source.length, end + 1);
    const raw = { text: source.slice(start, end), end };
    const name = source.slice(start + 1, end);
    const fraction = name === 'frac' || name === 'dfrac' || name === 'tfrac';
    const styleWrapper = LATEX_STYLE_WRAPPERS.has(name);
    if (nesting >= 32 || (!fraction && !styleWrapper && name !== 'sqrt' && getOwnRecordValue(LATEX_ACCENTS, name) == null)) {
      return remember(raw);
    }
    const idxStart = skipSpace(end);
    if (name === 'sqrt' && source[idxStart] === '[') {
      const idxEnd = groupEnds.get(idxStart);
      if (idxEnd == null) return remember(raw);
      end = idxEnd + 1;
    }
    const readNext = (from: number): ArgSlice | null => {
      const s = skipSpace(from);
      if (s === source.length || source[s] === '}') return null;
      if (source[s] === '{') {
        const gEnd = groupEnds.get(s);
        return gEnd == null ? null : { text: source.slice(s + 1, gEnd), end: gEnd + 1 };
      }
      if (source[s] === '\\') return scanCommandRange(s, nesting + 1);
      const tok = String.fromCodePoint(source.codePointAt(s)!);
      return { text: tok, end: s + tok.length };
    };
    const first = readNext(end);
    if (!first) return remember(raw);
    const second = fraction ? readNext(first.end) : null;
    if (fraction && !second) return remember(raw);
    return remember({ text: source.slice(start, second?.end ?? first.end), end: second?.end ?? first.end });
  };

  const readArg = (from: number, nesting: number): ArgSlice | null => {
    const start = skipSpace(from);
    if (start === source.length || source[start] === '}') return null;
    if (source[start] === '{') {
      const end = groupEnds.get(start);
      return end == null ? null : { text: source.slice(start + 1, end), end: end + 1 };
    }
    if (source[start] === '\\') return scanCommandRange(start, nesting + 1);
    const tok = String.fromCodePoint(source.codePointAt(start)!);
    return { text: tok, end: start + tok.length };
  };

  const readScriptInlineArg = (from: number): ArgSlice | null => {
    const argStart = skipSpace(from);
    if (argStart >= source.length) return null;
    if (source[argStart] === '{') {
      const end = groupEnds.get(argStart);
      return end == null ? { text: source.slice(argStart + 1), end: source.length } : { text: source.slice(argStart + 1, end), end: end + 1 };
    }
    if (source[argStart] === '\\') {
      return scanCommandRange(argStart, depth + 1);
    }
    const ch = source[argStart] ?? '';
    return ch ? { text: ch, end: argStart + 1 } : null;
  };

  const out: InlineMathSegment[] = [];
  const wrapBody = (segs: InlineMathSegment[], allowDelimitedAtom: boolean): InlineMathSegment[] => {
    const plain = segmentsPlainText(segs);
    if (Array.from(plain).length <= 1) return segs;
    if (allowDelimitedAtom && isAlreadyWrappedAtom(plain)) return segs;
    return [{ kind: 'text', text: '(' }, ...segs, { kind: 'text', text: ')' }];
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    // Escaped literal characters: \{ \} \$ \% \& \# \_ \^
    if (ch === '\\') {
      const nextCh = source[i + 1];
      if (nextCh && /[{}$%&#_^]/.test(nextCh)) {
        pushCoalesced(out, { kind: 'text', text: nextCh });
        i += 2;
        continue;
      }
      if (nextCh === '|') {
        pushCoalesced(out, { kind: 'text', text: '‖' });
        i += 2;
        continue;
      }
      if (nextCh === '!') {
        i += 2;
        continue;
      }
      if (nextCh && LATEX_SPACE_COMMANDS.has(nextCh)) {
        pushCoalesced(out, { kind: 'text', text: ' ' });
        i += 2;
        continue;
      }
      let end = i + 1;
      while (end < source.length && /[a-zA-Z]/.test(source[end])) end += 1;
      if (end === i + 1) {
        i = Math.min(source.length, i + 2);
        continue;
      }
      const name = source.slice(i + 1, end);

      if (LATEX_IGNORE_MODIFIERS.has(name)) {
        i = skipSpace(end);
        continue;
      }
      if (LATEX_SPACE_COMMANDS.has(name)) {
        pushCoalesced(out, { kind: 'text', text: ' ' });
        i = end;
        continue;
      }

      const fraction = name === 'frac' || name === 'dfrac' || name === 'tfrac';
      const styleWrapper = LATEX_STYLE_WRAPPERS.has(name);
      const accent = getOwnRecordValue(LATEX_ACCENTS, name);
      if (fraction || styleWrapper || name === 'sqrt' || accent != null) {
        let cursor = end;
        let rootIndexSource: string | undefined;
        const idxStart = skipSpace(cursor);
        if (name === 'sqrt' && source[idxStart] === '[') {
          const idxEnd = groupEnds.get(idxStart);
          if (idxEnd != null) {
            rootIndexSource = source.slice(idxStart + 1, idxEnd);
            cursor = idxEnd + 1;
          }
        }
        const first = readArg(cursor, depth);
        const second = fraction && first ? readArg(first.end, depth) : null;
        if (first && (!fraction || second)) {
          const resultEnd = second?.end ?? first.end;
          if (styleWrapper) {
            const innerUpright = LATEX_UPRIGHT_WRAPPERS.has(name) ? true : upright;
            for (const seg of tokenizeInlineMathRange(first.text, innerUpright, depth + 1)) {
              pushCoalesced(out, seg);
            }
          } else if (second) {
            const num = wrapBody(tokenizeInlineMathRange(first.text, upright, depth + 1), true);
            const den = wrapBody(tokenizeInlineMathRange(second.text, upright, depth + 1), true);
            const combined: InlineMathSegment[] = [...num, { kind: 'text', text: '/' }, ...den];
            const nextChar = source[skipSpace(resultEnd)] ?? '';
            const wrapped = /[a-zA-Z0-9\\(^_]/.test(nextChar)
              ? [{ kind: 'text' as const, text: '(' }, ...combined, { kind: 'text' as const, text: ')' }]
              : combined;
            for (const seg of wrapped) pushCoalesced(out, seg);
          } else if (name === 'sqrt') {
            const rootIdx = rootIndexSource === undefined
              ? undefined
              : segmentsPlainText(tokenizeInlineMathRange(rootIndexSource, true, depth + 1));
            const root = rootIdx === undefined ? '√' : rootIdx === '3' ? '∛' : rootIdx === '4' ? '∜' : `√[${rootIdx}]`;
            const body = wrapBody(tokenizeInlineMathRange(first.text, upright, depth + 1), true);
            const combined: InlineMathSegment[] = [{ kind: 'text', text: root }, ...body];
            const nextChar = source[skipSpace(resultEnd)] ?? '';
            const wrapped = /[\^_]/.test(nextChar)
              ? [{ kind: 'text' as const, text: '(' }, ...combined, { kind: 'text' as const, text: ')' }]
              : combined;
            for (const seg of wrapped) pushCoalesced(out, seg);
          } else {
            const inner = tokenizeInlineMathRange(first.text, upright, depth + 1);
            const plain = segmentsPlainText(inner);
            if (Array.from(plain).length === 1) {
              const baseKind = inner[0]?.kind === 'var' ? 'var' : 'text';
              pushCoalesced(out, { kind: baseKind, text: plain + accent! });
            } else {
              pushCoalesced(out, { kind: 'text', text: `${name}(` });
              for (const seg of inner) pushCoalesced(out, seg);
              pushCoalesced(out, { kind: 'text', text: ')' });
            }
          }
          i = resultEnd;
          continue;
        }
      }

      if (LATEX_FUNCTION_NAMES.has(name)) {
        pushCoalesced(out, { kind: 'text', text: name });
        // \cos\theta / \sin x: ensure clean separation before an adjacent variable/command
        const after = source[end] ?? '';
        if (after === '\\' || /[a-zA-Z0-9]/.test(after)) {
          pushCoalesced(out, { kind: 'text', text: ' ' });
        }
        i = end;
        continue;
      }

      const symbol = getOwnRecordValue(LATEX_SYMBOL_MAP, name);
      if (symbol != null) {
        const isLowerGreek = LOWERCASE_GREEK_RE.test(symbol);
        pushCoalesced(out, { kind: !upright && isLowerGreek ? 'var' : 'text', text: symbol });
        i = end;
        continue;
      }

      pushCoalesced(out, { kind: 'text', text: name });
      i = end;
      continue;
    }

    // Superscripts and subscripts
    if (ch === '^' || ch === '_') {
      const arg = readScriptInlineArg(i + 1);
      if (arg && arg.end > i + 1) {
        const innerSegs = tokenizeInlineMathRange(arg.text, upright, depth + 1);
        if (ch === '_') {
          for (const seg of innerSegs) {
            pushCoalesced(out, {
              kind: 'sub',
              text: seg.text,
              italic: seg.kind === 'var' || (seg.kind === 'sub' && seg.italic),
            });
          }
        } else {
          const hasNestedScript = innerSegs.some((seg) => seg.kind === 'sub' || seg.kind === 'sup');
          if (hasNestedScript) {
            const nested = formatScriptBoundaryText(innerSegs);
            pushCoalesced(out, {
              kind: 'sup',
              text: Array.from(nested).length === 1 ? `^${nested}` : `^(${nested})`,
              italic: false,
            });
          } else {
            const plain = segmentsPlainText(innerSegs);
            const mapped = plain ? mapAllChars(plain, INLINE_SUPERSCRIPT_MAP) : null;
            if (mapped != null) {
              pushCoalesced(out, { kind: 'sup', text: mapped, italic: false });
            } else {
              pushCoalesced(out, {
                kind: 'sup',
                text: plain.length === 1 ? `^${plain}` : `^(${plain})`,
                italic: false,
              });
            }
          }
        }
        i = arg.end;
        continue;
      }
      pushCoalesced(out, { kind: 'text', text: ch });
      i += 1;
      continue;
    }

    // Grouping braces have no visual output once structured commands/scripts consumed theirs
    if (ch === '{' || ch === '}') {
      i += 1;
      continue;
    }

    // Latin variable runs
    if (/[a-zA-Z]/.test(ch)) {
      let end = i + 1;
      while (end < source.length && /[a-zA-Z]/.test(source[end])) end += 1;
      pushCoalesced(out, { kind: upright ? 'text' : 'var', text: source.slice(i, end) });
      i = end;
      continue;
    }

    // Collapse horizontal whitespace runs into a single space
    if (ch === ' ' || ch === '\t') {
      let end = i + 1;
      while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
      pushCoalesced(out, { kind: 'text', text: ' ' });
      i = end;
      continue;
    }

    // Digits, operators, punctuation, CJK, etc. -> upright text
    pushCoalesced(out, { kind: 'text', text: ch });
    i += 1;
  }

  return out;
}

/**
 * 将 inline LaTeX 拆分为带语义类型的排版片段(变量斜体、符号/数字/函数正体、
 * 统一上标、任意字符下标),供移动端原生 Text 流清晰、无错位地混排。
 */
export function tokenizeInlineMath(latex: string): InlineMathSegment[] {
  const segments = tokenizeInlineMathRange(latex, false, 0);
  // Trim outer whitespace without altering internal tokens
  if (segments.length > 0 && segments[0].kind === 'text') {
    segments[0].text = segments[0].text.replace(/^\s+/, '');
    if (!segments[0].text) segments.shift();
  }
  if (segments.length > 0 && segments[segments.length - 1].kind === 'text') {
    segments[segments.length - 1].text = segments[segments.length - 1].text.replace(/\s+$/, '');
    if (!segments[segments.length - 1].text) segments.pop();
  }
  return segments;
}

function flattenLatex(latex: string): string {
  let s = latex;

  // \left / \right / \big 系列定界符修饰:丢弃修饰保定界符
  s = s.replace(/\\(?:left|right|[bB]igg?[lr]?)\s*/g, '');

  // TeX spacing commands are layout, not literal backslashes or punctuation.
  s = s.replace(/\\!/g, '').replace(/\\(?:[,;: ]|quad\b|qquad\b)/g, ' ');

  // 命令映射:符号表 → Unicode;函数名 → 字面;未知命令 → 去掉反斜杠保留名字
  s = s.replace(/\\([a-zA-Z]+)/g, (_m, name: string) => {
    const symbol = getOwnRecordValue(LATEX_SYMBOL_MAP, name);
    if (symbol != null) return symbol;
    if (LATEX_FUNCTION_NAMES.has(name)) return name;
    return name;
  });

  // 上下标:整参数能映射成 Unicode sup/sub 就映射,否则退化成 ^(...) / _(...)
  const applyScripts = (input: string, marker: '^' | '_', map: Record<string, string>): string => {
    let out = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      // Escaped markers are literal text, not a script opener.
      if (ch === '\\' && /[{}$%&#_^]/.test(input[i + 1] ?? '')) {
        out += input.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch !== marker) {
        out += ch;
        i += 1;
        continue;
      }
      const [arg, consumed] = readScriptArg(input, i + 1);
      if (consumed === 0) {
        out += ch;
        i += 1;
        continue;
      }
      // Style wrappers retain TeX groups through command mapping. Nested
      // groups in x^{\mathrm{12}} must not prevent the superscript mapping.
      const mapped = mapAllChars(stripLatexGrouping(arg), map);
      if (mapped != null) out += mapped;
      else out += arg.length === 1 ? `${marker}${arg}` : `${marker}(${arg})`;
      i += 1 + consumed;
    }
    return out;
  };
  s = applyScripts(s, '^', SUPERSCRIPT_MAP);
  s = applyScripts(s, '_', SUBSCRIPT_MAP);

  // Remove grouping braces while retaining explicitly escaped literal braces
  // and markers. Unescaping earlier would erase \{x\} or reinterpret \_1.
  s = stripLatexGrouping(s);

  // LaTeX 源码里的多空格无语义,折叠成单空格
  return s.replace(/[ \t]+/g, ' ').trim();
}

function stripLatexGrouping(text: string): string {
  return text.replace(/\\([{}$%&#_^])|[{}]/g, (_m, literal: string | undefined) => literal ?? '');
}
