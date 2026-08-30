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
  sanitizeBareXdtFileUrls,
  transformXdtRefs,
} from '@cindy/im';

import { resolveSafe as resolveCindyMediaUrl } from '../../cindy-media/blobStore';
import { ingestMedia } from '../../cindy-media/ingest';
import { sniffMediaMime } from '../../cindy-media/sniffMediaMime';
import { resolveSafe as resolveXdtImageUrl } from '../../imageCacheStore';
import { materializeSshRemoteFile } from '../../file-browser/ssh-media';
import { readBoundedFileFollowLinks } from '../../utils/readBoundedFile';

const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_MARKDOWN_IMAGE_LABEL_LENGTH = 512;
const MAX_MARKDOWN_IMAGE_DESTINATION_LENGTH = 4096;
const MAX_COMMONMARK_LINK_DESTINATION_PAREN_DEPTH = 32;

interface LocalMarkdownImageMatch {
  start: number;
  end: number;
  label: string;
  target: string;
}

function isEscapedMarkdownMarker(text: string, markerIndex: number): boolean {
  let backslashes = 0;
  for (let index = markerIndex - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isMarkdownEscapablePunctuation(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function markdownImageLabelEnd(text: string, labelStart: number, limit: number): number {
  let depth = 1;
  for (let cursor = labelStart; cursor < limit; cursor += 1) {
    const char = text[cursor];
    if (char === '\r' || char === '\n') {
      const lineEnd = char === '\r' && text[cursor + 1] === '\n' ? cursor + 2 : cursor + 1;
      let nextContent = lineEnd;
      while (
        nextContent < limit &&
        (text[nextContent] === ' ' || text[nextContent] === '\t')
      ) {
        nextContent += 1;
      }
      if (nextContent >= limit) return -1;
      if (text[nextContent] === '\r' || text[nextContent] === '\n') return -1;
      cursor = lineEnd - 1;
      continue;
    }
    if (char === '\\') {
      cursor += 1;
      continue;
    }
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text[cursor + 1] === '(' ? cursor : -1;
    }
  }
  return -1;
}

function localMarkdownImageMatches(text: string): LocalMarkdownImageMatch[] {
  const codeRanges = markdownCodeRanges(text);
  const matches: LocalMarkdownImageMatch[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('![', cursor);
    if (start === -1) break;
    cursor = start + 2;
    if (isMarkdownCodePosition(codeRanges, start)) continue;
    if (isEscapedMarkdownMarker(text, start)) continue;

    const labelStart = start + 2;
    const labelLimit = Math.min(
      text.length,
      labelStart + MAX_MARKDOWN_IMAGE_LABEL_LENGTH + 1,
    );
    const labelEnd = markdownImageLabelEnd(text, labelStart, labelLimit);
    if (labelEnd === -1) continue;

    const targetStart = labelEnd + 2;
    const targetLimit = Math.min(
      text.length,
      targetStart + MAX_MARKDOWN_IMAGE_DESTINATION_LENGTH + 1,
    );
    let targetEnd = targetStart;
    let depth = 1;
    let insideAngleDestination = text[targetStart] === '<';
    let titleQuote: '"' | "'" | null = null;
    let titleLineBreak = false;
    while (targetEnd < targetLimit) {
      const char = text[targetEnd];
      if (char === '\r' || char === '\n') {
        if (titleLineBreak || insideAngleDestination || depth !== 1) break;
        let next = char === '\r' && text[targetEnd + 1] === '\n' ? targetEnd + 2 : targetEnd + 1;
        while (text[next] === ' ' || text[next] === '\t') next += 1;
        if (text[next] !== '"' && text[next] !== "'" && text[next] !== '(') break;
        titleLineBreak = true;
        targetEnd = next;
        continue;
      }
      if (char === '\\' && isMarkdownEscapablePunctuation(text[targetEnd + 1])) {
        targetEnd += 2;
        continue;
      }
      if (titleQuote) {
        if (char === titleQuote) titleQuote = null;
        targetEnd += 1;
        continue;
      }
      if (insideAngleDestination) {
        if (char === '>') insideAngleDestination = false;
        targetEnd += 1;
        continue;
      }
      if (
        depth === 1 &&
        (char === '"' || char === "'") &&
        (titleLineBreak || text[targetEnd - 1] === ' ' || text[targetEnd - 1] === '\t')
      ) {
        titleQuote = char;
        targetEnd += 1;
        continue;
      }
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      targetEnd += 1;
    }
    if (insideAngleDestination || depth !== 0 || targetEnd === targetStart) continue;

    matches.push({
      start,
      end: targetEnd + 1,
      label: text.slice(start + 2, labelEnd),
      target: text.slice(targetStart, targetEnd),
    });
    cursor = targetEnd + 1;
  }
  return matches;
}

function localMarkdownImageSanitizationMatches(text: string): LocalMarkdownImageMatch[] {
  const codeRanges = markdownCodeRanges(text);
  const matches: LocalMarkdownImageMatch[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('![', cursor);
    if (start === -1) break;
    cursor = start + 2;
    if (isMarkdownCodePosition(codeRanges, start)) continue;

    const labelEnd = markdownImageLabelEnd(text, start + 2, text.length);
    if (labelEnd === -1) {
      // Nothing later on this line can close this candidate without crossing
      // the same scan range. Advance monotonically instead of rescanning a
      // long malformed line once for every literal `![` it contains.
      const lineBreak = text.indexOf('\n', cursor);
      cursor = lineBreak === -1 ? text.length : lineBreak + 1;
      continue;
    }

    const targetStart = labelEnd + 2;
    const lineBreak = text.indexOf('\n', targetStart);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak;
    let targetEnd = targetStart;
    let depth = 1;
    let nestedImageStart = -1;
    let insideAngleDestination = text[targetStart] === '<';
    let titleQuote: '"' | "'" | null = null;
    while (targetEnd < lineEnd) {
      const char = text[targetEnd];
      if (char === '\r') break;
      if (char === '\\' && isMarkdownEscapablePunctuation(text[targetEnd + 1])) {
        targetEnd = Math.min(targetEnd + 2, lineEnd);
        continue;
      }
      if (titleQuote) {
        if (char === titleQuote) titleQuote = null;
        targetEnd += 1;
        continue;
      }
      if (insideAngleDestination) {
        if (char === '>') insideAngleDestination = false;
        targetEnd += 1;
        continue;
      }
      if (
        depth === 1 &&
        (char === '"' || char === "'") &&
        (text[targetEnd - 1] === ' ' || text[targetEnd - 1] === '\t')
      ) {
        titleQuote = char;
        targetEnd += 1;
        continue;
      }
      if (char === '!' && text[targetEnd + 1] === '[') {
        const outerTargetPrefix = text.slice(targetStart, targetEnd);
        if (!isSensitiveLocalMarkdownImageTarget(outerTargetPrefix)) {
          nestedImageStart = targetEnd;
          break;
        }
      }
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      targetEnd += 1;
    }
    if (nestedImageStart >= 0) {
      cursor = nestedImageStart;
      continue;
    }
    if (targetEnd === targetStart) continue;
    const end = depth === 0 ? targetEnd + 1 : targetEnd;
    matches.push({
      start,
      end,
      label: text.slice(start + 2, labelEnd),
      target: text.slice(targetStart, targetEnd),
    });
    cursor = Math.max(cursor, end);
  }
  return matches;
}

function markdownImageLabel(raw: string): string {
  return raw.replace(/\\([\\[\]])/g, '$1').trim() || '图片';
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

function hasUnescapedMarkdownWhitespace(value: string): boolean {
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\' && isMarkdownEscapablePunctuation(value[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (/\s/.test(value[cursor])) return true;
  }
  return false;
}

function hasInvalidAngleDestinationChar(value: string): boolean {
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\' && isMarkdownEscapablePunctuation(value[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (value[cursor] === '<' || value[cursor] === '\n' || value[cursor] === '\r') return true;
  }
  return false;
}

function exceedsPlainDestinationParenDepth(value: string): boolean {
  let depth = 0;
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\' && isMarkdownEscapablePunctuation(value[cursor + 1])) {
      cursor += 1;
      continue;
    }
    if (value[cursor] === '(') {
      depth += 1;
      if (depth > MAX_COMMONMARK_LINK_DESTINATION_PAREN_DEPTH) return true;
    } else if (value[cursor] === ')') {
      depth -= 1;
    }
  }
  return false;
}

