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
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  collectXdtFileRefs,
  isMarkdownCodePosition,
  markdownCodeRanges,
  normalizeXdtAbsPath,
  transformXdtRefs,
} from '@cindy/im';

import { resolveSafe as resolveCindyMediaUrl } from '../../cindy-media/blobStore';
import { ingestMedia } from '../../cindy-media/ingest';
import { sniffMediaMime } from '../../cindy-media/sniffMediaMime';
import { resolveSafe as resolveXdtImageUrl } from '../../imageCacheStore';
import { materializeSshRemoteFile } from '../../file-browser/ssh-media';
import { readBoundedFileFollowLinks } from '../../utils/readBoundedFile';

// Destination scanning permits escaped characters and one balanced parenthesis
// level, so a parenthesized Markdown title is captured before the outer `)`.
const LOCAL_MARKDOWN_IMAGE_RE =
  /!\[([^\]\r\n]{0,512})\]\(((?:\\[^\r\n]|[^()\r\n]|\((?:\\[^\r\n]|[^()\r\n])*\)){1,4096})\)/g;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

function localMarkdownImageMatches(text: string): RegExpMatchArray[] {
  const codeRanges = markdownCodeRanges(text);
  return Array.from(text.matchAll(LOCAL_MARKDOWN_IMAGE_RE)).filter(
    (match) => match.index !== undefined && !isMarkdownCodePosition(codeRanges, match.index),
  );
}

interface LocalMarkdownImageDeps {
  realpath(value: string): Promise<string>;
  readBoundedFile(
    value: string,
    maxBytes: number,
    containWithin?: string,
  ): Promise<Uint8Array | null>;
  ingest(params: {
    buffer: Uint8Array;
    mimeType: string;
    sessionId: string;
  }): Promise<{ url: string }>;
  resolveMediaUrl(url: string): { absPath: string };
}

const defaultDeps: LocalMarkdownImageDeps = {
  realpath: (value) => fs.realpath(value),
  readBoundedFile: (value, maxBytes, containWithin) =>
    readBoundedFileFollowLinks(
      value,
      maxBytes,
      containWithin === undefined ? undefined : { containWithin },
    ),
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

function markdownImageDestination(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('<')) {
    const closingBracket = target.indexOf('>');
    // Markdown permits an optional title after an angle-bracket destination:
    // `![alt](</private/file.png> "title")`. Extract only the destination.
    // A malformed missing `>` remains fail-closed for local-path detection.
    target = target.slice(1, closingBracket >= 0 ? closingBracket : target.length).trim();
  } else {
    // A plain destination may be followed by a quoted/parenthesized title:
    // `![alt](/work/out.png "preview")`. Unescaped whitespace is not part of
    // a plain Markdown destination, so only strip a syntactically complete title.
    const titled = target.match(
      /^(\S+)[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))[ \t]*$/,
    );
    if (titled) target = titled[1];
  }
  return target;
}

