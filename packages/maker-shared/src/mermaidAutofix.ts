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
  ['[/', ']'],
  ['[\\', ']'],
]);
const LABEL_BRACKET_ENDS = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

function findShapeEnd(line: string, start: number, end: string): number {
  const brackets: string[] = [];
  for (let i = start; i < line.length; i++) {
    const char = line[i];
    if (brackets.length === 0 && line.startsWith(end, i)) {
      // 斜边矩形的两个斜边可以同向或反向，但必须紧贴成对的方括号。
      if (end !== ']' || (i > start && (line[i - 1] === '/' || line[i - 1] === '\\'))) {
        return i + end.length;
      }
    }
    if (char === '"') {
      const quoteEnd = line.indexOf('"', i + 1);
      if (quoteEnd !== -1) i = quoteEnd;
      continue;
    }
    const bracketEnd = LABEL_BRACKET_ENDS.get(char);
    if (bracketEnd) brackets.push(bracketEnd);
    else if (char === brackets[brackets.length - 1]) brackets.pop();
  }
  return -1;
}

function replaceArrowsOutsideLabels(line: string): string {
  if (line.search(UNICODE_ARROW_RE) === -1) return line;
  // 先跳过完整引号段或节点形状，再继续同一行的边。未闭合形状沿用普通扫描。
  const protectedStarts = /"[^"]*(?:"|$)|(?<=[\p{L}\p{N}\p{M}_.!?#$%*+/:&'`\\-])(?:\({2,3}|\(\[|\[[[(\/\\]|\{\{)/gu;
  let result = '';
  let start = 0;
  for (let match = protectedStarts.exec(line); match; match = protectedStarts.exec(line)) {
    const token = match[0];
    const shapeEnd = SHAPE_ENDS.get(token);
    if (shapeEnd) {
      const end = findShapeEnd(line, protectedStarts.lastIndex, shapeEnd);
      if (end === -1) continue;
      protectedStarts.lastIndex = end;
    }
    result += line.slice(start, match.index).replace(UNICODE_ARROW_RE, '-->');
    result += line.slice(match.index, protectedStarts.lastIndex);
    start = protectedStarts.lastIndex;
  }
  return result + line.slice(start).replace(UNICODE_ARROW_RE, '-->');
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
  return lines
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
      return replaceArrowsOutsideLabels(fixed);
    })
    .join('\n');
}
