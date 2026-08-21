/**
 * Agent 最终 Markdown 图片的主进程安全物化。
 *
 * 本地图片只接受 canonical workingDir 内的普通图片文件；托管图片只通过
 * cindy-media / xdt-image 的安全解析器读取。成功项同时产出两种文本：
 * - managedText: 图片目标改写为托管 URL，供持久化聊天消息跨端展示；
 * - textWithoutImages: 图片语法替换为 alt，供 IM 文本与附件分离发送。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveSafe as resolveCindyMediaUrl } from './blobStore';
import { ingestMedia } from './ingest';
import { sniffMediaMime } from './sniffMediaMime';
import { resolveSafe as resolveXdtImageUrl } from '../imageCacheStore';

const MARKDOWN_IMAGE_RE = /!\[([^\]\r\n]{0,512})\]\(([^)\r\n]{1,4096})\)/g;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface MarkdownImageMaterializeDeps {
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

const defaultDeps: MarkdownImageMaterializeDeps = {
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

interface MaterializedImage {
  managedUrl?: string;
}

export interface MaterializedMarkdownImages {
  /** 新增且未被 existingAbsPaths 去重的媒体仓绝对路径。 */
  absPaths: string[];
  /** 成功物化的本地图片目标改写为托管 URL。 */
  managedText: string;
  /** 成功物化的图片语法替换为 alt。 */
  textWithoutImages: string;
}

export async function materializeMarkdownImages(
  params: {
    text: string;
    workingDir: string;
    sessionId: string;
    maxImages?: number;
    maxImageBytes?: number;
    existingAbsPaths?: string[];
    allowLocalPaths?: boolean;
  },
  deps: MarkdownImageMaterializeDeps = defaultDeps,
): Promise<MaterializedMarkdownImages> {
  const matches = Array.from(params.text.matchAll(MARKDOWN_IMAGE_RE));
  if (matches.length === 0) {
    return {
      absPaths: [],
      managedText: params.text,
      textWithoutImages: params.text,
    };
  }

  const maxImages = Math.max(0, params.maxImages ?? DEFAULT_MAX_IMAGES);
  const maxImageBytes = params.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const materializedByRealPath = new Map<string, MaterializedImage>();
  for (const existingPath of params.existingAbsPaths ?? []) {
    let existingKey = existingPath;
    try {
      existingKey = await deps.realpath(existingPath);
    } catch {
      // 已回收文件仍占数量名额，避免同一轮继续追加更多附件。
    }
    materializedByRealPath.set(pathKey(existingKey), {
      managedUrl: undefined,
    });
  }

  const accepted = new Map<number, { alt: string; managedUrl?: string }>();
  const absPaths: string[] = [];
  let workingDirReal: string | null | undefined;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rawTarget = match[2].trim();
    const managed = isManagedImageTarget(rawTarget);
    const localTarget = managed ? null : markdownLocalTarget(rawTarget);
    if (!managed && !localTarget) continue;
    if (!managed && params.allowLocalPaths === false) continue;

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
        accepted.set(index, {
          alt: match[1].trim() || '图片',
          managedUrl: managed ? rawTarget : existing.managedUrl,
        });
        continue;
      }
      if (materializedByRealPath.size >= maxImages) continue;

      const stat = await deps.stat(sourceReal);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxImageBytes) continue;
      const buffer = await deps.readFile(sourceReal);
      if (buffer.byteLength !== stat.size || buffer.byteLength > maxImageBytes) continue;
      const mimeType = sniffMediaMime(buffer);
      if (!mimeType?.startsWith('image/')) continue;

      let managedUrl = rawTarget;
      let mediaAbsPath = sourceReal;
      if (!managed) {
        managedUrl = (
          await deps.ingest({
            buffer,
            mimeType,
            sessionId: params.sessionId,
          })
        ).url;
        mediaAbsPath = deps.resolveMediaUrl(managedUrl).absPath;
      }
      materializedByRealPath.set(dedupeKey, {
        managedUrl,
      });
      absPaths.push(mediaAbsPath);
      accepted.set(index, {
        alt: match[1].trim() || '图片',
        managedUrl,
      });
    } catch {
      // 单张失败保留原 Markdown，继续处理同一回复中的其它图片。
    }
  }

  let managedText = params.text;
  let textWithoutImages = params.text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const replacement = accepted.get(index);
    if (!replacement) continue;
    const match = matches[index];
    const start = match.index;
    if (start === undefined) continue;
    textWithoutImages =
      `${textWithoutImages.slice(0, start)}${replacement.alt}` +
      textWithoutImages.slice(start + match[0].length);
    if (replacement.managedUrl) {
      const managedMarkdown = `![${match[1]}](${replacement.managedUrl})`;
      managedText =
        `${managedText.slice(0, start)}${managedMarkdown}` +
        managedText.slice(start + match[0].length);
    }
  }

  return { absPaths, managedText, textWithoutImages };
}
