/**
 * hook-control/outbound.ts
 * ---------------------------------------------------------------------------
 * turn.end 出站附件收集: 从最终文本的 xdt-image / xdt-file 引用与 tool_result
 * 旁路图片(session-runner 收集的 absPath)读盘、编码 base64、施加限额, 产出
 * 协议 TaskAttachment[] 与"引用已剥离/替换"的正文。
 *
 * 引用语义与 IM 渠道收口(@cindy/im slack/streamingText.doFinalize)一致:
 *   - 图片引用 `![alt](xdt-image://...)` → 附件, 正文替换成"已作为附件发送"提示
 *   - 文件引用 `[name](xdt-file:///abs/path)` → 附件, 正文整体剥离
 * (正则与 packages/lizi-im/src/xdtRefs.ts 对齐 —— 该包未导出这些工具,
 * 这里维护精简副本, 改动语义时两处同步。)
 *
 * 限额(protocol 单帧 48MiB 的安全水位): 单图 5MiB(与入站一致)、单文件
 * 10MiB、总数 8、总字节 30MiB(base64 膨胀 4/3 后约 40MiB)。xdt-file
 * 来源是模型最终文本, 必须先落在 allowedFileRoots 内才允许读盘; 超限 /
 * 越界跳过并计入 skipped, 收集器同时在最终正文附加明确的失败提示。
 *
 * 纯逻辑 + 注入式 IO(readFile / resolveImageUrl), 单测不碰真盘(规则 14)。
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';

import type { TaskAttachment } from '@cindy/slack-hook-protocol';

// 双协议:老 xdt-image + 新 cindy-media(媒体总仓),与 @cindy/im/xdtRefs.ts 对齐
const XDT_IMAGE_REGEX = /!\[([^\]]*)\]\(((?:xdt-image|cindy-media):\/\/[^)]+)\)/g;
const XDT_FILE_REGEX = /\[([^\]]*)\]\((xdt-file:\/\/[^)]+)\)/g;

const MAX_OUT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUT_ATTACHMENTS = 8;
const MAX_OUT_TOTAL_BYTES = 30 * 1024 * 1024;

/**
 * hook 派发 turn 时附在用户消息末尾的渠道说明(session-runner 消费)。
 * 本收集器的出站契约只认最终回复文本里的 xdt-file / xdt-image 引用,但
 * 没有任何提示教模型这个约定 —— 实踩(2026-07-16)里模型两次把「把文件
 * 发给我」路由到 cindy_feishu_bot(hook 会话里唯一可见的推送工具)并失败。
 * 固定文本、逐 turn 追加,保证行为确定(规则 9);修改措辞时同步
 * collectOutboundAttachments 的实际语义,别让说明和收集器漂移。
 *
 * 关键约束:这段说明由 session-runner 用 `${prompt}\n\n${note}` 拼在用户原话
 * 之后,和用户内容同处一个 user turn —— 模型无法从消息角色上区分二者。实踩
 * (2026-07)里,用户只发了极短内容(群里 @机器人 带一句话)时,模型把这段
 * 附件说明误当成"用户要我检查附件",回了"你的消息里说'请检查这些附件',但我
 * 没收到"。因此开头必须显式声明「这是系统规范、不是用户消息」,禁止当作用户
 * 请求或加以引用/臆测。删改这句 guard 会让该误读复发。
 */