function unescapeMarkdownPunctuation(value: string): string {
  let result = '';
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\' && isMarkdownEscapablePunctuation(value[cursor + 1])) {
      cursor += 1;
    }
    result += value[cursor];
  }
  return result;
}

function markdownImageDestination(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('<')) {
    const closingBracket = target.indexOf('>');
    // Markdown permits an optional title after an angle-bracket destination:
    // `![alt](</private/file.png> "title")`. Extract only the destination.
    // A malformed missing `>` remains fail-closed for local-path detection.
    if (closingBracket < 0) return '';
    const destination = target.slice(1, closingBracket);
    if (hasInvalidAngleDestinationChar(destination)) return '';
    const tail = target.slice(closingBracket + 1);
    if (
      tail &&
      !/^[ \t]+$/.test(tail) &&
      !/^(?:[ \t]+|[ \t]*\r?\n[ \t]*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))[ \t]*$/.test(
        tail,
      )
    ) {
      return '';
    }
    target = destination.trim();
  } else {
    // A plain destination may be followed by a quoted/parenthesized title:
    // `![alt](/work/out.png "preview")`. Unescaped whitespace is not part of
    // a plain Markdown destination, so only strip a syntactically complete title.
    const titled = target.match(
      /^(\S+)(?:[ \t]+|[ \t]*\r?\n[ \t]*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))[ \t]*$/,
    );
    if (titled) target = titled[1];
    else if (hasUnescapedMarkdownWhitespace(target)) return '';
  }
  return unescapeMarkdownPunctuation(target);
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

