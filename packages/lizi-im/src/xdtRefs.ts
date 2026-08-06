/**
 * xdtRefs.ts — `xdt-image://` / `xdt-file://` 引用解析(渠道无关)。
 * ---------------------------------------------------------------------------
 * agent 文本里嵌的 xdt-* markdown 引用在各渠道的流式/收尾处理是同一套语义:
 *   - 中间帧: 替换成占位文本(渠道不接受裸 xdt-* URL)
 *   - finalize: 图片上传到渠道、文件单独发消息、正文剥掉 file 链接
 * 本模块只做纯文本解析, 上传/发送由各渠道 streamingText 自己实现。
 *
 * 引用形态(与 legacy feishuBot/replyClient.ts 对齐):
 *   图片  `![alt](xdt-image://...)` 或 `![alt](cindy-media://...)`(媒体总仓
 *         当前地址,生成图与集成图片均为此形态)
 *   文件  `[name](xdt-file:///abs/path)`
 */

import path from 'node:path';

export interface XdtImageRef {
  alt: string;
  url: string;
  start: number;
  end: number;
}

interface ParsedXdtRef extends XdtImageRef {
  kind: 'image' | 'file';
}

/**
 * 判定 text[openBracket] 处是否**直接**开始一个 managed-media 引用。判据与
 * parseXdtRefs 主循环逐条同语义(前一字符 '!' 决定 image、alt 扫描遇 '[' 即
 * 放弃、']( ' 收尾、按 image 与否认 scheme), 只读、无副作用。
 *
 * "直接"很关键: alt 里再出现 '[' 时返回 false —— 那个更内层的 '[' 才可能是
 * 起点, 外层的恢复循环会继续迭代到它。
 */
function refStartsAt(text: string, openBracket: number): boolean {
  const image = openBracket > 0 && text[openBracket - 1] === '!';
  let altEnd = openBracket + 1;
  while (
    altEnd < text.length &&
    text[altEnd] !== '[' &&
    !(text[altEnd] === ']' && text[altEnd + 1] === '(')
  ) {
    altEnd += 1;
  }
  if (altEnd >= text.length || text[altEnd] === '[') return false;

  const urlStart = altEnd + 2;
  return image
    ? text.startsWith('xdt-image://', urlStart) || text.startsWith('cindy-media://', urlStart)
    : text.startsWith('xdt-file://', urlStart);
}

/**
 * Parse managed-media Markdown in one forward pass. Model output is
 * uncontrolled input, so this deliberately avoids the former global regexes:
 * repeated near-matches could make the regex engine rescan a long suffix.
 */
