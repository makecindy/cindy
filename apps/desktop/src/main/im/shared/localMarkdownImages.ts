/** Convert task Markdown images through the common Host importer, then collect
 * managed paths for the existing IM uploader. Unavailable images keep a caption
 * and an explicit delivery notice, never a machine-local URL.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveSafe as resolveCindyMediaUrl } from '../../cindy-media/blobStore';
import { sniffMediaMime } from '../../cindy-media/sniffMediaMime';
import { resolveSafe as resolveXdtImageUrl } from '../../imageCacheStore';
import { materializeTaskImageText } from '../../cindy-media/taskImageDelivery';
import {
  localTaskImagePath,
  taskImageReferences,
  rewriteTaskImageReferences,
} from '../../cindy-media/taskImageMarkdown';

const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface LocalMarkdownImageDeps {
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(value: string): Promise<Uint8Array>;
  materialize(sessionId: string, text: string): Promise<string>;
  resolveMediaUrl(url: string): { absPath: string };
}

const defaultDeps: LocalMarkdownImageDeps = {
  realpath: (value) => fs.realpath(value),
  stat: (value) => fs.stat(value),
  readFile: (value) => fs.readFile(value),
  materialize: materializeTaskImageText,
  resolveMediaUrl: (url) =>
    url.startsWith('cindy-media://') ? resolveCindyMediaUrl(url) : resolveXdtImageUrl(url),
};

function isManagedImageTarget(value: string): boolean {
  return value.startsWith('cindy-media://') || value.startsWith('xdt-image://');
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface MaterializedLocalMarkdownImages {
  /** 已成功物化的媒体仓绝对路径，供 IM 渠道上传。 */
  absPaths: string[];
  /** 成功物化的图片语法替换为 alt，避免把本机路径发到聊天。 */
  text: string;
}

export async function materializeLocalMarkdownImages(
  params: {
    text: string;
    workingDir: string;
    sessionId: string;
    maxImages?: number;
    maxImageBytes?: number;
    /** 已由 tool_result side-channel 收集的图片；参与总数限制与去重。 */
    existingAbsPaths?: string[];
  },
  deps: LocalMarkdownImageDeps = defaultDeps,
): Promise<MaterializedLocalMarkdownImages> {
  const sourceText = await deps.materialize(params.sessionId, params.text);
  const matches = taskImageReferences(sourceText);
  if (matches.length === 0) return { absPaths: [], text: params.text };

  const maxImages = Math.max(0, params.maxImages ?? DEFAULT_MAX_IMAGES);
  const maxImageBytes = params.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const materializedByRealPath = new Map<string, string>();
  for (const existingPath of params.existingAbsPaths ?? []) {
    // 键必须与下面的查询同口径(pathKey(sourceReal),即 realpath 之后)。按原样入表
    // 会让含符号链接的入参查不中,同一张受管图片被判成新图重复追加。
    //
    // 入参不保证已规范化:它们来自 turnRunner 的 handleToolResultFullEvent,经
    // blobStore / imageCacheStore 的 resolveSafe 用 path.join / path.resolve 拼出
    // `<userData>/cindy-media/blobs/…` 与 `<userData>/cc-agent/images/…`,两处都不做
    // realpath。所以只要 userData 路径链上有软链或 junction(home 被重定位、Windows
    // AppData 重定向、macOS home 挂在别的卷),生产上就会命中。
    let existingKey = existingPath;
    try {
      existingKey = await deps.realpath(existingPath);
    } catch {
      // 文件已被回收:退回原样路径,至少让它继续占一个 maxImages 名额。
    }
    materializedByRealPath.set(pathKey(existingKey), existingPath);
  }
  const replacements = new Map<string, string>();
  const failedUrls = new Set<string>();
  const absPaths: string[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rawTarget = match.url;
    const managed = isManagedImageTarget(rawTarget);
    const local = localTaskImagePath(rawTarget);
    if (!managed && !local) continue;
    replacements.set(rawTarget, rawTarget);
    failedUrls.add(rawTarget);
    // An unresolved local path failed the common import. Never read it here.
    if (local) continue;

    try {
      const sourceReal = await deps.realpath(deps.resolveMediaUrl(rawTarget).absPath);
      const dedupeKey = pathKey(sourceReal);
      const existing = materializedByRealPath.get(dedupeKey);
      if (existing) {
        failedUrls.delete(rawTarget);
        continue;
      }
      if (materializedByRealPath.size >= maxImages) continue;

      const stat = await deps.stat(sourceReal);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxImageBytes) continue;
      const buffer = await deps.readFile(sourceReal);
      if (buffer.byteLength !== stat.size || buffer.byteLength > maxImageBytes) continue;
      const mimeType = sniffMediaMime(buffer);
      if (!mimeType?.startsWith('image/')) continue;

      materializedByRealPath.set(dedupeKey, sourceReal);
      absPaths.push(sourceReal);
      failedUrls.delete(rawTarget);
    } catch {
      // 单张失败不阻止同一回复中的其它图片。
    }
  }

  const body = rewriteTaskImageReferences(sourceText, replacements, 'alt');
  const notice = failedUrls.size > 0 ? `有 ${failedUrls.size} 张图片未能作为附件发送。` : '';
  return { absPaths, text: notice ? `${body.trimEnd()}\n\n${notice}` : body };
}
