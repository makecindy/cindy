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
 * unicode 箭头替换(会改文本)最后跑——箭头替换会跳过引号段和保留原有定界符的形状变体标签;
 * 节点形状属性 @{...} 保持原样;
 * unicode 箭头本身也算入"标签需要加引号"的危险字符。残余风险:旧式 `A -- text --> B` 的裸边文本没有可靠定界符,
 * 其中的 unicode 箭头仍会被替换——接受(该写法罕见且修复仅在失败后运行)。
 *
 * 修复项:
 *   1. `//` 行注释 → `%%`(所有图类型通用)
 *   2. 仅 flowchart / graph(其它图类型会被下列规则误伤——er 的 `||--o{`
 *      基数、sequence 的 `->>` 箭头等——按首行图类型闸住):
 *      - `subgraph Id[...]` 缺空格 → `subgraph Id [...]`
 *      - 未加引号的边标签 `-->|text|` → `-->|"text"|`(引号混用易翻车,统一补齐)
 *      - 含危险字符的节点标签 `Id[text]` / `Id(text)` / `Id{text}` → 标签加引号
 *      - unicode 箭头(→ ⟶ ➔ ➜ ⇒ ⟹)→ `-->`(跳过引号和形状变体标签,最后执行)
 *
 * 性能:节点标签正则是 O(行长²) 的回溯形态,病态输入(模型把 base64 / 长日志
 * 误标进 mermaid 围栏)会把渲染线程冻住秒级。合法 mermaid 不存在超长单行,
 * 超过规模闸直接原样返回,整体退化为一次线性扫描。
 */

/** 单行超过此长度即放弃修复(合法 mermaid 不存在这种行,防 O(n²) 回溯冻结)。 */
const MAX_REPAIR_LINE_LENGTH = 2_000;

/** 整体超过此长度即放弃修复(同上,规模闸)。 */
const MAX_REPAIR_SOURCE_LENGTH = 100_000;

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

/** 形状修饰符必须成对保留，标签内使用普通括号不会提前结束形状。 */
const SHAPE_ENDS = new Map([
  ['([', '])'],
  ['[(', ')]'],
  ['[[', ']]'],
  ['{{', '}}'],
  ['((', '))'],
  ['(((', ')))'],
  ['[/', '/]'],
  ['[\\', '/]'],
  ['>', ']'],
]);
const LABEL_BRACKET_ENDS = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

/**
 * 从右向左索引各个闭合符。每个位置可以跳过一整个配对括号或引号段，
 * 这样未闭合的形状不会让下一个候选重新扫描同一段。
 */
function indexLabelEnds(line: string) {
  const Offsets = line.length > 0xffff ? Uint32Array : Uint16Array;
  const bracketEnds = new Map([...LABEL_BRACKET_ENDS.values()].map(
    (end) => [end, new Offsets(line.length + 1)],
  ));
  const shapeEnds = new Map([...new Set(SHAPE_ENDS.values())].map(
    (end) => [end, new Offsets(line.length + 1)],
  ));
  const allEnds = [...bracketEnds, ...shapeEnds];
  let nextQuote = -1;

  for (let i = line.length - 1; i >= 0; i--) {
    const char = line[i];
    let next = i + 1;
    const bracketEnd = LABEL_BRACKET_ENDS.get(char);
    if (bracketEnd) {
      next = bracketEnds.get(bracketEnd)![next] || line.length;
    } else if (char === '"') {
      if (nextQuote !== -1) next = nextQuote + 1;
      nextQuote = i;
    }

    for (const [end, offsets] of allEnds) {
      // 斜边矩形的结束符允许两种斜线方向。
      const matches = line.startsWith(end, i) || (end === '/]' && line.startsWith('\\]', i));
      offsets[i] = matches ? i + end.length : offsets[next];
    }
  }
  return { bracketEnds, shapeEnds };
}