function parseXdtRefs(text: string): ParsedXdtRef[] {
  const refs: ParsedXdtRef[] = [];
  let cursor = 0;
  // ')' 查找的单调缓存。搜索起点跨候选严格递增(scheme 不匹配的路径根本不查
  // 括号; 恢复后新候选的 urlStart 在恢复点之后; 收下引用后 cursor = endParen
  // + 1 > 上次命中), 且 [上次起点, 上次命中) 区间内必无 ')' —— 所以起点仍
  // ≤ 上次命中时可直接复用, 与每次重新 indexOf 等价, 每个文本位置至多被扫
  // 一次。没有它, 形如 '[a](xdt-file://x'.repeat(N) + ')' 的对抗输入会让 N 个
  // 候选各自重扫同一个尾括号, 退化成 Θ(n²)(#1856 review 第三轮: 这条平方
  // 向量是畸形恢复引入的, 收敛前的解析器一次扫到 ')' 就整体跳过)。
  let cachedParen = -2; // -2 = 尚无缓存
  const nextParen = (from: number): number => {
    if (cachedParen >= from) return cachedParen;
    cachedParen = text.indexOf(')', from);
    return cachedParen;
  };

  while (cursor < text.length) {
    const openBracket = text.indexOf('[', cursor);
    if (openBracket === -1) break;

    const image = openBracket > 0 && text[openBracket - 1] === '!';
    const start = image ? openBracket - 1 : openBracket;
    const altStart = openBracket + 1;
    let altEnd = altStart;
    while (
      altEnd < text.length &&
      text[altEnd] !== '[' &&
      !(text[altEnd] === ']' && text[altEnd + 1] === '(')
    ) {
      altEnd += 1;
    }

    // A nested opening bracket supersedes the malformed outer candidate. This
    // both preserves later valid refs and keeps the scan strictly forward.
    if (text[altEnd] === '[') {
      cursor = altEnd;
      continue;
    }
    if (altEnd >= text.length) break;

    const urlStart = altEnd + 2;
    const scheme = image
      ? text.startsWith('xdt-image://', urlStart)
        ? 'xdt-image://'
        : text.startsWith('cindy-media://', urlStart)
          ? 'cindy-media://'
          : null
      : text.startsWith('xdt-file://', urlStart)
        ? 'xdt-file://'
        : null;
    if (!scheme) {
      cursor = urlStart;
      continue;
    }

    const endParen = nextParen(urlStart + scheme.length);
    if (endParen === -1) break;
    // 畸形恢复(#1856 review P2): 未闭合引用会让本候选一路扫到**下一个**引用
    // 的右括号, 把后续合法引用整段吞进自己的 URL —— 收集丢附件, transform 还会
    // 把整段错误改写。判据是 URL 段里出现**构成引用起点**的 '['(#1856 review
    // P1 收窄: 早先"出现任意 '[' 就放弃"过宽, 把合法方括号文件名如
    // `[f](xdt-file:///tmp/report[final].pdf)` 静默丢掉 —— 旧正则实现与收敛前
    // 的解析器都接受这类 URL)。命中即放弃本候选、从那个 '[' 恢复前向扫描;
    // 一个都不命中就照常收下, URL 里的 '['/']' 原样保留。
    //
    // cursor 仍严格前进: recovery ≥ urlStart + scheme.length > openBracket。
    // 恢复判定本身是线性(本解析器防 ReDoS/防回扫的前提): refStartsAt 的 alt
    // 扫描天然停在下一个 '[', 一段里相邻 '[' 的间距之和 ≤ 段长; 且恢复点是本段
    // 第一个引用起点, 下一候选的 URL 段从它之后才开始, 各候选扫过的区间互不
    // 重叠。恢复带来的 ')' 重复定位由上面的 nextParen 单调缓存兜住。
    let recovery = -1;
    for (
      let bracket = text.indexOf('[', urlStart + scheme.length);
      bracket !== -1 && bracket < endParen;
      bracket = text.indexOf('[', bracket + 1)
    ) {
      if (refStartsAt(text, bracket)) {
        recovery = bracket;
        break;
      }
    }
    if (recovery !== -1) {
      cursor = recovery;
      continue;
    }
    if (endParen > urlStart + scheme.length) {
      refs.push({
        kind: image ? 'image' : 'file',
        alt: text.slice(altStart, altEnd),
        url: text.slice(urlStart, endParen),
        start,
        end: endParen + 1,
      });
    }
    cursor = endParen + 1;
  }

  return refs;
}

