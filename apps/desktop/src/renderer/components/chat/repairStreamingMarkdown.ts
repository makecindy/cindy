/**
 * repairStreamingMarkdown — 流式中对**尚未闭合的 markdown 语法**做临时修复,
 * 减少"半个语法符号导致的结构翻转与样式跳变"(Codex Desktop 同源思路)。
 *
 * 只在 isStreaming 时由 MarkdownRenderer 调用,作用于喂给 ReactMarkdown 的
 * 字符串;终版渲染(isStreaming=false)用原文,不经过本函数 —— 修复永远不会
 * 进入落库或最终展示。
 *
 * 修复项(全部只针对**文末正在生长**的语法,不动已完整的部分):
 *   1. 未闭合代码围栏:补 ``` 闭合后直接返回(围栏内是代码,不做行内修复)。
 *   2. 行内反引号奇数(inline code 半开):行内修复全部跳过 —— 分不清后续
 *      星号在不在代码里,宁可不修。
 *   3. 半截图片 `![alt](url-in-progress` / `![al`:先渲染 alt 文本,图片语法
 *      完整后再翻转成 <img>(翻转只影响该词,稳定 key 兜底)。
 *   4. 半截链接 `[text](url-in-progress`:先渲染链接文本。
 *   5. 未配对 `**` / `*`:补闭合 —— 加粗/斜体在流式中立即成型,真正的闭合符
 *      到达时结构不再翻转(这是消除"文本节点被劈开 → 前文重排"的源头)。
 *
 * 保守边界:强调符修复只在"最后一个开符之后是同一行的非空白正文"时才补 ——
 *   开符后是空白(不构成 CommonMark opener)、跨行、或含反引号时一律不动;
 *   斜体计数排除 `**` 的组成部分、转义符与行首列表标记。修不了的情况保持
 *   原样(渲染为字面量,与修复前行为一致),绝不能把合法文本改错。
 */

/** 行首(允许前导空白)的 ``` 围栏行。 */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/** 扫描围栏开合;返回 open 状态与"围栏外"文本(供行内反引号计数)。 */
function scanFences(md: string): { open: boolean; outside: string; fenceMarker: string } {
  let open = false;
  let fenceMarker = '';
  const outside: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = FENCE_LINE.exec(line);
    if (m) {
      const marker = m[1][0];
      if (!open) {
        open = true;
        fenceMarker = m[1];
        continue;
      }
      // 闭合围栏须与开围栏同字符。
      if (
        marker === fenceMarker[0] &&
        m[1].length >= fenceMarker.length &&
        /^[ \t]*$/.test(m[2])
      ) {
        open = false;
        fenceMarker = '';
        continue;
      }
      continue;
    }
    if (!open) outside.push(line);
  }
  return { open, outside: outside.join('\n'), fenceMarker };
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/** `*` 是否是行首列表标记(前面只有空白、后面紧跟空白)。 */
function isBulletMarker(text: string, index: number): boolean {
  const next = text[index + 1];
  if (next !== ' ' && next !== '\t') return false;
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** 统计未转义的 delim 出现次数与最后出现位置;mixed = 出现 ≥3 连星复合 run。 */
function scanDelim(
  text: string,
  delim: '**' | '*',
): { count: number; last: number; mixed: boolean } {
  let count = 0;
  let last = -1;
  let mixed = false;
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '*' || isEscaped(text, i)) {
      i++;
      continue;
    }
    // 按连续星号 run 归类:run=1 是斜体符,run=2 是加粗符;run≥3 是加粗+斜体
    // 复合(`***`),配对语义随上下文变化,超出保守修复范围 —— 整个 delimiter
    // 放弃修复,交给终版渲染。
    let runEnd = i;
    while (runEnd < text.length && text[runEnd] === '*') runEnd++;
    const runLen = runEnd - i;
    if (runLen >= 3) mixed = true;
    else if (delim === '**' && runLen === 2) {
      count += 1;
      last = i;
    } else if (delim === '*' && runLen === 1 && !isBulletMarker(text, i)) {
      count += 1;
      last = i;
    }
    i = runEnd;
  }
  return { count, last, mixed };
}

/** 未配对强调符:最后开符之后是同一行非空白正文时补闭合。 */
function balanceEmphasis(md: string, delim: '**' | '*'): string {
  if (!md.includes(delim === '**' ? '**' : '*')) return md;
  const { count, last, mixed } = scanDelim(md, delim);
  if (mixed || count % 2 === 0 || last < 0) return md;
  const rest = md.slice(last + delim.length);
  if (rest.length === 0) return md; // 开符悬在文末,下一 chunk 才有正文
  if (!rest.trim()) return md;
  if (rest.includes('\n')) return md; // 只修同一行内正在生长的强调
  if (rest.includes('`')) return md;
  if (/^\s/.test(rest)) return md; // 开符后接空白不构成 opener,补闭合会变字面量
  return md + delim;
}

/** 半截图片:`![alt](partial` / `![partial` → 先渲染 alt 文本。 */
function repairTrailingImage(md: string): string {
  return md
    .replace(/!\[([^\]\n]*)\]\([^)\n]*$/, '$1')
    .replace(/!\[([^\]\n]*)$/, '$1');
}

/** 半截链接:`[text](partial` → 先渲染链接文本(`![` 图片已在前一步处理)。 */
function repairTrailingLink(md: string): string {
  return md.replace(/(^|[^!\\])\[([^\]\n]*)\]\([^)\n]*$/, '$1$2');
}

export function repairStreamingMarkdown(md: string): string {
  if (md.length === 0) return md;
  const { open, outside, fenceMarker } = scanFences(md);
  if (open) {
    // 围栏内是代码:补闭合即可,行内修复不适用。
    return md.endsWith('\n') ? `${md}${fenceMarker}` : `${md}\n${fenceMarker}`;
  }
  // inline code 半开(围栏外反引号计数为奇数):后续星号可能在代码里,不修。
  let backticks = 0;
  for (let i = 0; i < outside.length; i++) {
    if (outside[i] === '`' && !isEscaped(outside, i)) backticks++;
  }
  if (backticks % 2 === 1) return md;
  let t = md;
  if (t.includes('![')) t = repairTrailingImage(t);
  if (t.includes('](')) t = repairTrailingLink(t);
  t = balanceEmphasis(t, '**');
  t = balanceEmphasis(t, '*');
  return t;
}
