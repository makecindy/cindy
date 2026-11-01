/**
 * mermaidAutofix — 对模型输出的 mermaid 源码做确定性语法修复。
 *
 * 背景:host 系统提示词里原有一节「Rendering Mermaid Diagrams」教模型避开
 * mermaid strict 模式的语法坑,2026-07-16 随 host prompt 清空一并移除。
 * 这里把其中机械可修的规则下沉为代码容错(规则 9:能用代码保证的确定性
 * 不依赖 prompt),渲染端在 mermaid.parse() 对原文失败后调用本函数重试。
 *
 * 调用契约:**只在原文 parse 失败后调用**——合法图表不会被改写;修复版若仍
 * parse 失败,调用方退回原有降级路径(源码展示)。
 *
 * 内容保真:parse 失败是**整文档**粒度的,失败文档里可能混着合法行,所以修复
 * 不能改变任何标签的**渲染文本**。为此所有"加引号"pass(不改渲染文本)先跑,
 * unicode 箭头替换(会改文本)最后跑——标签先被引号包住,箭头替换按引号二分
 * 跳过引号内内容,就摸不到标签内部了;unicode 箭头本身也算入"标签需要加引号"
 * 的危险字符。残余风险:旧式 `A -- text --> B` 的裸边文本没有可靠定界符,
 * 其中的 unicode 箭头仍会被替换——接受(该写法罕见且修复仅在失败后运行);节点标签体
 * (含被跳过加引号的形状变体)整段不参与箭头替换。
 *
 * 修复项:
 *   1. `//` 行注释 → `%%`(所有图类型通用)
 *   2. 仅 flowchart / graph(其它图类型会被下列规则误伤——er 的 `||--o{`
 *      基数、sequence 的 `->>` 箭头等——按首行图类型闸住):
 *      - `subgraph Id[...]` 缺空格 → `subgraph Id [...]`
 *      - 未加引号的边标签 `-->|text|` → `-->|"text"|`(引号混用易翻车,统一补齐)
 *      - 含危险字符的节点标签 `Id[text]` / `Id(text)` / `Id{text}` → 标签加引号
 *      - unicode 箭头(→ ⟶ ➔ ➜ ⇒ ⟹)→ `-->`(仅引号外且不在节点标签内,最后执行)
 *
 * 性能:节点标签正则是 O(行长²) 的回溯形态,病态输入(模型把 base64 / 长日志
 * 误标进 mermaid 围栏)会把渲染线程冻住秒级。合法 mermaid 不存在超长单行,
 * 超过规模闸直接原样返回,整体退化为一次线性扫描。
 */

/** 单行超过此长度即放弃修复(合法 mermaid 不存在这种行,防 O(n²) 回溯冻结)。 */
const MAX_REPAIR_LINE_LENGTH = 2_000;

/** 整体超过此长度即放弃修复(同上,规模闸)。 */
const MAX_REPAIR_SOURCE_LENGTH = 100_000;

/** Characters that can form an edge tip or an id suffix. */
const PUNCTUATION_RUN_RE = /[-.=<>|]/;

/** Punctuation run that ends at an edge tip rather than at a node id. */
const EDGE_TIP_RE = /^(?:<?(?:-{2,}|={2,}|-\.+-|-\.+))$/;

/**
 * What may stand in front of a token that starts with an edge head (`o`, `x`, `<`):
 * whitespace, a pipe, or the closer of the node the edge leaves. `A[x]o.->B` is legal
 * in Mermaid, so the `]` has to count as a boundary just like a space does.
 */
const HEAD_BOUNDARY_BEFORE_RE = /[\s|)\]}]/;

/**
 * Prefix counts of the characters an edge tip is built from. The scan asks whether
 * the run ending at the current character is an edge tip, once per character, so
 * slicing the run and matching a regex there made a long run of `>` quadratic
 * (2 000 characters of `>` cost about 40 ms; a 90 KB source crossed the render
 * budget). Counting lets each answer be a constant-time lookup.
 */
function punctuationPrefixes(text: string): { dash: Int32Array; dot: Int32Array; eq: Int32Array } {
  const size = text.length + 1;
  const dash = new Int32Array(size);
  const dot = new Int32Array(size);
  const eq = new Int32Array(size);
  for (let i = 0; i < text.length; i += 1) {
    dash[i + 1] = dash[i] + (text[i] === '-' ? 1 : 0);
    dot[i + 1] = dot[i] + (text[i] === '.' ? 1 : 0);
    eq[i + 1] = eq[i] + (text[i] === '=' ? 1 : 0);
  }
  return { dash, dot, eq };
}

/**
 * Whether `text.slice(start, end)` is an edge tip: `-->`, `==>`, `-.->`, the
 * stretched dotted forms `-..->`/`-...->`, or their bidirectional `<-->`/`<==>`
 * variants. Same shape as `EDGE_TIP_RE`, evaluated without building the slice.
 */