function replaceXdtRefs(
  text: string,
  refs: ReadonlyArray<ParsedXdtRef>,
  replacement: (ref: ParsedXdtRef) => string,
): string {
  if (refs.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const ref of refs) {
    parts.push(text.slice(cursor, ref.start), replacement(ref));
    cursor = ref.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * 剥掉 Windows 盘符路径解码后残留的多余前导斜杠。
 *
 * 约定写法 xdt-file:///<绝对路径>:Unix 下剥协议后的首个 `/` 就是根;
 * Windows 盘符路径剥完剩 `/C:\...`(或 /C:/...),多余前导 `/` 会让下游
 * 存在性检查 / 目录白名单比对失败 → 文件静默丢失(2026-07-16 hook 渠道
 * 实踩)。这里是该归一化的唯一实现 —— hook-control/outbound.ts 的严格版
 * 解析(fail-closed 读盘校验)也消费它, 不再各持副本。
 */
export function normalizeXdtAbsPath(decoded: string): string {
  return decoded.replace(/^\/+([A-Za-z]:[\\/])/, '$1');
}

/** xdt-file://<absPath> → absPath (URL-decoded). */
export function xdtFileUrlToAbsPath(url: string): string {
  const raw = url.replace(/^xdt-file:\/\//, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return normalizeXdtAbsPath(decoded);
}

/** Replace xdt-* refs with placeholder text suitable for intermediate frames. */
export function stripXdtForStreaming(text: string): string {
  const refs = parseXdtRefs(text);
  return replaceXdtRefs(text, refs, (ref) => {
    if (ref.kind === 'image') return `[🖼️ ${ref.alt || '图片'} · 上传中...]`;
    const display = ref.alt || path.basename(xdtFileUrlToAbsPath(ref.url));
    return `[📎 ${display} · 准备发送...]`;
  });
}

/** Detect if `text` is essentially "only xdt refs" (no real prose). Used for
 *  picking a friendlier placeholder during streaming. */
export function classifyXdtOnly(
  text: string,
): 'image-only' | 'file-only' | 'mixed-or-text' {
  const refs = parseXdtRefs(text);
  const trimmed = replaceXdtRefs(text, refs, () => '').trim();
  if (trimmed.length > 0) return 'mixed-or-text';
  const hasImg = refs.some((ref) => ref.kind === 'image');
  const hasFile = refs.some((ref) => ref.kind === 'file');
  if (hasImg && !hasFile) return 'image-only';
  if (hasFile && !hasImg) return 'file-only';
  return 'mixed-or-text';
}

/** Remove xdt-file links entirely (since they're delivered as separate file messages). */
export function stripXdtFileLinks(text: string): string {
  const refs = parseXdtRefs(text).filter((ref) => ref.kind === 'file');
  return replaceXdtRefs(text, refs, () => '');
}

/** Remove managed-image Markdown after it has been delivered as media. */
export function stripXdtImageLinks(text: string): string {
  const refs = parseXdtRefs(text).filter((ref) => ref.kind === 'image');
  return replaceXdtRefs(text, refs, () => '');
}

export interface XdtFileLink {
  alt: string;
  absPath: string;
}

/** Collect xdt-file links from text, deduped by absPath (model often repeats). */
export function collectXdtFileLinks(text: string): XdtFileLink[] {
  const seen = new Map<string, XdtFileLink>();
  for (const ref of parseXdtRefs(text)) {
    if (ref.kind !== 'file') continue;
    const absPath = xdtFileUrlToAbsPath(ref.url);
    if (seen.has(absPath)) continue;
    seen.set(absPath, { alt: ref.alt, absPath });
  }
  return Array.from(seen.values());
}

/** Collect managed-image refs in source order, including text offsets. */
export function collectXdtImageRefs(text: string): XdtImageRef[] {
  return parseXdtRefs(text)
    .filter((ref) => ref.kind === 'image')
    .map(({ alt, url, start, end }) => ({ alt, url, start, end }));
}

/** 文件引用(与 XdtImageRef 同形, url 未解码 —— 调用方自行决定解码与校验策略)。 */
export type XdtFileRef = XdtImageRef;

/**
 * Collect xdt-file refs in source order, including the raw URL. 与
 * collectXdtFileLinks 的差异: 不解码路径、不去重 —— 给需要按 URL 维度
 * 记账 / 自带严格路径校验的调用方(hook-control/outbound)用。
 */
export function collectXdtFileRefs(text: string): XdtFileRef[] {
  return parseXdtRefs(text)
    .filter((ref) => ref.kind === 'file')
    .map(({ alt, url, start, end }) => ({ alt, url, start, end }));
}

export interface XdtRefTransform {
  /** 图片引用替换文本; 缺省 = 该类引用原样保留。 */
  image?: (ref: XdtImageRef) => string;
  /** 文件引用替换文本; 缺省 = 该类引用原样保留。 */
  file?: (ref: XdtFileRef) => string;
}

/**
 * 单遍变换文本里的托管媒体引用(收口正文改写的共享原语)。
 * 与 strip 系列的差异: 替换文案由调用方按引用逐个决定(如"已作为附件
 * 发送" vs 保留可读标签), 而不是固定剥离。
 */
export function transformXdtRefs(text: string, transform: XdtRefTransform): string {
  const refs = parseXdtRefs(text).filter((ref) =>
    ref.kind === 'image' ? transform.image !== undefined : transform.file !== undefined,
  );
  return replaceXdtRefs(text, refs, (ref) =>
    ref.kind === 'image'
      ? transform.image!({ alt: ref.alt, url: ref.url, start: ref.start, end: ref.end })
      : transform.file!({ alt: ref.alt, url: ref.url, start: ref.start, end: ref.end }),
  );
}

/** Collect unique xdt-image URLs from text. */
export function collectXdtImageUrls(text: string): string[] {
  const set = new Set<string>();
  for (const ref of collectXdtImageRefs(text)) set.add(ref.url);
  return Array.from(set);
}
