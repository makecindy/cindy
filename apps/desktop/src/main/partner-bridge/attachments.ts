/**
 * partner-bridge/attachments.ts
 * ---------------------------------------------------------------------------
 * 从终稿正文里解析托管媒体引用(xdt-image / cindy-media / xdt-file),校验路径
 * 在该轮允许的根目录内,收集成"路径 + 名称 + 字节数"的附件清单,并把正文里的
 * 引用剥离成一句人类可读的提示。
 *
 * 与 hook-control/outbound.ts 的分工:那边要把字节编码进 IM 协议帧(给远端
 * 平台上传),这里只回本机路径 —— 调用方与本机同侧,直接读路径即可,不做
 * base64 搬运。路径校验同样是 fail-closed:没有允许根就不收任何 xdt-file。
 *
 * 纯逻辑 + 注入 IO(realpath / stat / resolveImageUrl),单测不碰真盘。
 */

import path from 'node:path';

import { collectXdtFileRefs, collectXdtImageRefs, transformXdtRefs } from '@cindy/im';

// 严格版 xdt-file URL → 绝对路径(非法编码 / 相对路径 / null byte 一律拒绝),
// 与 hook 出站用同一个实现,不另抄一份。
import { xdtFileUrlToAbsPath } from '../hook-control/outbound.js';

import type { PartnerTaskAttachment } from './types.js';

/** 单任务附件上限(超出只跳过并记日志,不失败)。 */
const MAX_ATTACHMENTS = 16;

export interface PartnerAttachmentDeps {
  /** xdt-image:// 与 cindy-media:// URL → 本机绝对路径;解析不出返回 null。 */
  resolveImageUrl(url: string): string | null;
  realpath(absPath: string): Promise<string>;
  statSize(absPath: string): Promise<number | null>;
  /** 正文里出现引用时是否要扫描/剥离;默认 true。 */
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

function isWithin(rootAbs: string, targetAbs: string): boolean {
  const rel = path.relative(rootAbs, targetAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 收集附件并变换正文。单个引用解析/校验失败只跳过该项并记日志 —— 附件是本轮
 * 结果的增强,不能因为它失败把整单判失败。
 */
export async function collectPartnerAttachments(
  text: string,
  allowedFileRoots: readonly string[],
  deps: PartnerAttachmentDeps,
): Promise<{ text: string; attachments: PartnerTaskAttachment[] }> {
  const attachments: PartnerTaskAttachment[] = [];
  const seen = new Set<string>();
  /** 真正进入结果清单的引用;未命中的引用不能对调用方声称"已提供"。 */
  const providedImageUrls = new Set<string>();
  const providedFileUrls = new Set<string>();

  const imageRefs = collectXdtImageRefs(text);
  const fileRefs = collectXdtFileRefs(text);

  for (const ref of imageRefs) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    const absPath = deps.resolveImageUrl(ref.url);
    if (!absPath) {
      deps.log.warn('partner attachment image unresolved', { url: ref.url });
      continue;
    }
    const bytes = await safeSize(absPath, deps);
    if (bytes === null) continue;
    pushAttachment(attachments, seen, { absPath, bytes, kind: 'image' });
    providedImageUrls.add(ref.url);
  }

  for (const ref of fileRefs) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    // url 未解码,交给共享的严格转换(xdt-file 的 URL → 绝对路径是 fail-closed)。
    let absPath: string;
    try {
      absPath = path.resolve(xdtFileUrlToAbsPath(ref.url));
    } catch (err) {
      deps.log.warn('partner attachment file ref rejected', {
        url: ref.url,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const allowed = await isAllowedFile(absPath, allowedFileRoots, deps);
    if (!allowed) {
      deps.log.warn('partner attachment file skipped outside allowed roots', { absPath });
      continue;
    }
    const bytes = await safeSize(absPath, deps);
    if (bytes === null) continue;
    pushAttachment(attachments, seen, { absPath, bytes, kind: 'file' });
    providedFileUrls.add(ref.url);
  }

  const transformed = transformXdtRefs(text, {
    image: (ref) =>
      providedImageUrls.has(ref.url) ? '（图片已作为附件提供）' : '（附图未能提供）',
    file: (ref) => (providedFileUrls.has(ref.url) ? '（已作为附件提供）' : '（附件未能提供）'),
  });
  return { text: transformed, attachments };
}

function pushAttachment(
  out: PartnerTaskAttachment[],
  seen: Set<string>,
  item: { absPath: string; bytes: number; kind: 'image' | 'file' },
): void {
  if (seen.has(item.absPath)) return;
  seen.add(item.absPath);
  out.push({
    name: path.basename(item.absPath),
    absPath: item.absPath,
    bytes: item.bytes,
    kind: item.kind,
  });
}

async function safeSize(
  absPath: string,
  deps: PartnerAttachmentDeps,
): Promise<number | null> {
  try {
    const size = await deps.statSize(absPath);
    if (size === null) {
      deps.log.warn('partner attachment missing on disk', { absPath });
      return null;
    }
    return size;
  } catch (err) {
    deps.log.warn('partner attachment stat failed', {
      absPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function isAllowedFile(
  absPath: string,
  allowedFileRoots: readonly string[],
  deps: PartnerAttachmentDeps,
): Promise<boolean> {
  const roots = allowedFileRoots.map((root) => root.trim()).filter((root) => root.length > 0);
  if (roots.length === 0) return false;
  for (const root of roots) {
    const rootAbs = path.resolve(root);
    if (!isWithin(rootAbs, absPath)) continue;
    try {
      const [rootReal, targetReal] = await Promise.all([
        deps.realpath(rootAbs),
        deps.realpath(absPath),
      ]);
      if (isWithin(rootReal, targetReal)) return true;
    } catch (err) {
      deps.log.warn('partner attachment path check failed', {
        absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return false;
}
