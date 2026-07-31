/**
 * 将 Agent 最终 Markdown 中引用的图片安全转成 IM 可上传的绝对路径。
 *
 * Agent 可能直接在 session workingDir 内生成图片，再输出
 * `![alt](C:\\...\\image.png)`。这类路径不是 tool_result 中的托管 URL，
 * turnRunner 原本不会把它交给文本型 IM 渠道上传。这里仅接受真实路径仍位于
 * 当前 workingDir 内的普通图片文件，并在发送前复制进内容寻址媒体仓，避免
 * 任意路径读取、符号链接逃逸和校验后换文件。已经是 cindy-media / xdt-image
 * 的引用则通过各自的安全解析器取回仓内路径；两类都重新核验文件与图片魔数。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveSafe as resolveCindyMediaUrl } from '../../cindy-media/blobStore';
import { ingestMedia } from '../../cindy-media/ingest';
import { sniffMediaMime } from '../../cindy-media/sniffMediaMime';
import { resolveSafe as resolveXdtImageUrl } from '../../imageCacheStore';

const LOCAL_MARKDOWN_IMAGE_RE = /!\[([^\]\r\n]{0,512})\]\(([^)\r\n]{1,4096})\)/g;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface LocalMarkdownImageDeps {
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(value: string): Promise<Uint8Array>;
  ingest(params: {
    buffer: Uint8Array;
    mimeType: string;
    sessionId: string;
  }): Promise<{ url: string }>;
  resolveMediaUrl(url: string): { absPath: string };
}

const defaultDeps: LocalMarkdownImageDeps = {
  realpath: (value) => fs.realpath(value),
  stat: (value) => fs.stat(value),
  readFile: (value) => fs.readFile(value),
  ingest: async ({ buffer, mimeType, sessionId }) =>
    ingestMedia({
      buffer,
      mimeType,
      refs: [
        {
          refKind: 'session-attachment',
          refId: sessionId,
          originSessionId: sessionId,
          originKind: 'tool',
        },
      ],
    }),
  resolveMediaUrl: (url) =>
    url.startsWith('cindy-media://') ? resolveCindyMediaUrl(url) : resolveXdtImageUrl(url),
};

function isPathInside(parentAbs: string, childAbs: string): boolean {
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(fold(path.resolve(parentAbs)), fold(path.resolve(childAbs)));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function markdownLocalTarget(raw: string): string | null {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }
  if (!target || target.includes('\0') || !path.isAbsolute(target)) return null;
  return target;
}

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
  const matches = Array.from(params.text.matchAll(LOCAL_MARKDOWN_IMAGE_RE));
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
  const acceptedMatchIndexes = new Set<number>();
  const absPaths: string[] = [];
  let workingDirReal: string | null | undefined;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rawTarget = match[2].trim();
    const managed = isManagedImageTarget(rawTarget);
    const localTarget = managed ? null : markdownLocalTarget(rawTarget);
    if (!managed && !localTarget) continue;

    try {
      const resolvedSource = managed
        ? deps.resolveMediaUrl(rawTarget).absPath
        : (localTarget as string);
      const sourceReal = await deps.realpath(resolvedSource);
      if (!managed) {
        if (workingDirReal === undefined) {
          try {
            workingDirReal = await deps.realpath(params.workingDir);
          } catch {
            workingDirReal = null;
          }
        }
        if (!workingDirReal || !isPathInside(workingDirReal, sourceReal)) continue;
      }
      const dedupeKey = pathKey(sourceReal);
      const existing = materializedByRealPath.get(dedupeKey);
      if (existing) {
        acceptedMatchIndexes.add(index);
        continue;
      }
      if (materializedByRealPath.size >= maxImages) continue;

      const stat = await deps.stat(sourceReal);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxImageBytes) continue;
      const buffer = await deps.readFile(sourceReal);
      if (buffer.byteLength !== stat.size || buffer.byteLength > maxImageBytes) continue;
      const mimeType = sniffMediaMime(buffer);
      if (!mimeType?.startsWith('image/')) continue;

      const mediaAbsPath = managed
        ? sourceReal
        : deps.resolveMediaUrl(
            (
              await deps.ingest({
                buffer,
                mimeType,
                sessionId: params.sessionId,
              })
            ).url,
          ).absPath;
      materializedByRealPath.set(dedupeKey, mediaAbsPath);
      absPaths.push(mediaAbsPath);
      acceptedMatchIndexes.add(index);
    } catch {
      // 单张失败保留原 Markdown，继续处理同一回复中的其它图片。
    }
  }

  let text = params.text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (!acceptedMatchIndexes.has(index)) continue;
    const match = matches[index];
    const start = match.index;
    if (start === undefined) continue;
    const replacement = match[1].trim() || '图片';
    text = `${text.slice(0, start)}${replacement}${text.slice(start + match[0].length)}`;
  }

  return { absPaths, text };
}