function replaceArrowsOutsideLabels(line: string): string {
  if (line.search(UNICODE_ARROW_RE) === -1) return line;
  // 先跳过完整引号段或节点形状，再继续同一行的边。未闭合形状沿用普通扫描。
  const protectedStarts = /"[^"]*(?:"|$)|(?<!-)--+>|(?<!=)==+>|(?<!\.)-?\.+->|(?<=[\p{L}\p{N}\p{M}_.!,?#$%*+/:&'`\\-])(?:\({2,3}|\(\[|\[[[(\/\\]|\{\{|>)/gu;
  let result = '';
  let start = 0;
  let labelEnds: ReturnType<typeof indexLabelEnds> | undefined;
  for (let match = protectedStarts.exec(line); match; match = protectedStarts.exec(line)) {
    const token = match[0];
    const shapeEnd = SHAPE_ENDS.get(token);
    if (!shapeEnd && token[0] !== '"') continue;
    if (shapeEnd) {
      labelEnds ??= indexLabelEnds(line);
      const end = labelEnds.shapeEnds.get(shapeEnd)![protectedStarts.lastIndex];
      if (!end) continue;
      protectedStarts.lastIndex = end;
    }
    result += line.slice(start, match.index).replace(UNICODE_ARROW_RE, '-->');
    result += line.slice(match.index, protectedStarts.lastIndex);
    start = protectedStarts.lastIndex;
  }
  return result + line.slice(start).replace(UNICODE_ARROW_RE, '-->');
}

/** 图类型判定:跳过 YAML frontmatter 与 `%%` 注释后,看首个有效行。 */
function flowchartStartLine(lines: string[]): number {
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) start = close + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('%%')) continue;
    return /^(flowchart|graph)\b/.test(t) ? i : -1;
  }
  return -1;
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

