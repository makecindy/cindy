/**
 * pastePipeline — 输入框粘贴文本的统一变换管线(纯函数层,无 Tiptap / IPC 依赖)。
 *
 * ChatInput.handlePaste 对剪贴板文本按以下优先级走管线,命中即停:
 *   1. 长文本(isLongPasteText)→ 整段折叠为 PastedTextChip(长 log 里的
 *      深链 / 路径不再逐个 chip 化——那是噪音不是引用);
 *   2. 深链 / 路径混排(segmentPastedContent)→ text / session / project /
 *      path 分段:session、project 即时成 chip;path 段先落纯文本,由
 *      pathPaste.ts 异步 stat 确认后原地升级(见该文件头注释);
 *   3. 都不命中 → null,调用方 fall through 到默认粘贴。
 *
 * 深链匹配正则源与 lib/deepLink.ts 单点共享;session 段的 chip attrs /
 * 序列化 / 标题解析在 sessionLinkPaste.ts(PR #970),本文件只做编排与
 * project / path 的纯函数部分。
 */
import {
  parseSessionDeepLinkHref,
  parseProjectDeepLinkHref,
  projectDisplayName,
  findMarkdownLabelStart,
  unescapeMarkdownLabelBrackets,
  SESSION_DEEP_LINK_RE_SOURCE,
  PROJECT_DEEP_LINK_RE_SOURCE,
} from '@/lib/deepLink';
import { textContainsDeepLink } from '../../../shared/deepLinkSchemes';

import type { MentionChipAttrs } from './MentionChipNode';
import { sanitizeSessionChipTitle } from './sessionLinkPaste';

// ── 长文本折叠阈值 ──
// 行数对齐消息气泡「长消息收起」的手打阈值(14 行)再放宽一档:短粘贴保持
// 直觉(所见即所得),真正的大段 log / diff 才折叠。字符阈值兜住"单行超长"
// (压缩 JSON / base64)。上限:原文会进节点 attrs 并随 toDOM 写进
// data-pasted-text(剪贴板回环依赖它,见 PastedTextChipNode),超大文本挂
// 在 DOM attribute 上代价过高——超限的粘贴不折叠,走默认粘贴(极罕见,
// 编辑器变慢但内容无损)。
export const LONG_PASTE_LINE_THRESHOLD = 24;
export const LONG_PASTE_CHAR_THRESHOLD = 4_000;
export const LONG_PASTE_MAX_CHARS = 2_000_000;

/** 粘贴文本是否该折叠成 PastedTextChip。 */
export function isLongPasteText(text: string): boolean {
  if (text.length > LONG_PASTE_MAX_CHARS) return false;
  if (text.length >= LONG_PASTE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines >= LONG_PASTE_LINE_THRESHOLD) return true;
  }
  return false;
}

/**
 * 剪贴板 HTML 是否带本编辑器自家的 chip 标记(mentionChip / pastedTextChip /
 * composerQuote / quickStartPill)
 * 的 toDOM 输出)。命中时 handlePaste 应把整个粘贴交回 ProseMirror 默认
 * HTML 解析(parseHTML 原样还原 chip 与周围文本),跳过全部文本变换管线:
 * atom chip 在 text/plain 里没有文本投影,任何「取 text/plain 处理」的分支
 * (长文本折叠 / 深链分段 / 强制纯文本)都会把 chip 的 payload 整个丢掉
 * (review P2:复制「请看 <粘贴文本 chip>」再粘回,折叠原文只存在于 HTML
 * 的 data-pasted-text 里)。标记是本产品 toDOM 专属,外部网页不会携带。
 */
export function htmlCarriesOwnChipMarkup(html: string): boolean {
  return /data-(?:mention-chip|pasted-text-chip|composer-quote|quick-start-pill)/.test(html);
}

/** 粘贴文本的行数(chip 文案用)。 */
export function countPasteLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export type PastedContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'session'; href: string; label: string | null }
  | { kind: 'project'; href: string; label: string | null }
  /** 绝对路径候选:插入时先保持原文,stat 确认后升级为 @chip(pathPaste.ts)。 */
  | { kind: 'path'; path: string };

// 与 userMessageLinkify 同口径:裸链接尾部粘连的英文句读不属于链接。
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/**
 * 绝对路径候选匹配:POSIX(`/...`)与 Windows(`X:\...` / `X:/...`)。
 * 保守收尾:空白 / 引号 / 尖括号 / 竖线 / CJK·全角标点截断;CJK **文字**
 * 允许进入路径(中文目录 / 文件名是真实场景,review P2——此前把整个非
 * ASCII 区间都当终止符,中文路径在第一个汉字处截断而失效)。排除区间:
 * \u2000-\u206F 通用标点(含弯引号 / 省略号)、\u3000-\u303F CJK 符号
 * 标点(、。「」等)、\uFE30-\uFE4F 竖排形式、\uFF00-\uFFEF 全角形式
 * (,()!?等)。路径尾紧贴汉字说明文字的形态(`/repo/文件.ts附近`)
 * 无法与文件名区分,会整段进入候选——安全:候选先以原文落地,stat miss
 * 只是不升级,不破坏文本。`:` 允许出现(agent 常输出 `path:line`,行号
 * 后缀在 trimPathCandidate 里剥离)。不含空格——含空格路径无法从自由
 * 文本里无歧义切出,交给 @ 面板 / 拖拽通道。
 */