function isEdgeTipRun(
  text: string,
  start: number,
  end: number,
  prefixes: { dash: Int32Array; dot: Int32Array; eq: Int32Array },
): boolean {
  let first = start;
  if (text[first] === '<') first += 1;
  const rest = end - first;
  if (rest < 2) return false;
  const { dash, dot, eq } = prefixes;
  if (dash[end] - dash[first] === rest) return true;
  if (eq[end] - eq[first] === rest) return true;
  if (text[first] !== '-') return false;
  const dots = dot[end] - dot[first];
  if (dots === rest - 1) return true;
  return text[end - 1] === '-' && dots === rest - 2;
}

/** LLM 常写的 unicode 右箭头(左箭头无法机械翻译成合法边,留给降级路径)。 */
const UNICODE_ARROW_RE = /[→⟶➔➜⇒⟹]/g; // → ⟶ ➔ ➜ ⇒ ⟹

/**
 * 节点标签含这些字符时补引号。前段是 strict 模式下易炸的结构字符;unicode
 * 箭头也在列——不是因为它炸 parse,而是让含箭头的标签先被引号保护起来,
 * 免遭最后一步箭头替换改写渲染文本(见文件头「内容保真」)。
 */
const NODE_LABEL_DANGER_RE = /[:;=&#<>(){}[\]\\/→⟶➔➜⇒⟹]/;

/** 形状变体开头字符:`[(db)]` `[[x]]` `[/p/]` `{{hex}}` 等,加引号会改变形状语义。 */
const SHAPE_MODIFIER_HEAD = new Set(['(', '{', '[', '/', '\\']);

/** 把行按 `"` 二分,只对引号外片段应用 fn(偶数段在引号外)。 */
function mapOutsideQuotes(line: string, fn: (segment: string) => string): string {
  const parts = line.split('"');
  return parts.map((p, i) => (i % 2 === 0 ? fn(p) : p)).join('"');
}

/**
 * 在引号外、且节点标签体之外应用 fn。
 *
 * 形状变体（`A([x])`、`A[[x]]`、`A{{x}}`…）的标签在加引号那一步被有意跳过——
 * 加引号会改变形状语义——于是它们的标签体此前直接暴露在箭头替换之下:标签里的
 * unicode 箭头被改写成 `-->`,既改掉了渲染文本,又仍然 parse 失败。这里把标签体
 * 整段原样保留,箭头替换只作用于标签之外的文本。
 */
const LABEL_OPENERS: ReadonlyArray<readonly [string, string]> = [
  ['[[', ']]'],
  ['[(', ')]'],
  ['{{', '}}'],
  ['([', '])'],
  // A circle or double circle closes with `))` / `)))`, so its pair is one opener:
  // a `(` inside the body must not push a second stack frame.
  ['(((', ')))'],
  ['((', '))'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
];

/**
 * 非对称形状 `A>label]` 的起点判定。
 *
 * `>` 只有在紧跟节点 id 时才是标签起点：`-->`、`==>`、`-.->` 的尖端属于边，
 * 而 id 允许以 `.` 或 `-` 结尾（`foo.>`、`foo->`），所以要再看一位。
 */
/**
 * A quote opens the wrapping quoted text of a label only when it delimits the label
 * value: right after the body starts, right after a shape modifier (`A[/"text"/]`),
 * or right after an object-metadata key (`A@{ shape: rect, label: "text" }`). Any
 * other quote in the body is a stray character and must not swallow the document.
 */
/**
 * Whether the label body that starts at `bodyStart` belongs to object metadata
 * (`A@{ ... }`), at any nesting depth. The scan saves one body start per open label,
 * so the outer `@{` is still reachable when an array or a nested shape opened first.
 */
function opensObjectMetadata(text: string, bodyStart: number): boolean {
  let at = bodyStart;
  while (at >= 2) {
    // Whitespace between an opener and the value it wraps is part of the body.
    while (at > 0 && /\s/.test(text[at - 1])) at -= 1;
    if (at >= 2 && text[at - 1] === '{' && text[at - 2] === '@') return true;
    const opener = LABEL_OPENERS.find(([open]) => text.startsWith(open, at - open.length));
    if (!opener) return false;
    at -= opener[0].length;
  }
  return false;
}

/**
 * Whether the character before `lastNonSpace` introduces a value inside object
 * metadata: a `:` key separator, a `,` between entries, an enclosing bracket, or
 * the start of the body itself.
 */
function opensMetadataValue(text: string, bodyStart: number, lastNonSpace: number): boolean {
  if (lastNonSpace < bodyStart) return true;
  return [':', ',', '[', '(', '{'].includes(text[lastNonSpace]);
}

function opensQuotedLabel(
  text: string,
  bodyStart: number,
  lastNonSpace: number,
  prevNonSpace: number,
): boolean {
  // Object metadata (`A@{ img: "https://x/a}.png", label: "go -> stop" }`) holds
  // several quoted values in one body, so every quote inside it delimits a string.
  // The opener there is the `{` of `@{`, so the body starts two characters later.
  // Object metadata keeps quoted values on every nesting level, so the `@{` check
  // walks the enclosing openers rather than only looking at the innermost body.
  if (opensObjectMetadata(text, bodyStart)) return true;
  // A nested body inside metadata still owns its quoted value, so the string
  // state is restored with the outer body when the nested shape closes.
  // The scan hands over the last two non-space characters of the body, so a body
  // that holds hundreds of quotes is not walked again for every one of them.
  if (lastNonSpace < bodyStart) return true;
  if (lastNonSpace === bodyStart && /[\\/]/.test(text[lastNonSpace])) return true;
  // `label\s*:\s*` ends right before the quote: the colon is the last non-space
  // character and the keyword ends at the one before it.
  if (text[lastNonSpace] !== ':') return false;
  const keywordEnd = prevNonSpace;
  const keywordStart = keywordEnd - 'label'.length + 1;
  if (keywordStart < bodyStart) return false;
  if (text.slice(keywordStart, keywordEnd + 1) !== 'label') return false;
  return !/[A-Za-z0-9_]/.test(text[keywordStart - 1]);
}

function isAsymmetricOpener(
  text: string,
  i: number,
  runStart: number,
  tokenStart: number,
  prefixes: { dash: Int32Array; dot: Int32Array; eq: Int32Array },
): boolean {
  if (text[i] !== '>') return false;
  if (i === 0) return false;
  // The punctuation run before `>` is maintained by the forward scan: `-->`, `==>`
  // and `-.->` are edge tokens, while an id may end with any run of dots and
  // hyphens (`foo..>`, `foo.->`). Recomputing the run here for every character
  // turned a long run of `>` into a quadratic scan.
  const start = runStart;
  // An id may end in punctuation that glues the tip to it: `A.-->B` is parsed with
  // `A.` as the source id, so the punctuation run starts inside the id and the tip
  // is only the dash run that ends at `>`. Without this reset the whole `.-->` reads
  // as an asymmetric opener, and the rest of the graph stays inside a label that is
  // never rewritten.
  if (start < i) {
    let tipStart = i;
    while (tipStart > start && (text[tipStart - 1] === '-' || text[tipStart - 1] === '=')) tipStart -= 1;
    if (tipStart > start && tipStart < i && isEdgeTipRun(text, tipStart, i, prefixes)) return false;
  }
  if (start === i) return !/[\s=<>|]/.test(text[i - 1]);
  // Every edge tip is excluded, not just the plain ones: `-->`, `==>`, `-.->`, the
  // stretched dotted forms `-..->`/`-...->`, and the bidirectional `<-->` / `<==>`
  // which leave a `<` at the start of the run.
  if (isEdgeTipRun(text, start, i, prefixes)) return false;
  // A compact dotted edge (`A -.label.-> B`) glues its label to the token start, so
  // the whole token begins with `-.` while a real id never does. The token start is
  // maintained by the forward scan for the same reason as the run start: walking
  // back per character made a long run of `>` quadratic.
  if (text[tokenStart] === '-' && text[tokenStart + 1] === '.') return false;
  // A dotted edge may also end in `.-` (`-. label .->`), which is indistinguishable
  // from an id ending in `.` plus `-` unless the run starts a token.
  if (start === 0 || /\s/.test(text[start - 1])) return false;
  return true;
}

/**
 * 在引号外、且节点标签体之外应用 fn。
 *
 * 形状变体（`A([x])`、`A[[x]]`、`A{{x}}`…）的标签在加引号那一步被有意跳过——
 * 加引号会改变形状语义——于是它们的标签体此前直接暴露在箭头替换之下:标签里的
 * unicode 箭头被改写成 `-->`,既改掉了渲染文本,又仍然 parse 失败。这里把标签体
 * 整段原样保留,箭头替换只作用于标签之外的文本。
 *
 * 标签用一个跨行的栈在单次遍历里配对:一次遍历只推进一次,未闭合的 opener 不会
 * 让后续 opener 重扫整篇文档。
 */
/**
 * A bare edge text may follow the edge opener after a space (`A -- foo --> B`) or be
 * glued to it (`A--foo-->B`, `A-.label.->B`). A character that can continue the edge
 * token (`>`, `-`, `.`, `=`, `|`, `<`) means the opener is a plain tip with no text.
 */
/**
 * Only the first character of an opener can start one, so the per-character scan
 * checks that character before walking the opener list. Without the guard every
 * character of a long label body paid for a dozen `startsWith` calls.
 */
const OPENER_HEADS = new Set(LABEL_OPENERS.map(([open]) => open[0]));

const BARE_EDGE_TEXT_GLUED_RE = /^(?:-{2}|={2}|-\.+)(?=[^\s\-=.<>|])/;

/**
 * A complete edge token carries no text: `---` and `===` already end the link,
 * `--o` / `--x` end it with a circle or a cross head, and a dotted edge closes
 * with `.-`, `.->`, `.-o` or `.-x`. A line such as
 * `A --o B; C[/go -> stop/] --> D` would otherwise hand `B; C[/go -> stop/]` to
 * the bare edge skipper, leaving the label on `C` exposed to the arrow rewrite.
 * The same happens to `A -. foo .-> B` when the closing `.-` is not consumed, so
 * the dotted terminators are part of the token set as well.
 */
const COMPLETE_EDGE_TOKEN_RE = /(?:)/;

/**
 * End of the complete edge token that starts at `i`, or `-1` when this character
 * does not start one. Such a token carries no text, so the scan consumes it as a
 * unit: leaving the tail behind (`A---B`) hands `--B` to the glued-text skipper,
 * which then runs over the label of the next node on the line.
 */
interface EdgeTokenMemo {
  dotEnd: number;
  dashEnd: number;
}

function completeEdgeTokenEnd(
  text: string,
  i: number,
  insideBareText = false,
  memo?: EdgeTokenMemo,
): number {
  // Hand-written instead of a regular expression: a greedy `[-=]{2,}` backtracks
  // over the whole tail at every character of a long alternating run, which made
  // the scan quadratic again. Here each character is looked at a constant number
  // of times.
  const ch = text[i];
  if (ch === '-' || ch === '=') {
    // A source-side head closes the edge on the left (`A o-- B`, `A x-- B`, `A <-- B`).
    // The head itself starts a token, so the `--` that follows it carries no text and
    // must be consumed here; otherwise the bare-edge skipper runs over the label of the
    // next node on the line.
    const leftHead = text[i - 1];
    const headAfterBoundary = i === 1 || HEAD_BOUNDARY_BEFORE_RE.test(text[i - 2]);
    if ((leftHead === 'o' || leftHead === 'x' || leftHead === '<') && headAfterBoundary) {
      let end = i;
      while (text[end] === ch) end += 1;
      return text[end] === '>' ? end + 1 : end;
    }
    let same = i;
    while (text[same] === ch) same += 1;
    const run = same - i;
    // `A--foo--->B` ends the text with a stretched tip, so the head belongs to the
    // token; leaving it behind hands it to the asymmetric opener check.
    if (run >= 3) return text[same] === '>' ? same + 1 : same;
    if (run !== 2) return -1;
    const head = text[same];
    if (head !== 'o' && head !== 'x') return -1;
    // `A--oB` ends the edge with a circle head. A target id may start with `-` or
    // `.` (`A--o-B`), but a following tip (`--o-->B`) is not an id.
    const after = text[same + 1];
    if (after === undefined) return same + 1;
    // `A --o|edge| B` puts an edge label right behind the head, so the pipe ends
    // the head just like the end of the id does.
    if (after === '|') return same + 1;
    if ('=<>'.includes(after)) return -1;
    // A target id may start with a run of dots and dashes (`A--o..B`), so only a
    // run that ends in an arrow head is the edge itself (`A--o-->B`).
    if (after === '.' || after === '-') {
      let run = same + 1;
      while (text[run] === '.' || text[run] === '-') run += 1;
      // Only a dash run that ends in a tip continues the edge (`A--o-->B`). A dot
      // run before a tip is a target id: `A--o.>go → stop]` points at the id `.`
      // and opens an asymmetric label, so the head ends before the dots.
      return text[run] === '>' && after === '-' ? -1 : same + 1;
    }
    return same + 1;
  }
  if (ch !== '.') return -1;
  // A long run of dots is walked once: the end of the run is remembered, so the
  // next character of the same run does not scan the rest of it again.
  let dots = i;
  if (memo && memo.dotEnd > i) {
    dots = memo.dotEnd;
  } else {
    while (text[dots] === '.') dots += 1;
    if (memo) memo.dotEnd = dots;
  }
  // The dash run that follows the dots is walked once as well: a long run of dots
  // followed by a long run of dashes would otherwise repeat that walk at every dot.
  let dashes = dots;
  if (memo && memo.dashEnd > dashes) {
    dashes = memo.dashEnd;
  } else {
    while (text[dashes] === '-') dashes += 1;
    if (memo) memo.dashEnd = dashes;
  }
  if (dashes === dots) return -1;
  const after = text[dashes];
  // A dotted terminator only closes an edge when it starts a token: in `foo.->x`
  // the `.` belongs to the id and the `->` is an asymmetric label opener, while in
  // `A -. foo .-> B` the `.-` follows a space and really is the edge terminator.
  // Inside a bare edge text (`A -.foo.-> B`) the terminator is glued to the label,
  // so there the position no longer decides.
  // `A o.-> B` / `A x.-> B` / `A<.->B` close the edge with a dotted tip on the left
  // side, so a source head in front of the dots is part of the token as well.
  const leftHead = text[i - 1];
  const afterHead = i === 1 || HEAD_BOUNDARY_BEFORE_RE.test(text[i - 2]);
  if (
    !insideBareText &&
    i > 0 &&
    !(afterHead && (leftHead === 'o' || leftHead === 'x' || leftHead === '<')) &&
    !HEAD_BOUNDARY_BEFORE_RE.test(leftHead)
  ) {
    return -1;
  }
  if (after === '>') return dashes + 1;
  if (after !== undefined && (after === 'o' || after === 'x') && !'.-=<>|'.includes(text[dashes + 1] ?? '')) {
    return dashes + 1;
  }
  if (after !== undefined && '.-=<>|'.includes(after)) return -1;
  return dashes;
}

function opensBareEdgeText(text: string, i: number): boolean {
  const head = text.slice(i, i + 8);
  if (completeEdgeTokenEnd(text, i, true) > i) return false;
  if (/^(?:-{2,}|={2,}|-\.+)\s/.test(head)) return true;
  return BARE_EDGE_TEXT_GLUED_RE.test(head);
}

/**
 * A legacy bare edge text (`A -- foo --> B`) has no delimiter, so an opener-looking
 * `[` inside it (`A -- foo[bar --> B`, `A--foo[bar-->B`) is text rather than a node
 * label. Return the index just past the edge tip that ends it, or the line end when
 * the tip is missing.
 */
function skipBareEdgeText(
  text: string,
  from: number,
  prefixes: { dash: Int32Array; dot: Int32Array; eq: Int32Array },
  memo?: EdgeTokenMemo,
): number {
  const lineEnd = text.indexOf('\n', from) === -1 ? text.length : text.indexOf('\n', from);
  let start = from;
  // A quoted bare edge text (`A -- "go --> stop" --> B`) is visible text: the first
  // tip inside the quotes does not end the segment, so the quotes keep their
  // pairing and the label reaches the plain buffer as one piece.
  let quoted = false;
  for (let at = from; at < lineEnd; at += 1) {
    if (text[at] === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (at === from || !PUNCTUATION_RUN_RE.test(text[at - 1])) {
      start = at;
      // `A -- foo --- B` ends the text with a plain tip that has no arrow head, and
      // `--o` / `--x` end it with a circle or a cross. Scanning past those would
      // carry the next node's label into the rewritten segment.
      if (at > from) {
        const tokenEnd = completeEdgeTokenEnd(text, at, true, memo);
        if (tokenEnd > at) return tokenEnd;
      }
    }
    if (text[at] === '>' && at > start && isEdgeTipRun(text, start, at, prefixes)) return at + 1;
  }
  return lineEnd;
}

/**
 * The characters a quote may follow when it *opens* a string: whitespace, a bracket,
 * an edge label pipe, a statement separator, a key colon or an edge tip. Any other
 * character in front of the quote is part of an id token, including non-ASCII ones
 * (`屏幕" --> B`), so that quote stays inside the token.
 */
const STRING_OPENING_BEFORE_RE = /[\s[({|,;:=<>]/;

/**
 * Mermaid statements are separated by newlines *or* by a `;`, so an accessibility
 * declaration may follow a graph statement on the same physical line
 * (`A-->B; accTitle: Draft "v1`). Its quotes are text, not delimiters.
 */
const ACCESSIBILITY_STATEMENT_RE = /^acc(?:Title|Descr)\s*:/;

const ACCESSIBILITY_BLOCK_RE = /^accDescr\s*\{/;

/**
 * End of the accessibility declaration that starts at `at`: the line end for a
 * one-line declaration, or the line that closes an `accDescr { ... }` block.
 */
function accessibilityStatementEnd(text: string, at: number): number {
  const lineEnd = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
  const head = text.slice(at, lineEnd).trimStart();
  if (!ACCESSIBILITY_BLOCK_RE.test(head)) return lineEnd;
  const braceAt = text.indexOf('{', at);
  const closeAt = text.indexOf('}', braceAt + 1);
  // `accDescr { foo }; A --> B` closes on the line that opens it, and the graph
  // statement after the brace is real syntax, so the declaration ends there.
  if (closeAt !== -1 && closeAt < lineEnd) {
    let end = closeAt + 1;
    while (end < lineEnd && /[ \t]/.test(text[end])) end += 1;
    // A declaration may follow the separator on the same line
    // (`accDescr { foo }; accTitle: Draft "v1`), so the `;` stays with the scan, which
    // recognises the next declaration instead of letting its quotes leak.
    if (text[end] === ';') return end;
    return end;
  }
  let end = lineEnd;
  while (end < text.length) {
    const nextBreak = text.indexOf('\n', end + 1);
    const stop = nextBreak === -1 ? text.length : nextBreak;
    const lineStart = end + 1;
    const nextLine = text.slice(lineStart, stop);
    end = stop;
    // Mermaid accepts a space between the closing brace and the optional
    // semicolon (`} ;`), and the rest of that line is graph syntax again
    // (`}; A --> B`), so the declaration ends at the brace.
    const brace = nextLine.indexOf('}');
    // The closing line may carry description text before the brace (`foo }; A --> B`),
    // so the block ends at the brace whenever only a separator follows it.
    const rest = brace === -1 ? '' : nextLine.slice(brace + 1).trimStart();
    if (brace !== -1 && (rest === '' || rest.startsWith(';'))) {
      let after = lineStart + brace + 1;
      while (after < stop && /[ \t]/.test(text[after])) after += 1;
      // The separator is handed back for the same reason as on the opening line.
      if (text[after] === ';') return after;
      return after;
    }
  }
  return end;
}


function mapOutsideQuotesAndLabels(text: string, fn: (segment: string) => string): string {
  let result = '';
  let cursor = 0;
  const prefixes = punctuationPrefixes(text);
  // YAML frontmatter is metadata, not graph syntax: skip it before the scan starts.
  // A leading BOM is kept out of the match but preserved in the output. The
  // delimiters may carry leading spaces, which `isFlowchartSource()` also accepts
  // through its `trim()`, so both sides agree on what counts as frontmatter.
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const front = /^[ \t]*---[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/.exec(text.slice(bom.length));
  if (front) {
    result = bom + front[0];
    cursor = bom.length + front[0].length;
  }
  // Comment lines keep their text: a `%%` line is not Mermaid syntax for the graph.
  const rewritePlain = (segment: string) =>
    segment
      .split('\n')
      .map((part) => (part.trimStart().startsWith('%%') ? part : fn(part)))
      .join('\n');
  let plain = '';
  let quoted = false;
  const flush = () => {
    result += rewritePlain(plain);
    plain = '';
  };
  // Index every closer once: a label is only a label when its closer exists later, and
  // this keeps the check O(log n) instead of rescanning the document per opener.
  const closerPositions = new Map<string, number[]>();
  for (const closer of [...new Set(LABEL_OPENERS.map(([, close]) => close)), ']']) {
    const positions: number[] = [];
    let at = text.indexOf(closer);
    while (at !== -1) {
      positions.push(at);
      at = text.indexOf(closer, at + 1);
    }
    closerPositions.set(closer, positions);
  }
  const hasCloserAfter = (closer: string, from: number): boolean => {
    const positions = closerPositions.get(closer) ?? [];
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (positions[mid] <= from) low = mid + 1;
      else high = mid;
    }
    return low < positions.length;
  };
  const labelStack: string[] = [];
  let runStart = 0;
  // Start of the token that contains the current character: a token begins at the
  // line start or right after a space or a pipe.
  let tokenStart = 0;
  let labelStart = 0;
  // Index of the first character of the innermost label body. A compound opener
  // (`([`, `[[`, `[(`) advances past two characters, so the body does not always
  // start at `labelStart + 1`.
  let labelBodyStart = 0;
  // Nested labels (`A@{ shape: rect, constraint: [on], label: "x" }`) each have
  // their own body, so the outer one is saved on push and restored on pop.
  const outerBodyStarts: number[] = [];
  // A label body that lives inside object metadata (`A@{ constraint: ["off]"] }`)
  // keeps the string semantics of its parent, at any nesting depth, so the flag
  // travels with the stack instead of being re-derived from the innermost opener.
  const outerMetadataFlags: number[] = [];
  let labelInMetadata = false;
  // A label whose body *starts* with a quote wraps its text (`A["use ] → later"]`), so
  // the closers inside those quotes are text. A quote anywhere else in the body is a
  // stray character and must not swallow the rest of the document.
  let labelQuoted = false;
  // The last two non-space characters of the innermost label body: a metadata
  // `label: "x"` value is recognised from those two indexes alone.
  let lastNonSpace = 0;
  let prevNonSpace = -1;
  let subgraphTitlePending = false;
  const edgeMemo: EdgeTokenMemo = { dotEnd: 0, dashEnd: 0 };
  for (let i = cursor; i < text.length; ) {
    // A quoted edge label may span lines (`A -->|"foo\naccTitle: Draft"| B`), so the
    // line-start handling must not run inside those quotes.
    if (labelStack.length === 0 && !quoted && (i === 0 || text[i - 1] === '\n')) {
      const lineEnd = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
      const line = text.slice(i, lineEnd);
      const head = line.trimStart();
      // A subgraph header writes its title after a space, so the next `[` on the
      // line opens user-visible text rather than an edge label.
      subgraphTitlePending = /^subgraph\s/.test(head);
      if (head.startsWith('%%')) {
        // A comment is not graph syntax: its quotes must not leak into the scanner.
        flush();
        result += line;
        i = lineEnd;
        continue;
      }
      if (ACCESSIBILITY_STATEMENT_RE.test(head) || ACCESSIBILITY_BLOCK_RE.test(head)) {
        // An accessibility declaration is free-form text, so its quotes are text
        // rather than delimiters. `accDescr { ... }` may also close on the line
        // that opens it, and then the whole declaration is one line.
        flush();
        const end = accessibilityStatementEnd(text, i);
        result += text.slice(i, end);
        i = end;
        continue;
      }
    }
    const ch = text[i];
    // Track where the punctuation run that ends just before this character starts,
    // so the edge-tip check below reads it instead of walking back over the run.
    if (i === 0 || !PUNCTUATION_RUN_RE.test(text[i - 1])) runStart = i;
    if (i === 0 || text[i - 1] === '\n' || /[\s|]/.test(text[i - 1])) tokenStart = i;
    if (labelStack.length > 0) {
      const top = labelStack[labelStack.length - 1];
      if (ch === '"' && labelQuoted) {
        labelQuoted = !labelQuoted;
        i += 1;
        continue;
      }
      if (!labelQuoted && text.startsWith(top, i)) {
        labelStack.pop();
        i += top.length;
        if (labelStack.length === 0) {
          labelQuoted = false;
          result += text.slice(labelStart, i);
        } else {
          // The outer body continues after the nested label, so its context comes
          // back with it; otherwise the `@{` metadata string state is lost.
          labelBodyStart = outerBodyStarts.pop() ?? labelBodyStart;
          labelInMetadata = outerMetadataFlags.pop() === 1;
          lastNonSpace = i - 1;
          prevNonSpace = lastNonSpace - 1;
        }
        continue;
      }
      // A bare scalar in object metadata keeps its punctuation as text
      // (`A@{ shape: rect, label: foo( }`), so an opener there only starts a nested
      // value when a key, a comma or an enclosing bracket stands in front of it;
      // otherwise the `}` of the metadata could never close it and the rest of the
      // document would stay inside the body.
      const metadataScalar = labelInMetadata && !opensMetadataValue(text, labelBodyStart, lastNonSpace);
      const candidate =
        labelQuoted || metadataScalar || !OPENER_HEADS.has(ch)
          ? undefined
          : LABEL_OPENERS.find(([open]) => text.startsWith(open, i));
      // A metadata value is YAML, so only a flow sequence or a flow mapping opens a
      // nested body there. A leading `(` is a bare scalar (`label: (foo }`), and
      // treating it as a shape would keep the metadata open behind its own `}`.
      const scalarParen = labelInMetadata && candidate !== undefined && candidate[0][0] === '(';
      const nested = candidate === undefined || scalarParen ? undefined : candidate;
      if (nested) {
        outerBodyStarts.push(labelBodyStart);
        outerMetadataFlags.push(labelInMetadata ? 1 : 0);
        // The flag is inherited from the enclosing body, and only a body that
        // itself opens object metadata can turn it on, so the openers are never
        // walked again here.
        if (!labelInMetadata && labelBodyStart >= 2 && text[labelBodyStart - 2] === '@' && text[labelBodyStart - 1] === '{') {
          labelInMetadata = true;
        }
        labelStack.push(nested[1]);
        labelBodyStart = i + nested[0].length;
        lastNonSpace = labelBodyStart - 1;
        prevNonSpace = lastNonSpace - 1;
        i += nested[0].length;
        continue;
      }
      // A body inside object metadata holds quoted values at every nesting level and
      // in every array position, so the recorded context decides on its own. The
      // top-level body still needs the `label:` / first-character check, which reads
      // two recorded indexes and never walks the openers again.
      if (
        ch === '"' &&
        (labelInMetadata || (labelStack.length === 1 && opensQuotedLabel(text, labelBodyStart, lastNonSpace, prevNonSpace)))
      ) {
        labelQuoted = true;
        i += 1;
        continue;
      }
      if (!/\s/.test(ch)) {
        prevNonSpace = lastNonSpace;
        lastNonSpace = i;
      }
      i += 1;
      continue;
    }
    if (ch === ';' && !quoted) {
      const lineEnd = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
      const after = text.slice(i + 1, lineEnd);
      const statementStart = i + 1 + (after.length - after.trimStart().length);
      const statementHead = after.trimStart();
      if (ACCESSIBILITY_STATEMENT_RE.test(statementHead) || ACCESSIBILITY_BLOCK_RE.test(statementHead)) {
        flush();
        const end = accessibilityStatementEnd(text, statementStart);
        result += text.slice(i, end);
        i = end;
        continue;
      }
      // A `;` separates Mermaid statements as well, so a subgraph header may start
      // after it (`A --> B; subgraph id [go -> stop]`) and its title is text as well.
      subgraphTitlePending = /^subgraph\s/.test(statementHead);
    }
    if (ch === '"') {
      // A quote glued to an id belongs to that token (`screen5" --> B`, `屏幕" --> B`),
      // so it is not a delimiter and must not swallow the rest of the document. The
      // decision reads the delimiter set instead of an id character class, because a
      // node id may hold any non-ASCII character as well.
      if (!quoted && i > 0 && !STRING_OPENING_BEFORE_RE.test(text[i - 1])) {
        plain += ch;
        i += 1;
        continue;
      }
      if (!quoted) flush();
      result += ch;
      quoted = !quoted;
      i += 1;
      continue;
    }
    if (quoted) {
      result += ch;
      i += 1;
      continue;
    }
    // A legacy bare edge text has no delimiter: everything up to the edge tip is text.
    // The text may be glued to the opener (`A--foo-->B`), which Mermaid also accepts.
    // A dotted edge closes with `.-`, so the terminator can start on a `.`.
    if (ch === '-' || ch === '=' || ch === '.') {
      const tokenEnd = completeEdgeTokenEnd(text, i, false, edgeMemo);
      if (tokenEnd > i) {
        plain += text.slice(i, tokenEnd);
        i = tokenEnd;
        continue;
      }
    }
    if (i > 0 && (ch === '-' || ch === '=') && opensBareEdgeText(text, i)) {
      const end = skipBareEdgeText(text, i, prefixes, edgeMemo);
      // A quoted bare edge label (`A -- "go -> stop" --> B`) is visible text, so
      // its arrows must not be rewritten when the segment is handed to the plain
      // buffer.
      const segment = text.slice(i, end);
      flush();
      if (!segment.includes('"')) {
        result += rewritePlain(segment);
      } else {
        const pieces = segment.split('"');
        let kept = '';
        for (let k = 0; k < pieces.length; k += 1) {
          kept += k % 2 === 1 ? `"${pieces[k]}"` : rewritePlain(pieces[k]);
        }
        result += kept;
      }
      i = end;
      continue;
    }
    // A label attaches to a node id, so an opener right after a space or a pipe is
    // edge-label text (`A -- foo [bar`), not a node label.
    const subgraphTitle = subgraphTitlePending && text[i] === '[';
    const attached = subgraphTitle || (i > 0 && !/[\s|]/.test(text[i - 1]));
    const opener =
      attached && OPENER_HEADS.has(ch) ? LABEL_OPENERS.find(([open]) => text.startsWith(open, i)) : undefined;
    const asymmetric = attached && !opener && isAsymmetricOpener(text, i, runStart, tokenStart, prefixes);
    const closer = opener ? opener[1] : asymmetric ? ']' : undefined;
    if (closer && hasCloserAfter(closer, i)) {
      flush();
      labelStack.push(closer);
      labelStart = i;
      labelBodyStart = i + (opener ? opener[0].length : 1);
      lastNonSpace = labelBodyStart - 1;
      prevNonSpace = lastNonSpace - 1;
      labelInMetadata =
        labelBodyStart >= 2 && text[labelBodyStart - 2] === '@' && text[labelBodyStart - 1] === '{';
      if (subgraphTitle) subgraphTitlePending = false;
      i += opener ? opener[0].length : 1;
      continue;
    }
    plain += ch;
    i += 1;
  }
  // An unterminated label keeps its text as-is instead of being rewritten.
  if (labelStack.length > 0) result += text.slice(labelStart);
  return result + rewritePlain(plain);
}

/** 图类型判定:跳过 YAML frontmatter 与 `%%` 注释后,看首个有效行。 */
function isFlowchartSource(lines: string[]): boolean {
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) start = close + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('%%')) continue;
    return /^(flowchart|graph)\b/.test(t);
  }
  return false;
}

/** 未引号边标签 `|text|` → `|"text"|`(仅在引号外片段内成对出现时)。 */
function quoteEdgeLabels(segment: string): string {
  return segment.replace(/\|([^|"]+)\|/g, (full, label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return full;
    return `|"${trimmed}"|`;
  });
}

/**
 * 生成"节点标签加引号"的单形状 pass:`Id<open>label<close>` 且 label 含危险
 * 字符时 → `Id<open>"label"<close>`。三种形状各自独立成 pass,因为每个 pass
 * 都可能插入引号,必须让下一个 pass 重新做引号二分。
 */
function makeNodeLabelQuoter(re: RegExp, open: string, close: string) {
  return (segment: string): string =>
    segment.replace(re, (full, id: string, label: string) => {
      if (SHAPE_MODIFIER_HEAD.has(label[0])) return full;
      if (!NODE_LABEL_DANGER_RE.test(label)) return full;
      return `${id}${open}"${label}"${close}`;
    });
}

const quoteSquareLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\[([^[\]"|]+)\]/g, '[', ']');
const quoteRoundLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\(([^()"|]+)\)/g, '(', ')');
const quoteCurlyLabels = makeNodeLabelQuoter(/([A-Za-z0-9_-]+)\{([^{}"|]+)\}/g, '{', '}');

/**
 * 修复一份 parse 失败的 mermaid 源码。无可修项(或触发规模闸)时返回逐字符
 * 相同的字符串,调用方可用 `repaired !== source` 判断是否值得重试 parse。
 */
export function repairMermaidSource(source: string): string {
  if (source.length > MAX_REPAIR_SOURCE_LENGTH) return source;
  const lines = source.split('\n');
  if (lines.some((l) => l.length > MAX_REPAIR_LINE_LENGTH)) return source;
  const flowchart = isFlowchartSource(lines);
  const repaired = lines
    .map((line) => {
      if (/^\s*\/\//.test(line)) return line.replace(/^(\s*)\/\//, '$1%%');
      if (!flowchart) return line;
      const t = line.trim();
      if (!t || t.startsWith('%%')) return line;
      let fixed = line.replace(/^(\s*subgraph\s+[A-Za-z0-9_-]+)\[/, '$1 [');
      // 加引号的 pass 全部先跑(不改渲染文本),箭头替换(改文本)压轴——
      // 顺序是内容保真的关键,见文件头。
      fixed = mapOutsideQuotes(fixed, quoteEdgeLabels);
      fixed = mapOutsideQuotes(fixed, quoteSquareLabels);
      fixed = mapOutsideQuotes(fixed, quoteRoundLabels);
      fixed = mapOutsideQuotes(fixed, quoteCurlyLabels);
      return fixed;
    })
    .join('\n');
  // Labels may span physical lines, so the arrow rewrite runs on the whole source
  // and keeps its quote and label state across them.
  return flowchart
    ? mapOutsideQuotesAndLabels(repaired, (s) => s.replace(UNICODE_ARROW_RE, '-->'))
    : repaired;
}