export function buildHookPromptNote(im: string | undefined): string {
  const platform = im === 'telegram' ? 'Telegram' : im === 'x' ? 'X' : 'Slack';
  const attachmentNote =
    '[渠道说明] 以下为系统每轮自动追加的投递与格式规范,不是用户发来的消息;' +
    '回复时不要把它当作用户的请求,也不要引用、复述或据此臆测用户意图。' +
    `本会话来自 ${platform}。要把文件发给用户:在最终回复文本里写 ` +
    '`[文件名](xdt-file:///绝对路径)`;图片直接引用其地址 ' +
    '`![说明](cindy-media://… 或 xdt-image://…)`,无需复制文件。' +
    `系统会在回复结束后自动把它们作为 ${platform} 附件发回,无需调用任何工具;` +
    'xdt-file 文件必须位于当前工作目录内;无法读取、超限或目录外的附件不会发送,' +
    '最终回复会明确显示附件发送不完整。' +
    '不要用 cindy_feishu_bot 发送,除非用户明确要求发到飞书。';
  if (im === 'x') {
    return (
      `${attachmentNote}\n` +
      '[X 回复格式] 最终回复会被转换为纯文本、以单条公开回帖发布在 X 上。' +
      // 这里陈述的是**机制**(session-runner 的 turnTextsFor 对 X 取
      // observer.finalSegment() 当公开正文), 不是对模型的行为要求。先前写成
      // "不要写过程叙述"是纯软约束, 模型不听就穿透到公开时间线(2026-08-01
      // 实踩); 告知机制则顺应它边做边说的天性, 只要求把结论收进最后一条。
      // 改这段话时同步 turnTextsFor 的判据。
      '**只有你的最后一条消息会被发出**: 之前的过程叙述(「我先看看…」)、' +
      '中间说明都不会出现在 X 上, 可以照常写。但最终结论必须完整地放进最后' +
      '一条消息 —— 它会被单独取出发布, 前面的内容不会跟着走, 所以不要把结论' +
      '拆在多条消息里, 也不要在最后一条里只写「好了」这类收尾语。' +
      // X 正文不限制内容篇幅,只约束实际呈现格式。附件引用仍需保留
      // 上述约定的 Markdown-like 语法,收集器会在发布前把它们转成附件。
      '正文直接使用纯文本作答,不要使用 Markdown 标题、列表标记、表格、强调、' +
      '代码围栏或 Markdown 链接语法;需要分段或枚举时使用普通文本。' +
      '上述附件引用除外。不要解释或复述这些格式要求。'
    );
  }
  if (im !== 'telegram') return attachmentNote;
  return (
    `${attachmentNote}\n` +
    '[Telegram 回复格式] 最终回复使用 GitHub Flavored Markdown 的常用结构' +
    '(短段落、标题、列表、引用、链接、表格和 fenced code block)。' +
    '不要输出原始 HTML 或 Telegram 专用标签;工具调用和思考进度由系统单独呈现,' +
    '不要在最终正文中复述过程。'
  );
}

/** Slack compatibility export for existing tests and downstream consumers. */
export const SLACK_HOOK_PROMPT_NOTE = buildHookPromptNote('slack');