const PATH_CANDIDATE_RE =
  /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|\u2000-\u206F\u3000-\u303F\uFE30-\uFE4F\uFF00-\uFFEF]+/g;

/**
 * 剥掉路径候选尾部的 `:12` / `:12:5` 行号列号后缀、英文句读、闭合括号与
 * 尾分隔符,返回纯路径。尾分隔符是 shell 补全 / `cd xxx/` 的常见形态,不剥会
 * 产出 `apps/desktop//` 这样的双斜杠 chip,且 `<workdir>/` 会绕过「workdir
 * 本体保持原文」守卫升级成空 chip(review P2)。四类后缀可以交错叠加
 * (`path:12,` / `(path/):12.`),单遍固定顺序会漏(行号后面跟着逗号时先剥
 * 行号剥不到,review P2),循环剥到不动点。
 */
export function trimPathCandidate(raw: string): string {
  let out = raw;
  for (;;) {
    const next = out
      .replace(TRAILING_PUNCT_RE, '')
      .replace(/[)\]}]+$/, '')
      .replace(/(?::\d+){1,2}$/, '')
      .replace(/[\\/]+$/, '');
    if (next === out) return out;
    out = next;
  }
}

export interface SegmentPastedContentOptions {
  /**
   * 会话工作目录(远程会话为被控端 native 路径)。路径候选必须落在其内
   * (前缀匹配,Windows 盘符不区分大小写)才产出 path 段——工作区外的
   * 路径 agent 多半也读不了,保持原文最诚实。空 / 未知 → 不做路径识别。
   */
  workingDir?: string | null;
}

/** Windows 比较归一:小写 + `\` → `/`(盘符/NTFS 大小写不敏感;Git Bash /
 *  Node 输出常用 `C:/...` 斜杠形态,分隔符不归一会误判「不在 workdir 内」,
 *  review P2)。仅用于比较,展示 / range 都保留原字符串。 */
function normalizeWinCompare(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/');
}

function isWithinWorkingDir(candidate: string, workingDir: string): boolean {
  // Windows 大小写不敏感(盘符 + NTFS 默认);POSIX 敏感。用盘符形态判平台。
  const winLike = /^[A-Za-z]:[\\/]/.test(workingDir);
  const a = winLike ? normalizeWinCompare(candidate) : candidate;
  const b = winLike ? normalizeWinCompare(workingDir) : workingDir;
  const base = b.replace(/[\\/]+$/, '');
  if (!a.startsWith(base)) return false;
  const next = a.charAt(base.length);
  return next === '/' || next === '\\';
}

/** path 候选 → workdir 相对路径(统一 `/` 分隔,供 @chip path attr / 序列化)。 */
export function toWorkdirRelativePath(candidate: string, workingDir: string): string {
  const base = workingDir.replace(/[\\/]+$/, '');
  return candidate.slice(base.length + 1).replace(/\\/g, '/');
}

/**
 * 把粘贴文本切成 text / session / project / path 段。没有任何可变换目标时
 * 返回 null(调用方走默认粘贴)。深链的 markdown 形式(`[标题](深链)`)
 * 优先于裸形式;路径候选在剩余 text 段上做第二遍扫描。
 */
export function segmentPastedContent(
  text: string,
  options: SegmentPastedContentOptions = {},
): PastedContentSegment[] | null {
  const deepLinkSegments = segmentDeepLinks(text);
  const workingDir = options.workingDir?.trim() || null;

  let segments: PastedContentSegment[] = deepLinkSegments ?? [{ kind: 'text', text }];
  let matchedAny = deepLinkSegments != null;

  // 快速早退:文本里连 workdir 前缀都没有就不做逐段路径扫描。Windows 路径
  // 大小写不敏感且 `\` / `/` 两种分隔符形态并存(Git Bash / Node 输出斜杠
  // 形态),含盘符形态时统一小写 + 归一分隔符后再 includes,否则
  // `c:/code/...` 对 `C:\Code\...` 会被误判为「无路径」(review P2)。
  const winLike = workingDir ? /^[A-Za-z]:[\\/]/.test(workingDir) : false;
  const containsWorkdir = workingDir
    ? (winLike ? text.toLowerCase().replace(/\\/g, '/') : text).includes(
        (winLike ? workingDir.toLowerCase().replace(/\\/g, '/') : workingDir).replace(/[\\/]+$/, ''),
      )
    : false;
  if (workingDir && containsWorkdir) {
    const withPaths: PastedContentSegment[] = [];
    for (const seg of segments) {
      if (seg.kind !== 'text') {
        withPaths.push(seg);
        continue;
      }
      const pathSegs = segmentPathCandidates(seg.text, workingDir);
      if (pathSegs) {
        matchedAny = true;
        withPaths.push(...pathSegs);
      } else {
        withPaths.push(seg);
      }
    }
    segments = withPaths;
  }

  return matchedAny ? segments : null;
}