function sanitizeAttachmentName(raw: string): string {
  return Array.from(raw, (char) => {
    const code = char.charCodeAt(0);
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return ' ';
    }
    if (char === '\\' || char === '/') return '_';
    return char;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function attachmentDisplayName(raw: string, extension: string): string {
  const sanitized = sanitizeAttachmentName(raw);
  const safeExtension = sanitizeAttachmentName(extension);
  return Array.from(sanitized || `附件${safeExtension}`)
    .slice(0, 120)
    .join('');
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
  if (refs.length === 0) {
    return { files: [], tempDirs: [], text: sanitizeBareXdtFileUrls(params.text) };
  }

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
          displayName: attachmentDisplayName(ref.alt, extension),
        });
      } catch {
        // A bad or missing file is omitted; the readable label remains below.
      }
    }
  }

  return {
    files,
    tempDirs: tempDir ? [tempDir] : [],
    text: sanitizeBareXdtFileUrls(
      transformXdtRefs(params.text, {
        file: ({ alt }) => attachmentDisplayName(alt, ''),
      }),
    ),
  };
}

function isSensitiveLocalMarkdownImageTarget(rawTarget: string): boolean {
  const trimmedTarget = rawTarget.trim();
  // A malformed angle destination is never eligible for materialization, but
  // its local path still must not cross the IM boundary in plain text.
  const closingAngle = trimmedTarget.startsWith('<') ? trimmedTarget.indexOf('>') : -1;
  const target = trimmedTarget.startsWith('<')
    ? trimmedTarget.slice(1, closingAngle < 0 ? undefined : closingAngle).trim()
    : markdownImageDestination(rawTarget) || trimmedTarget;
  const targetLower = target.toLowerCase();
  return (
    targetLower.startsWith('file://') ||
    target.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(target) ||
    /^\\\\[^\\]/.test(target)
  );
}

/** Remove unresolved host-local image targets before a plain-text IM fallback. */
export function sanitizeLocalMarkdownImageRefs(text: string): string {
  // Escaped image syntax is not materialized, but local paths still must not
  // cross the IM boundary in a plain-text fallback.
  // Sanitization deliberately has no materialization length cap: oversized
  // model-authored syntax is not eligible for upload, but its entire local
  // destination still has to be removed before crossing the IM boundary.
  const matches = localMarkdownImageSanitizationMatches(text);
  let sanitized = text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!isSensitiveLocalMarkdownImageTarget(match.target)) continue;
    const replacement = markdownImageLabel(match.label);
    sanitized = `${sanitized.slice(0, match.start)}${replacement}${sanitized.slice(match.end)}`;
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
    const rawTarget = match.target.trim();
    const destination = markdownImageDestination(rawTarget);
    if (!rawTarget.startsWith('<') && exceedsPlainDestinationParenDepth(destination)) continue;
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
    const replacement = markdownImageLabel(match.label);
    text = `${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`;
  }

  return { absPaths, text };
}