/** Extension-derived MIME keeps Telegram on its native media send methods. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

export function xdtFileUrlToAbsPath(url: string): string {
  if (!url.startsWith('xdt-file://')) {
    throw new Error('not an xdt-file URL');
  }
  const raw = url.slice('xdt-file://'.length);
  const decoded = decodeURIComponent(raw);
  // 约定写法 xdt-file:///<绝对路径>:Unix 下剥掉协议后的首个 `/` 就是根;
  // Windows 盘符路径剥完协议剩 `/C:\...`(或 /C:/...),多余的前导 `/` 会让
  // allowedFileRoots 比对必失败 → 附件静默丢失(2026-07-16 实踩,规则 15),
  // 这里剥掉。hook 会把该路径用于自动读盘，因而比只做文案重写的
  // @cindy/im/xdtRefs.ts 多一道“必须是绝对路径”的安全约束。
  const absPath = decoded.replace(/^\/+([A-Za-z]:[\\/])/, '$1');
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(absPath) || /^\\\\[^\\]/.test(absPath);
  if (absPath.includes('\0') || (!path.isAbsolute(absPath) && !isWindowsAbsolute)) {
    throw new Error('xdt-file URL must contain an absolute path');
  }
  return absPath;
}

export function guessMime(absPath: string): string {
  return MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
}

/** target 是否落在 base 目录内(含相等)。Windows 大小写不敏感(规则 15)。 */
function isPathWithin(base: string, target: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const rel = path.relative(norm(base), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface OutboundDeps {
  /** xdt-image:// URL -> absPath(生产: imageCacheStore.resolveSafe; 失败抛错)。 */
  resolveImageUrl: (url: string) => { absPath: string };
  /** xdt-file:// 允许读取的根目录; 未提供时 fail-closed, 不读取任何本地文件。 */
  allowedFileRoots?: string[];
  /**
   * 扫描出站引用的文本范围; 省略 = 就用 finalText。
   *
   * 给"正文只取整轮一部分"的渠道用(目前是 X: 一次 mention 只有一条公开回帖的
   * 名额, 正文只取最后一条助手消息)。**正文范围与引用范围必须分开**: agent 常
   * 在中间那条消息里贴图/贴文件, 最后一条只写结论, 两者绑在一起的话那些附件
   * 会静默丢失(PR #1272 review 指出)。
   *
   * 正文变换仍然只作用于 finalText —— 这里扩大的只是"哪些引用要被收集成附件"。
   */
  refScanText?: string;
  /** realpath 校验(生产: fs.promises.realpath; 测试注入)。 */
  realpath?: (absPath: string) => Promise<string>;
  /** 读文件字节(生产: fs.promises.readFile)。 */
  readFile?: (absPath: string) => Promise<Buffer>;
  log: { warn(msg: string): void };
}

export interface OutboundResult {
  /** 引用已剥离/替换后的正文。 */
  text: string;
  attachments: TaskAttachment[];
  /** 因限额 / 读盘失败被跳过的数量(调用方记日志用)。 */
  skipped: number;
}

/** 文本里是否存在任何托管媒体出站引用(快速前置判断, 避免无谓的收集开销)。 */
export function hasOutboundRefs(text: string): boolean {
  // 双协议:老 xdt-image + 媒体总仓 cindy-media(XDT_IMAGE_REGEX 同口径)——
  // 漏了 cindy-media 会让只含总仓图的回帖跳过附件收集,图静默丢失。
  return (
    text.includes('xdt-image://') || text.includes('cindy-media://') || text.includes('xdt-file://')
  );
}

/**
 * 收集出站附件并变换正文。收集失败(单个文件读不到/超限)只跳过该项,
 * 绝不抛错 —— 附件是回帖的增强, 不能因它失败拖垮 turn.end。
 */
export async function collectOutboundAttachments(
  finalText: string,
  extraImageAbsPaths: string[],
  deps: OutboundDeps,
): Promise<OutboundResult> {
  const readFile = deps.readFile ?? ((p: string) => fsp.readFile(p));
  const realpath = deps.realpath ?? ((p: string) => fsp.realpath(p));
  const attachments: TaskAttachment[] = [];
  const sentImageAbsPaths = new Set<string>();
  const sentFileAbsPaths = new Set<string>();
  const imageAbsPathByUrl = new Map<string, string>();
  const fileAbsPathByUrl = new Map<string, string | null>();
  let totalBytes = 0;
  let skipped = 0;

  const isAllowedFilePath = async (absPath: string): Promise<boolean> => {
    const roots =
      deps.allowedFileRoots?.map((root) => root.trim()).filter((root) => root.length > 0) ?? [];
    if (roots.length === 0) {
      deps.log.warn(`outbound file attachment skipped without allowed roots (${absPath})`);
      return false;
    }

    const targetAbs = path.resolve(absPath);
    for (const root of roots) {
      const rootAbs = path.resolve(root);
      if (!isPathWithin(rootAbs, targetAbs)) continue;
      try {
        const [rootReal, targetReal] = await Promise.all([realpath(rootAbs), realpath(targetAbs)]);
        if (isPathWithin(rootReal, targetReal)) return true;
      } catch (err) {
        deps.log.warn(
          `outbound file attachment path check failed (${absPath}): ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }

    deps.log.warn(`outbound file attachment skipped outside allowed roots (${absPath})`);
    return false;
  };

  const push = async (
    absPath: string,
    maxBytes: number,
    mimeOverride?: string,
  ): Promise<boolean> => {
    if (attachments.length >= MAX_OUT_ATTACHMENTS) {
      skipped += 1;
      return false;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absPath);
    } catch (err) {
      skipped += 1;
      deps.log.warn(
        `outbound attachment read failed (${absPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    if (
      bytes.length === 0 ||
      bytes.length > maxBytes ||
      totalBytes + bytes.length > MAX_OUT_TOTAL_BYTES
    ) {
      skipped += 1;
      deps.log.warn(`outbound attachment skipped by size (${absPath}: ${bytes.length} bytes)`);
      return false;
    }
    totalBytes += bytes.length;
    attachments.push({
      name: path.basename(absPath),
      mimeType: mimeOverride ?? guessMime(absPath),
      dataBase64: bytes.toString('base64'),
    });
    return true;
  };

  // 引用扫描范围可以宽于正文(见 deps.refScanText)。下面两轮扫描一律用它,
  // 第 3 步的正文变换一律用 finalText —— 两者只在 X 这类渠道上不相等。
  const refScanText = deps.refScanText ?? finalText;

  // 1. 图片: 文本引用 + tool_result 旁路, 按 absPath 去重(模型常重复引用)
  const imageAbsPaths: string[] = [];
  const seenImage = new Set<string>();
  for (const m of refScanText.matchAll(XDT_IMAGE_REGEX)) {
    try {
      const { absPath } = deps.resolveImageUrl(m[2]);
      imageAbsPathByUrl.set(m[2], absPath);
      if (!seenImage.has(absPath)) {
        seenImage.add(absPath);
        imageAbsPaths.push(absPath);
      }
    } catch (err) {
      skipped += 1;
      deps.log.warn(
        `resolve xdt-image failed (${m[2]}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const absPath of extraImageAbsPaths) {
    if (!seenImage.has(absPath)) {
      seenImage.add(absPath);
      imageAbsPaths.push(absPath);
    }
  }
  for (const absPath of imageAbsPaths) {
    if (await push(absPath, MAX_OUT_IMAGE_BYTES)) sentImageAbsPaths.add(absPath);
  }

  // 2. 文件引用(去重同上)
  const seenFile = new Set<string>();
  for (const m of refScanText.matchAll(XDT_FILE_REGEX)) {
    const url = m[2];
    if (fileAbsPathByUrl.has(url)) continue;
    let absPath: string;
    try {
      absPath = xdtFileUrlToAbsPath(url);
      fileAbsPathByUrl.set(url, absPath);
    } catch {
      fileAbsPathByUrl.set(url, null);
      skipped += 1;
      deps.log.warn('outbound file attachment skipped because xdt-file URL was invalid');
      continue;
    }
    if (seenFile.has(absPath)) continue;
    seenFile.add(absPath);
    if (!(await isAllowedFilePath(absPath))) {
      skipped += 1;
      continue;
    }
    if (await push(absPath, MAX_OUT_FILE_BYTES)) sentFileAbsPaths.add(absPath);
  }

  // 3. 正文变换: 只有确实收集成功的引用才声称已发送。失败项保留可读标签，
  // 并在末尾附加显式警告，避免“正文剥掉了、附件也没到”的静默丢失。
  const transformed = finalText
    .replace(XDT_IMAGE_REGEX, (_m, alt: string, url: string) => {
      const absPath = imageAbsPathByUrl.get(url);
      if (absPath !== undefined && sentImageAbsPaths.has(absPath)) {
        return alt ? `🖼️ _${alt}(已作为附件发送)_` : '';
      }
      return alt ? `🖼️ _${alt}_` : '';
    })
    .replace(XDT_FILE_REGEX, (_m, label: string, url: string) => {
      const absPath = fileAbsPathByUrl.get(url);
      return absPath !== null && absPath !== undefined && sentFileAbsPaths.has(absPath)
        ? ''
        : label;
    });
  const warning =
    skipped > 0
      ? `⚠️ Attachment delivery incomplete: ${skipped} item${skipped === 1 ? '' : 's'} could not be sent.`
      : '';
  const text = warning
    ? `${transformed.trimEnd()}${transformed.trim().length > 0 ? '\n\n' : ''}${warning}`
    : transformed;

  return { text, attachments, skipped };
}