/** 深链(session + project,裸 / markdown 两形态)分段;无命中 → null。 */
function segmentDeepLinks(text: string): PastedContentSegment[] | null {
  // 快速预筛:双 scheme(cindy:// / xdt-maker://)任一出现才进正则。
  if (!textContainsDeepLink(text)) return null;
  interface Candidate {
    start: number;
    end: number; // 不含
    seg: PastedContentSegment;
  }
  const candidates: Candidate[] = [];
  // markdown 形式:锚定 `](href)` 收尾,label 起点用方括号平衡回扫
  // (findMarkdownLabelStart,CommonMark 语义)——`[[WIP] 标题](url)` 取
  // 外层完整标题、`[x] [标题](url)` 的前置 `[x]` 保持普通文本(PR #970
  // 两轮 review 反馈定稿,贪婪 / 非贪婪正则都无法同时满足这两例)。
  const mdClose = new RegExp(
    `\\]\\((?:(${SESSION_DEEP_LINK_RE_SOURCE})|(${PROJECT_DEEP_LINK_RE_SOURCE}))\\)`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = mdClose.exec(text)) !== null) {
    const kind = m[1] !== undefined ? ('session' as const) : ('project' as const);
    const href = m[1] ?? m[2];
    const valid =
      kind === 'session' ? parseSessionDeepLinkHref(href) : parseProjectDeepLinkHref(href);
    if (!valid) continue;
    const open = findMarkdownLabelStart(text, m.index);
    if (open < 0) continue;
    // `\]` / `\[` 是 label 里的字面括号(回扫已按转义语义跳过)→ 展示前反转义。
    const raw = unescapeMarkdownLabelBrackets(text.slice(open + 1, m.index)).trim();
    candidates.push({
      start: open,
      end: m.index + m[0].length,
      seg: { kind, href, label: raw && raw !== href ? raw : null },
    });
  }
  // 裸形式(尾部粘连英文句读剥离;md 内部的裸 href 由重叠过滤丢弃)。
  const bareRe = new RegExp(
    `(${SESSION_DEEP_LINK_RE_SOURCE})|(${PROJECT_DEEP_LINK_RE_SOURCE})`,
    'g',
  );
  while ((m = bareRe.exec(text)) !== null) {
    const kind = m[1] !== undefined ? ('session' as const) : ('project' as const);
    const bare = m[0].replace(TRAILING_PUNCT_RE, '');
    const valid =
      kind === 'session' ? parseSessionDeepLinkHref(bare) : parseProjectDeepLinkHref(bare);
    // 形态匹配但解析非法 → 原样留作文本。
    if (!valid) continue;
    candidates.push({
      start: m.index,
      end: m.index + bare.length,
      seg: { kind, href: bare, label: null },
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const segments: PastedContentSegment[] = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue; // 与已接受匹配重叠(如 md 里的内部裸链接)
    if (c.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, c.start) });
    segments.push(c.seg);
    cursor = c.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

/** 在一个 text 段里切出 workdir 内的绝对路径候选;无命中 → null。 */
function segmentPathCandidates(
  text: string,
  workingDir: string,
): PastedContentSegment[] | null {
  PATH_CANDIDATE_RE.lastIndex = 0;
  const segments: PastedContentSegment[] = [];
  let cursor = 0;
  let matchedAny = false;
  let m: RegExpExecArray | null;
  while ((m = PATH_CANDIDATE_RE.exec(text)) !== null) {
    const trimmed = trimPathCandidate(m[0]);
    // workdir 本体不算(粘 workdir 自身应保持原文;@chip 相对路径会成空串)。
    if (!trimmed || !isWithinWorkingDir(trimmed, workingDir)) continue;
    if (m.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, m.index) });
    segments.push({ kind: 'path', path: trimmed });
    matchedAny = true;
    cursor = m.index + trimmed.length;
    PATH_CANDIDATE_RE.lastIndex = cursor;
  }
  if (!matchedAny) return null;
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

/** project 段 → mentionChip attrs(显式 label 优先,否则目录名占位)。 */
export function pastedProjectChipAttrs(
  seg: Extract<PastedContentSegment, { kind: 'project' }>,
): MentionChipAttrs {
  const target = parseProjectDeepLinkHref(seg.href);
  const fallback = target ? projectDisplayName(target.workingDir) : seg.href;
  const label = seg.label ? sanitizeSessionChipTitle(seg.label) : '';
  return label
    ? { kind: 'project', label, path: seg.href, titled: true }
    : { kind: 'project', label: fallback, path: seg.href, titled: false };
}

/** project chip → 发送文本:显式标题 `[标题](href)`,否则裸 href。 */
export function serializeProjectChipText(attrs: MentionChipAttrs): string {
  return attrs.titled && attrs.label ? `[${attrs.label}](${attrs.path})` : attrs.path;
}