function repairLines(source: string, flowchart: boolean, startsOnNewLine = true): string {
  return source.split('\n').map((line, index) => {
    const atLineStart = index > 0 || startsOnNewLine;
    if (atLineStart && /^\s*\/\//.test(line)) return line.replace(/^(\s*)\/\//, '$1%%');
    if (!flowchart || !line.trim() || (atLineStart && line.trimStart().startsWith('%%'))) {
      return line;
    }
    let fixed = atLineStart ? line.replace(/^(\s*subgraph\s+[A-Za-z0-9_-]+)\[/, '$1 [') : line;
    // 加引号不改渲染文本，必须先于箭头替换。
    fixed = mapOutsideQuotes(fixed, quoteEdgeLabels);
    fixed = mapOutsideQuotes(fixed, quoteSquareLabels);
    fixed = mapOutsideQuotes(fixed, quoteRoundLabels);
    fixed = mapOutsideQuotes(fixed, quoteCurlyLabels);
    return replaceArrowsOutsideLabels(fixed);
  }).join('\n');
}

function findShapeDataEnd(source: string, start: number): number {
  const delimiters = /["}]/g;
  delimiters.lastIndex = start;
  let quoted = false;
  for (let match = delimiters.exec(source); match; match = delimiters.exec(source)) {
    if (match[0] === '"') quoted = !quoted;
    else if (!quoted) return delimiters.lastIndex;
  }
  return -1;
}

function repairFlowchart(source: string, chartStart: number): string {
  // 从节点 ID 后的 @{ 识别属性，把 YAML 语法交给 Mermaid。
  // 回调、样式声明和类选择器里的连字符属于名称或值。
  const tokens = /^[^\S\r\n]*(?:%%|\/\/)[^\n]*|(?:^|;)[^\S\r\n]*(?:acc(?:Title|Descr)[^\S\r\n]*:[^\n]*|accDescr[^\S\r\n]*\{[^}]*\}|(?:click|classDef|class|style|linkStyle)[^\S\r\n]+(?:"[^"\r\n]*"|[^";\r\n])*)|"[^"]*"|"[^"\n]*|\|[^|\n]+\||:::[\p{L}\p{N}\p{M}_]+(?:[.-]+[\p{L}\p{N}\p{M}_]+)*|(?<![^\s;])[^\s"@;]+@(?=[^\S\r\n]*[xo<]?(?:--|==|-\.|\.+-|~~~))|--+[-xo>]|--|==+[=xo>]|==|(?<!\.)-?\.+-[xo>]?|-\.|~~~+|(?<=[\p{L}\p{N}\p{M}_.!,?#$%*+/:&'`\\-])(?:@\{|\([^()[\]{}"\n]*\)|\[[^()[\]{}"\n]*\]|\{[^()[\]{}"\n]*\}|\({2,3}|\(\[|\[[[(\/\\]|\{\{|[({\[>])/gmu;
  tokens.lastIndex = chartStart;
  const edgeLabelClosers = new Map([['--', /^--+[-xo>]$/], ['==', /^==+[=xo>]$/], ['-.', /^\.+-[xo>]?$/]]);
  let result = '';
  let start = 0;
  let edgeLabelEnd: RegExp | undefined;
  let labelLineStart = 0;
  let labelLineEnd = -1;
  let labelEnds: ReturnType<typeof indexLabelEnds> | undefined;
  let documentLabelEnds: ReturnType<typeof indexLabelEnds> | undefined;
  const lastLabelClose = Math.max(source.lastIndexOf(']'), source.lastIndexOf(')'), source.lastIndexOf('}'));
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    const token = match[0];
    // 旧式边标签位于两段连接符之间，例如 A -- text --> B。
    if (edgeLabelEnd?.test(token)) edgeLabelEnd = undefined;
    else edgeLabelEnd ??= edgeLabelClosers.get(token);
    if (edgeLabelEnd) continue;
    const shapeEnd = SHAPE_ENDS.get(token);
    const bracketEnd = LABEL_BRACKET_ENDS.get(token);
    let preservedEnd = -1;
    if (shapeEnd || bracketEnd) {
      // 节点标签里的 --、==、-. 是文字，不开启边标签。
      if (match.index >= labelLineEnd) {
        labelLineStart = source.lastIndexOf('\n', match.index) + 1;
        const newline = source.indexOf('\n', match.index);
        labelLineEnd = newline === -1 ? source.length : newline;
        const labelLine = source.slice(labelLineStart, labelLineEnd);
        // 只有可能改变边或属性扫描状态的行才需要索引。
        labelEnds = /--|==|-\.|@\{/.test(labelLine) ? indexLabelEnds(labelLine) : undefined;
      }
      const offsets = shapeEnd ? labelEnds?.shapeEnds.get(shapeEnd) : labelEnds?.bracketEnds.get(bracketEnd!);
      const end = offsets?.[tokens.lastIndex - labelLineStart];
      if (end) {
        tokens.lastIndex = labelLineStart + end;
        continue;
      }
      if (labelLineEnd < lastLabelClose) {
        documentLabelEnds ??= indexLabelEnds(source);
        const multilineOffsets = shapeEnd
          ? documentLabelEnds.shapeEnds.get(shapeEnd)
          : documentLabelEnds.bracketEnds.get(bracketEnd!);
        const multilineEnd = multilineOffsets![tokens.lastIndex];
        if (multilineEnd > labelLineEnd) preservedEnd = multilineEnd;
      }
    } else if (token === '@{') {
      preservedEnd = findShapeDataEnd(source, tokens.lastIndex);
      if (preservedEnd === -1) break;
    } else if (token.startsWith('"') && token.includes('\n')) {
      preservedEnd = tokens.lastIndex;
    }
    if (preservedEnd === -1) continue;
    result += repairLines(source.slice(start, match.index), true, start === 0);
    result += source.slice(match.index, preservedEnd);
    start = tokens.lastIndex = preservedEnd;
  }
  return result + repairLines(source.slice(start), true, start === 0);
}

/**
 * 修复一份 parse 失败的 mermaid 源码。无可修项(或触发规模闸)时返回逐字符
 * 相同的字符串,调用方可用 `repaired !== source` 判断是否值得重试 parse。
 */
export function repairMermaidSource(source: string): string {
  if (source.length > MAX_REPAIR_SOURCE_LENGTH) return source;
  const lines = source.split('\n');
  if (lines.some((l) => l.length > MAX_REPAIR_LINE_LENGTH)) return source;
  const startLine = flowchartStartLine(lines);
  if (startLine === -1 || (!source.includes('@{') && source.search(UNICODE_ARROW_RE) === -1)) {
    return repairLines(source, startLine !== -1);
  }
  const chartStart = lines.slice(0, startLine).reduce((offset, line) => offset + line.length + 1, 0);
  return repairFlowchart(source, chartStart);
}