function markdownLocalTarget(raw: string): string | null {
  const target = markdownImageDestination(raw);
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

export interface MaterializedLocalMarkdownFiles {
  /** 已复制到受控临时目录的文件与对外展示名，供 IM 渠道上传。 */
  files: Array<{ absPath: string; displayName?: string }>;
  /** 发送完成后必须递归清理的受控临时目录。 */
  tempDirs: string[];
  /** 所有内部文件引用均替换为可读标签，避免本机路径泄漏。 */
  text: string;
}

/**
 * 将最终 Markdown 的 xdt-file 引用收敛为可上传路径。
 *
 * 文件来源是模型输出，必须同时通过绝对路径、realpath 与 workingDir 包含校验；
 * 未通过的引用不会发送，但仍会从正文中移除内部 URL，只留下可读标签。
 */
export async function materializeLocalMarkdownFiles(
  params: {
    text: string;
    workingDir: string;
    maxFiles?: number;
    maxFileBytes?: number;
    existingAbsPaths?: string[];
    remoteHostId?: string | null;
  },
): Promise<MaterializedLocalMarkdownFiles> {
  const refs = collectXdtFileRefs(params.text);
  if (refs.length === 0) return { files: [], tempDirs: [], text: params.text };

  const maxFiles = Math.max(0, params.maxFiles ?? 8);
  const maxFileBytes = params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const existing = new Set<string>();
  for (const absPath of params.existingAbsPaths ?? []) {
    try {
      existing.add(pathKey(await fs.realpath(absPath)));
    } catch {
      existing.add(pathKey(absPath));
    }
  }

  let workingDirReal: string | null = null;
  if (!params.remoteHostId) {
    try {
      workingDirReal = await fs.realpath(params.workingDir);
    } catch {
      // Fail closed: without a canonical root, no model-authored local file may be sent.
    }
  }

  const accepted = new Set<string>();
  const files: Array<{ absPath: string; displayName?: string }> = [];
  let tempDir: string | null = null;
  if (workingDirReal || params.remoteHostId) {
    for (const ref of refs) {
      if (files.length >= maxFiles) break;
      try {
        const candidate = normalizeXdtAbsPath(
          decodeURIComponent(ref.url.slice('xdt-file://'.length)),
        );
        const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\[^\\]/.test(candidate);
        if (candidate.includes('\u0000') || (!path.isAbsolute(candidate) && !isWindowsAbsolute)) continue;
        let sourcePath: string;
        let buffer: Buffer;
        if (params.remoteHostId) {
          const remote = await materializeSshRemoteFile(
            { remoteHostId: params.remoteHostId, workdir: params.workingDir },
            candidate,
            maxFileBytes,
          );
          if (!remote.ok) continue;
          sourcePath = remote.cachePath;
          buffer = await fs.readFile(sourcePath);
          if (buffer.byteLength !== remote.size || buffer.byteLength > maxFileBytes) continue;
        } else {
          const targetReal = await fs.realpath(candidate);
          if (!workingDirReal || !isPathInside(workingDirReal, targetReal)) continue;
          const securelyRead = await readBoundedFileFollowLinks(targetReal, maxFileBytes, {
            containWithin: workingDirReal,
          });
          if (!securelyRead || securelyRead.byteLength === 0) continue;
          sourcePath = targetReal;
          buffer = securelyRead;
        }
        const sourcePathKey = pathKey(sourcePath);
        const key = `${params.remoteHostId ?? 'local'}:${sourcePathKey}`;
        if (accepted.has(key) || existing.has(sourcePathKey)) continue;

        tempDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-im-file-'));
        const extension = path.extname(candidate).slice(0, 32);
        const stagedPath = path.join(tempDir, `${randomUUID()}${extension}`);
        await fs.writeFile(stagedPath, buffer, { flag: 'wx', mode: 0o600 });
        accepted.add(key);
        files.push({
          absPath: stagedPath,
          displayName: ref.alt.trim() || `附件${extension}`,
        });
      } catch {
        // A bad or missing file is omitted; the readable label remains below.
      }
    }
  }

  return {
    files,
    tempDirs: tempDir ? [tempDir] : [],
    text: transformXdtRefs(params.text, {
      file: ({ alt }) => alt.trim() || '附件',
    }),
  };
}

function isSensitiveLocalMarkdownImageTarget(rawTarget: string): boolean {
  const target = markdownImageDestination(rawTarget);
  return (
    target.startsWith('file://') ||
    target.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(target) ||
    /^\\\\[^\\]/.test(target)
  );
}

/** Remove unresolved host-local image targets before a plain-text IM fallback. */
export function sanitizeLocalMarkdownImageRefs(text: string): string {
  const matches = localMarkdownImageMatches(text);
  let sanitized = text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!isSensitiveLocalMarkdownImageTarget(match[2])) continue;
    const start = match.index;
    if (start === undefined) continue;
    const replacement = match[1].trim() || '图片';
    sanitized = `${sanitized.slice(0, start)}${replacement}${sanitized.slice(start + match[0].length)}`;
  }
  return sanitized;
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
    /** SSH host when local-looking paths belong to a remote desktop session. */
    remoteHostId?: string | null;
  },
  deps: LocalMarkdownImageDeps = defaultDeps,
): Promise<MaterializedLocalMarkdownImages> {
  const matches = localMarkdownImageMatches(params.text);
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
    const destination = markdownImageDestination(rawTarget);
    const managed = isManagedImageTarget(destination);
    const localTarget = managed ? null : markdownLocalTarget(rawTarget);
    if (!managed && !localTarget) continue;

    try {
      let sourceReal: string;
      let dedupeKey: string;
      let containWithin: string | undefined;
      let expectedSize: number | undefined;
      if (managed) {
        sourceReal = await deps.realpath(deps.resolveMediaUrl(destination).absPath);
        dedupeKey = pathKey(sourceReal);
      } else if (params.remoteHostId) {
        const remote = await materializeSshRemoteFile(
          { remoteHostId: params.remoteHostId, workdir: params.workingDir },
          localTarget as string,
          maxImageBytes,
        );
        if (!remote.ok) continue;
        sourceReal = remote.cachePath;
        dedupeKey = `ssh:${params.remoteHostId}:${remote.relPath}`;
        expectedSize = remote.size;
      } else {
        sourceReal = await deps.realpath(localTarget as string);
        if (workingDirReal === undefined) {
          try {
            workingDirReal = await deps.realpath(params.workingDir);
          } catch {
            workingDirReal = null;
          }
        }
        if (!workingDirReal || !isPathInside(workingDirReal, sourceReal)) continue;
        dedupeKey = pathKey(sourceReal);
        containWithin = workingDirReal;
      }
      const existing = materializedByRealPath.get(dedupeKey);
      if (existing) {
        acceptedMatchIndexes.add(index);
        continue;
      }
      if (materializedByRealPath.size >= maxImages) continue;
      // This helper verifies the opened descriptor still resolves inside the
      // trusted root before reading, closing both final- and parent-symlink races.
      const buffer = await deps.readBoundedFile(sourceReal, maxImageBytes, containWithin);
      if (expectedSize !== undefined && buffer?.byteLength !== expectedSize) continue;
      if (!buffer || buffer.byteLength === 0 || buffer.byteLength > maxImageBytes) continue;
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
