/**
 * cindy-docs/render_pdf.ts —— HTML → PDF。
 *
 * 渲染本身在 desktop main 的隐藏 BrowserWindow 里跑(Chromium printToPDF),
 * 由 deps.renderHtmlToPdf 注入 —— 本包不 import electron。工具层只负责:
 * 参数校验、路径边界、把返回的字节落盘、把失败翻成人话。
 *
 * host 没注入渲染能力(纯 Node 宿主复用本包)时本工具整个不注册,不做「注册了
 * 再运行期报不可用」——模型看不到的工具不会被误选。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodeHTMLAttribute } from 'entities';
import { z } from 'zod';

import type { DocsToolRegistry } from '../cindy_docsToolRegistry.js';
import {
  assertOutputExtension,
  describeOutput,
  DocsPathError,
  prepareInputPath,
  prepareOutputPath,
  readInputFileWithinLimit,
  resolveSessionRoot,
} from './_paths.js';
import { artifactMetadata, errorPayload, okPayload } from './_payload.js';
import { decodeCssText, decodeUnicodeText } from './_textEncoding.js';
import { applyReportTemplate, extractHtmlTitle } from './pdfTemplate.js';
import { DEFAULT_DOCS_THEME, resolveDocsTheme, type DocsThemeName } from './themes.js';
import type {
  DocsMcpSessionCtx,
  DocsPdfPageSize,
  RenderHtmlToPdfFn,
  WriteDocsOutputFn,
} from './types.js';

/** 与设计一致的渲染硬超时。加载卡死的页面不能拖着任务不放。 */
export const RENDER_PDF_TIMEOUT_MS = 30_000;
/**
 * 等 webfont 就绪的子超时。Chromium 不会自己等 @font-face,字体没加载完就打印会被
 * 静默替换成系统字体。这里单独给一小段时间等 document.fonts.ready;等不到就照常
 * 出片并告警,不占满总超时(字体只是"可能不对",而不是"渲染失败")。
 */
export const RENDER_PDF_FONT_TIMEOUT_MS = 5_000;
/** 自包含 HTML 允许内联图片/字体，但仍需限制主进程读取和模板复制的内存上界。 */
export const RENDER_PDF_MAX_HTML_BYTES = 16 * 1024 * 1024;
/** 空/超小 PDF 的告警阈值:低于这个字节数几乎必然是白页,值得让模型自查。 */
const SUSPICIOUS_PDF_BYTES = 2_048;
/** 单个任务目录资源的上限,避免 HTML 引用一个超大本地文件拖垮 main。 */
const MAX_LOCAL_RESOURCE_BYTES = 8 * 1024 * 1024;
/** 一个 HTML 快照允许带入的本地资源总量。 */
const MAX_LOCAL_RESOURCE_TOTAL_BYTES = 32 * 1024 * 1024;
/** 资源展开成 data URI 后的 HTML 硬上限,防止重复引用放大主进程字符串。 */
const MAX_SNAPSHOT_HTML_BYTES = 64 * 1024 * 1024;
/** 单次 HTML 快照允许处理的本地资源引用次数,防止重复 token 拖垮主进程。 */
const MAX_LOCAL_RESOURCE_REFERENCES = 4_096;

const DEFAULT_MARGIN_INCHES = 0.4;

const LOCAL_RESOURCE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

interface ResourceSnapshotContext {
  root: string;
  totalBytes: number;
  resourceReferences: number;
  cache: Map<string, string>;
  lexicalCache: Map<string, string>;
  cssStack: Set<string>;
  directorySnapshots: Map<string, DirectorySnapshot>;
}

interface DirectorySnapshot {
  path: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function resourceDirectoryChanged(directory: string): DocsPathError {
  return new DocsPathError(
    'PATH_NOT_ALLOWED',
    `HTML 快照期间资源目录发生变化: ${directory}`,
    'HTML 与相对资源不再来自同一份任务目录快照，请确认资源目录未被并发修改后重试。',
  );
}

async function captureDirectorySnapshot(directory: string): Promise<DirectorySnapshot> {
  try {
    const [realPath, stat] = await Promise.all([
      fs.realpath(directory),
      fs.stat(directory, { bigint: true }),
    ]);
    if (!stat.isDirectory()) throw resourceDirectoryChanged(directory);
    return {
      path: directory,
      realPath,
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (error) {
    if (error instanceof DocsPathError) throw error;
    throw resourceDirectoryChanged(directory);
  }
}

function sameDirectorySnapshot(left: DirectorySnapshot, right: DirectorySnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.realPath === right.realPath &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function recordDirectorySnapshot(
  context: ResourceSnapshotContext,
  directory: string,
  expected?: DirectorySnapshot,
): Promise<void> {
  const key = path.resolve(directory);
  const current = await captureDirectorySnapshot(directory);
  if (expected && !sameDirectorySnapshot(expected, current)) {
    throw resourceDirectoryChanged(directory);
  }
  const previous = context.directorySnapshots.get(key);
  if (previous && !sameDirectorySnapshot(previous, current)) {
    throw resourceDirectoryChanged(directory);
  }
  context.directorySnapshots.set(key, current);
}

async function verifyDirectorySnapshots(context: ResourceSnapshotContext): Promise<void> {
  for (const snapshot of context.directorySnapshots.values()) {
    const current = await captureDirectorySnapshot(snapshot.path);
    if (!sameDirectorySnapshot(snapshot, current)) {
      throw resourceDirectoryChanged(snapshot.path);
    }
  }
}

function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function isLocalResourceReference(reference: string): boolean {
  const value = reference.trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return false;
  try {
    return new URL(value).protocol === '';
  } catch {
    return !/^[a-z][a-z\d+.-]*:/i.test(value);
  }
}

function assertNotExplicitFileUrl(reference: string): void {
  const value = reference.trim();
  if (!value) return;
  try {
    if (new URL(value).protocol !== 'file:') return;
  } catch {
    return;
  }
  throw new DocsPathError(
    'PATH_NOT_ALLOWED',
    `HTML 不允许显式 file: URL: ${reference}`,
    '请改用任务工作目录内的相对路径或 data URI。',
  );
}

function assertNotBlockedRemoteUrl(reference: string): void {
  const value = reference.trim();
  if (!value) return;
  if (value.startsWith('//')) {
    throw new DocsPathError(
      'PATH_NOT_ALLOWED',
      `HTML 不允许公网资源 URL: ${reference}`,
      '渲染器会阻断 http(s) 请求。请先把图片、字体或样式表放进任务工作目录，或改成 data URI。',
    );
  }
  let protocol = '';
  try {
    protocol = new URL(value).protocol;
  } catch {
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return;
  throw new DocsPathError(
    'PATH_NOT_ALLOWED',
    `HTML 不允许公网资源 URL: ${reference}`,
    '渲染器会阻断 http(s) 请求。请先把图片、字体或样式表放进任务工作目录，或改成 data URI。',
  );
}

function resolveLocalResourcePath(baseUrl: URL, reference: string): string | undefined {
  let resolved: URL;
  try {
    resolved = new URL(reference.trim(), baseUrl);
  } catch {
    throw new DocsPathError(
      'PATH_NOT_ALLOWED',
      `本地资源 URL 无法解码: ${reference}`,
      '请把图片、字体或样式表改成有效的相对路径或 data URI。',
    );
  }
  if (resolved.protocol !== 'file:') return undefined;
  resolved.hash = '';
  resolved.search = '';
  try {
    return fileURLToPath(resolved);
  } catch {
    throw new DocsPathError(
      'PATH_NOT_ALLOWED',
      `本地资源 URL 无法解析: ${reference}`,
      '请把图片、字体或样式表改成有效的相对路径或 data URI。',
    );
  }
}

function resourceMime(absPath: string): string {
  return (
    LOCAL_RESOURCE_MIME_TYPES[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream'
  );
}

function assertSnapshotHtmlSize(bytes: number): void {
  if (bytes > MAX_SNAPSHOT_HTML_BYTES) {
    throw new DocsPathError(
      'FILE_TOO_LARGE',
      'HTML 引用的本地资源展开后过大',
      '这份 HTML 的本地资源在转换成 data URI 后超过 64 MB。请减少重复引用、压缩资源或拆分文档后重试。',
    );
  }
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = Array.from(input.matchAll(pattern));
  if (matches.length === 0) return input;
  const parts: string[] = [];
  let outputBytes = 0;
  const pushPart = (part: string): void => {
    outputBytes += Buffer.byteLength(part, 'utf8');
    assertSnapshotHtmlSize(outputBytes);
    parts.push(part);
  };
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    pushPart(input.slice(cursor, index));
    pushPart(await replacer(match[0]!, ...match.slice(1).map((group) => group ?? '')));
    cursor = index + match[0]!.length;
  }
  pushPart(input.slice(cursor));
  return parts.join('');
}

function findHtmlTagEnd(input: string, start: number): number {
  let quote: string | undefined;
  for (let end = start + 1; end < input.length; end += 1) {
    const ch = input[end]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return end;
  }
  return -1;
}

const HTML_RAW_TEXT_TAGS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

function findTemplateSubtreeEnd(input: string, contentStart: number): number {
  let depth = 1;
  let index = contentStart;
  while (index < input.length) {
    const start = input.indexOf('<', index);
    if (start < 0) return input.length;
    if (input.startsWith('<!--', start)) {
      const endComment = input.indexOf('-->', start + 4);
      index = endComment < 0 ? input.length : endComment + 3;
      continue;
    }
    const end = findHtmlTagEnd(input, start);
    if (end < 0) return input.length;
    const tag = input.slice(start, end + 1);
    const rawText = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/i);
    if (rawText && HTML_RAW_TEXT_TAGS.has(rawText[1]!.toLowerCase())) {
      const closing = new RegExp(`<\\/\\s*${rawText[1]}\\s*>`, 'ig');
      closing.lastIndex = end + 1;
      const closingMatch = closing.exec(input);
      index = closingMatch ? closingMatch.index + closingMatch[0].length : input.length;
      continue;
    }
    if (/^<\s*template\b/i.test(tag) && !/\/\s*>$/.test(tag)) depth += 1;
    else if (/^<\s*\/\s*template\s*>/i.test(tag)) {
      depth -= 1;
      if (depth === 0) return end + 1;
    }
    index = end + 1;
  }
  return input.length;
}

/** HTML tag scanner that does not terminate on `>` inside a quoted attribute. */
async function replaceHtmlTagsAsync(
  input: string,
  predicate: (tag: string) => boolean,
  replacer: (tag: string) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let outputBytes = 0;
  const pushPart = (part: string): void => {
    outputBytes += Buffer.byteLength(part, 'utf8');
    assertSnapshotHtmlSize(outputBytes);
    parts.push(part);
  };
  let cursor = 0;
  let index = 0;
  while (index < input.length) {
    const start = input.indexOf('<', index);
    if (start < 0) break;
    if (input.startsWith('<!--', start)) {
      const endComment = input.indexOf('-->', start + 4);
      index = endComment < 0 ? input.length : endComment + 3;
      continue;
    }
    const end = findHtmlTagEnd(input, start);
    if (end < 0) break;
    const tag = input.slice(start, end + 1);
    if (/^<\s*template\b/i.test(tag) && !/\/\s*>$/.test(tag)) {
      index = findTemplateSubtreeEnd(input, end + 1);
      continue;
    }
    const rawTextMatch = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/i);
    if (rawTextMatch && HTML_RAW_TEXT_TAGS.has(rawTextMatch[1]!.toLowerCase())) {
      if (predicate(tag)) {
        pushPart(input.slice(cursor, start));
        pushPart(await replacer(tag));
        cursor = end + 1;
      }
      const name = rawTextMatch[1]!;
      const closing = new RegExp(`<\\/\\s*${name}\\s*>`, 'ig');
      closing.lastIndex = end + 1;
      const closingMatch = closing.exec(input);
      index = closingMatch ? closingMatch.index + closingMatch[0].length : input.length;
      continue;
    }
    if (predicate(tag)) {
      pushPart(input.slice(cursor, start));
      pushPart(await replacer(tag));
      cursor = end + 1;
    }
    index = end + 1;
  }
  pushPart(input.slice(cursor));
  return parts.join('');
}

async function inlineCssImports(
  css: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
): Promise<string> {
  return rewriteCssResources(css, baseUrl, context);
}

async function inlineCssUrls(
  css: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
  decodeReference: (reference: string) => string = (reference) => reference,
): Promise<string> {
  return rewriteCssResources(css, baseUrl, context, decodeReference);
}

function isCssHexDigit(value: string | undefined): boolean {
  return value !== undefined && /^[\da-f]$/i.test(value);
}

function isCssWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n' || value === '\f';
}

function skipCssWhitespaceAndComments(css: string, start: number): number {
  let cursor = start;
  while (cursor < css.length) {
    while (isCssWhitespace(css[cursor])) cursor += 1;
    if (!css.startsWith('/*', cursor)) break;
    const end = css.indexOf('*/', cursor + 2);
    cursor = end < 0 ? css.length : end + 2;
  }
  return cursor;
}

function isCssIdentifierContinuation(value: string | undefined): boolean {
  if (value === undefined) return false;
  const codePoint = value.codePointAt(0)!;
  return (
    value === '-' ||
    value === '_' ||
    value === '\\' ||
    /^[a-z\d]$/i.test(value) ||
    codePoint >= 0x80
  );
}

function cssEscapeEnd(value: string, start: number): number {
  const next = value[start + 1];
  if (next === undefined) return start + 1;
  if (next === '\r' && value[start + 2] === '\n') return start + 3;
  if (next === '\r' || next === '\n' || next === '\f') return start + 2;
  if (!isCssHexDigit(next)) return start + 2;
  let end = start + 1;
  let digits = 0;
  while (digits < 6 && isCssHexDigit(value[end])) {
    end += 1;
    digits += 1;
  }
  if (value[end] === '\r' && value[end + 1] === '\n') return end + 2;
  if (isCssWhitespace(value[end])) return end + 1;
  return end;
}

/** Decode CSS escapes after the containing HTML attribute has been decoded. */
function decodeCssResourceReference(value: string): string {
  let decoded = '';
  let index = 0;
  while (index < value.length) {
    if (value[index] !== '\\') {
      decoded += value[index]!;
      index += 1;
      continue;
    }
    const escapeEnd = cssEscapeEnd(value, index);
    const escaped = value.slice(index + 1, escapeEnd);
    if (escaped === '\n' || escaped === '\r' || escaped === '\f' || escaped === '\r\n') {
      index = escapeEnd;
      continue;
    }
    const hex = escaped.match(/^[\da-f]{1,6}/i)?.[0];
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      decoded +=
        codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? '\ufffd'
          : String.fromCodePoint(codePoint);
    } else if (escaped.length > 0) {
      decoded += escaped[0]!;
    } else {
      decoded += '\ufffd';
    }
    index = escapeEnd;
  }
  return decoded;
}

function parseCssIdentifier(css: string, index: number): { value: string; end: number } | null {
  let value = '';
  let cursor = index;
  while (isCssIdentifierContinuation(css[cursor])) {
    if (css[cursor] === '\\') {
      const end = cssEscapeEnd(css, cursor);
      value += decodeCssResourceReference(css.slice(cursor, end));
      cursor = end;
    } else {
      value += css[cursor]!;
      cursor += 1;
    }
  }
  return cursor > index ? { value, end: cursor } : null;
}

function parseCssUrlToken(
  css: string,
  index: number,
): { reference: string; end: number } | null {
  if (isCssIdentifierContinuation(css[index - 1])) return null;
  const identifier = parseCssIdentifier(css, index);
  if (identifier?.value.toLowerCase() !== 'url') return null;
  const open = skipCssWhitespaceAndComments(css, identifier.end);
  if (css[open] !== '(') return null;
  let cursor = open + 1;
  cursor = skipCssWhitespaceAndComments(css, cursor);
  let reference = '';
  if (css[cursor] === '"' || css[cursor] === "'") {
    const quote = css[cursor]!;
    cursor += 1;
    const start = cursor;
    while (cursor < css.length && css[cursor] !== quote) {
      if (css[cursor] === '\\') cursor = cssEscapeEnd(css, cursor);
      else cursor += 1;
    }
    reference = css.slice(start, cursor);
    cursor += 1;
  } else {
    const start = cursor;
    while (cursor < css.length && css[cursor] !== ')') {
      if (css[cursor] === '\\') cursor = cssEscapeEnd(css, cursor);
      else cursor += 1;
    }
    reference = css.slice(start, cursor).trim();
  }
  while (isCssWhitespace(css[cursor])) cursor += 1;
  return css[cursor] === ')' ? { reference, end: cursor + 1 } : null;
}

async function rewriteCssResources(
  css: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
  decodeReference: (reference: string) => string = (reference) => reference,
): Promise<string> {
  const out: string[] = [];
  let index = 0;
  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      const stop = end < 0 ? css.length : end + 2;
      out.push(css.slice(index, stop));
      index = stop;
      continue;
    }
    const current = css[index]!;
    if (current === '"' || current === "'") {
      const quote = current;
      let end = index + 1;
      while (end < css.length) {
        if (css[end] === '\\') end = cssEscapeEnd(css, end);
        else if (css[end] === quote) {
          end += 1;
          break;
        } else end += 1;
      }
      out.push(css.slice(index, end));
      index = end;
      continue;
    }
    const importMatch = css.slice(index).match(/^@import\b/i);
    if (importMatch) {
      let cursor = index + importMatch[0].length;
      cursor = skipCssWhitespaceAndComments(css, cursor);
      if (css[cursor] === '"' || css[cursor] === "'") {
        const quote = css[cursor]!;
        const start = cursor;
        cursor += 1;
        while (cursor < css.length && css[cursor] !== quote) {
          if (css[cursor] === '\\') cursor = cssEscapeEnd(css, cursor);
          else cursor += 1;
        }
        const reference = css.slice(start + 1, cursor);
        const snapshot = await snapshotLocalResource(
          context,
          baseUrl,
          decodeCssResourceReference(decodeReference(reference.trim())),
          'text/css',
        );
        out.push(css.slice(index, start));
        out.push(snapshot ? `url("${snapshot}")` : css.slice(start, cursor + 1));
        index = Math.min(css.length, cursor + 1);
        continue;
      }
      const importUrl = parseCssUrlToken(css, cursor);
      if (importUrl) {
        const snapshot = await snapshotLocalResource(
          context,
          baseUrl,
          decodeCssResourceReference(decodeReference(importUrl.reference)),
          'text/css',
        );
        out.push(css.slice(index, cursor));
        out.push(snapshot ? `url("${snapshot}")` : css.slice(cursor, importUrl.end));
        index = importUrl.end;
        continue;
      }
    }
    const urlToken = parseCssUrlToken(css, index);
    if (urlToken) {
      const original = css.slice(index, urlToken.end);
      const snapshot = await snapshotLocalResource(
        context,
        baseUrl,
        decodeCssResourceReference(decodeReference(urlToken.reference)),
      );
      out.push(snapshot ? `url("${snapshot}")` : original);
      index = urlToken.end;
      continue;
    }
    out.push(current);
    index += 1;
  }
  const rewritten = out.join('');
  assertSnapshotHtmlSize(Buffer.byteLength(rewritten, 'utf8'));
  return rewritten;
}

function splitSrcset(value: string): string[] {
  const candidates: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== ',') continue;
    const segment = value.slice(start, index).trimStart();
    const insideDataUrl = /^data:/i.test(segment) && !/\s/.test(segment);
    if (insideDataUrl) continue;
    candidates.push(value.slice(start, index));
    start = index + 1;
  }
  candidates.push(value.slice(start));
  return candidates.map((candidate) => candidate.trim()).filter(Boolean);
}

/**
 * Read the small subset of HTML attributes whose values may point at local
 * task resources.  HTML permits these values to be either quoted or
 * unquoted; keeping one parser for both forms prevents the resource policy
 * from silently dropping valid markup such as `<img src=./chart.png>`.
 */
const HTML_ATTRIBUTE_PATTERN =
  /(\s+)([A-Za-z_:][\w:.-]*)(\s*=\s*)(?:(['"])([\s\S]*?)\4|([^\s"'=<>\x60]+))/gi;

function readHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const wanted = attributeName.toLowerCase();
  for (const match of tag.matchAll(HTML_ATTRIBUTE_PATTERN)) {
    if (match[2]!.toLowerCase() !== wanted) continue;
    return match[4] ? match[5] : match[6];
  }
  return undefined;
}

async function rewriteHtmlAttributes(
  tag: string,
  attributeNames: readonly string[],
  replacer: (value: string, attributeName: string) => Promise<string>,
): Promise<string> {
  const wanted = new Set(attributeNames.map((name) => name.toLowerCase()));
  return replaceAsync(
    tag,
    HTML_ATTRIBUTE_PATTERN,
    async (match, leading, attributeName, equals, quote, quoted, bare) => {
      const normalizedName = attributeName.toLowerCase();
      if (!wanted.has(normalizedName)) return match;
      const value = quote ? quoted : bare;
      const rewritten = await replacer(value, normalizedName);
      if (rewritten === value) return match;
      if (quote) {
        const escaped = rewritten
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;');
        return `${leading}${attributeName}${equals}${quote}${escaped}${quote}`;
      }
      if (/^[^\s"'=<>\x60]+$/.test(rewritten)) {
        return `${leading}${attributeName}${equals}${rewritten}`;
      }
      const escaped = rewritten
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
      return `${leading}${attributeName}${equals}"${escaped}"`;
    },
  );
}

async function inlineSrcset(
  value: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
): Promise<string> {
  const candidates = splitSrcset(value);
  const rewritten = await Promise.all(
    candidates.map(async (candidate) => {
      const match = candidate.match(/^(\S+)(?:\s+(.+))?$/);
      if (!match) return candidate;
      const snapshot = await snapshotLocalResource(
        context,
        baseUrl,
        decodeHTMLAttribute(match[1]!),
      );
      return `${snapshot ?? match[1]}${match[2] ? ` ${match[2]}` : ''}`;
    }),
  );
  return rewritten.join(', ');
}

async function rewriteHtmlStyleElementsAsync(
  input: string,
  baseUrl: URL,
  context: ResourceSnapshotContext,
): Promise<string> {
  const parts: string[] = [];
  let cursor = 0;
  let index = 0;
  let outputBytes = 0;
  const push = (part: string): void => {
    outputBytes += Buffer.byteLength(part, 'utf8');
    assertSnapshotHtmlSize(outputBytes);
    parts.push(part);
  };
  while (index < input.length) {
    const start = input.indexOf('<', index);
    if (start < 0) break;
    if (input.startsWith('<!--', start)) {
      const endComment = input.indexOf('-->', start + 4);
      index = endComment < 0 ? input.length : endComment + 3;
      continue;
    }
    const end = findHtmlTagEnd(input, start);
    if (end < 0) break;
    const tag = input.slice(start, end + 1);
    if (/^<\s*template\b/i.test(tag) && !/\/\s*>$/.test(tag)) {
      index = findTemplateSubtreeEnd(input, end + 1);
      continue;
    }
    const opening = /^<\s*style\b/i.test(tag) && !/^<\s*\/style\b/i.test(tag);
    if (!opening) {
      const raw = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/i);
      if (raw && HTML_RAW_TEXT_TAGS.has(raw[1]!.toLowerCase())) {
        const closing = new RegExp(`<\\/\\s*${raw[1]}\\s*>`, 'ig');
        closing.lastIndex = end + 1;
        const closingMatch = closing.exec(input);
        index = closingMatch ? closingMatch.index + closingMatch[0].length : input.length;
        continue;
      }
      index = end + 1;
      continue;
    }
    const closing = /<\/\s*style\s*>/gi;
    closing.lastIndex = end + 1;
    const closingMatch = closing.exec(input);
    if (!closingMatch) break;
    push(input.slice(cursor, start));
    push(tag);
    const css = input.slice(end + 1, closingMatch.index);
    const imported = await inlineCssImports(css, baseUrl, context);
    push(await inlineCssUrls(imported, baseUrl, context));
    push(closingMatch[0]);
    cursor = closingMatch.index + closingMatch[0].length;
    index = cursor;
  }
  push(input.slice(cursor));
  return parts.join('');
}

async function snapshotLocalResource(
  context: ResourceSnapshotContext,
  baseUrl: URL,
  reference: string,
  mimeOverride?: string,
): Promise<string | undefined> {
  assertNotExplicitFileUrl(reference);
  assertNotBlockedRemoteUrl(reference);
  if (!isLocalResourceReference(reference)) return undefined;
  let fragment = '';
  try {
    fragment = new URL(reference.trim(), baseUrl).hash;
  } catch {
    // resolveLocalResourcePath below returns the user-facing validation error.
  }
  const absPath = resolveLocalResourcePath(baseUrl, reference);
  if (!absPath) return undefined;
  context.resourceReferences += 1;
  if (context.resourceReferences > MAX_LOCAL_RESOURCE_REFERENCES) {
    throw new DocsPathError(
      'FILE_TOO_LARGE',
      'HTML 引用的本地资源次数过多',
      `这份 HTML 的本地图片、字体和样式表引用超过 ${MAX_LOCAL_RESOURCE_REFERENCES} 次。请减少重复引用或改用 data URI。`,
    );
  }
  const lexicalCacheKey = `${path.resolve(absPath)}\0${mimeOverride ?? ''}`;
  const lexicalCached = context.lexicalCache.get(lexicalCacheKey);
  if (lexicalCached) return `${lexicalCached}${fragment}`;
  const preparedPath = await prepareInputPath(context.root, absPath);
  const cacheKey = `${path.resolve(preparedPath)}\0${mimeOverride ?? ''}`;
  const cached = context.cache.get(cacheKey);
  if (cached) return `${cached}${fragment}`;

  const resourceDirectory = path.dirname(preparedPath);
  const beforeDirectory = await captureDirectorySnapshot(resourceDirectory);
  await recordDirectorySnapshot(context, resourceDirectory, beforeDirectory);

  const bytes = await readInputFileWithinLimit(
    context.root,
    preparedPath,
    MAX_LOCAL_RESOURCE_BYTES,
    (size) =>
      new DocsPathError(
        'FILE_TOO_LARGE',
        `本地资源过大: ${preparedPath}`,
        `这份本地资源有 ${(size / 1024 / 1024).toFixed(1)} MB,超过单个资源上限(8 MB)。请压缩或改成更小的 data URI。`,
      ),
  );
  const afterDirectory = await captureDirectorySnapshot(resourceDirectory);
  if (!sameDirectorySnapshot(beforeDirectory, afterDirectory)) {
    throw resourceDirectoryChanged(resourceDirectory);
  }
  context.totalBytes += bytes.byteLength;
  if (context.totalBytes > MAX_LOCAL_RESOURCE_TOTAL_BYTES) {
    throw new DocsPathError(
      'FILE_TOO_LARGE',
      'HTML 引用的本地资源总量过大',
      '这份 HTML 引用的本地图片、字体和样式表总量超过 32 MB。请压缩资源或拆分文档后重试。',
    );
  }

  const mime = mimeOverride ?? resourceMime(preparedPath);
  let snapshotBytes = bytes;
  if (mime === 'text/css') {
    const decodedCss = decodeCssText(bytes);
    if (context.cssStack.has(cacheKey)) {
      return dataUri(mime, Buffer.from(decodedCss, 'utf8'));
    }
    context.cssStack.add(cacheKey);
    try {
      const imported = await inlineCssImports(decodedCss, pathToFileURL(preparedPath), context);
      const rewritten = await inlineCssUrls(imported, pathToFileURL(preparedPath), context);
      snapshotBytes = Buffer.from(rewritten, 'utf8');
    } finally {
      context.cssStack.delete(cacheKey);
    }
  }
  const snapshot = dataUri(mime, snapshotBytes);
  context.cache.set(cacheKey, snapshot);
  context.lexicalCache.set(lexicalCacheKey, snapshot);
  return `${snapshot}${fragment}`;
}

async function inlineLocalResources(
  root: string,
  sourcePath: string,
  html: string,
  expectedSourceDirectory?: DirectorySnapshot,
  initialDirectorySnapshots?: Map<string, DirectorySnapshot>,
): Promise<string> {
  const context: ResourceSnapshotContext = {
    root,
    totalBytes: 0,
    resourceReferences: 0,
    cache: new Map(),
    lexicalCache: new Map(),
    cssStack: new Set(),
    directorySnapshots: new Map(initialDirectorySnapshots),
  };
  await recordDirectorySnapshot(
    context,
    path.dirname(sourcePath),
    expectedSourceDirectory
      ? { ...expectedSourceDirectory, path: path.dirname(sourcePath) }
      : undefined,
  );
  const documentUrl = pathToFileURL(sourcePath);
  let baseUrl = documentUrl;
  let baseTag: string | undefined;
  await replaceHtmlTagsAsync(
    html,
    (tag) => /^<base\b/i.test(tag),
    async (tag) => {
      baseTag ??= tag;
      return tag;
    },
  );
  const rawBaseHref = baseTag ? readHtmlAttribute(baseTag, 'href') : undefined;
  const baseHref = rawBaseHref ? decodeHTMLAttribute(rawBaseHref) : undefined;
  if (baseHref) {
    assertNotExplicitFileUrl(baseHref);
    assertNotBlockedRemoteUrl(baseHref);
    try {
      baseUrl = new URL(baseHref, documentUrl);
    } catch {
      throw new DocsPathError(
        'PATH_NOT_ALLOWED',
        `HTML 的 base href 无法解析: ${baseHref}`,
        '请把 <base href> 改成有效的本地相对路径。',
      );
    }
  }
  let rewritten = await replaceHtmlTagsAsync(
    html,
    (tag) => /^<link\b/i.test(tag),
    async (tag) => {
      const href = readHtmlAttribute(tag, 'href');
      if (!href) return tag;
      assertNotBlockedRemoteUrl(decodeHTMLAttribute(href));
      const rel = decodeHTMLAttribute(readHtmlAttribute(tag, 'rel') ?? '');
      const isStylesheet = rel
        .split(/\s+/)
        .some((token) => token.toLowerCase() === 'stylesheet');
      if (!isStylesheet && !/\.css(?:[?#]|$)/i.test(href)) return tag;
      return rewriteHtmlAttributes(tag, ['href'], async (reference) => {
        return (
          (await snapshotLocalResource(
            context,
            baseUrl,
            decodeHTMLAttribute(reference),
            'text/css',
          )) ?? reference
        );
      });
    },
  );
  rewritten = await replaceHtmlTagsAsync(
    rewritten,
    (tag) => /^<(?:img|source|audio|video|track|object|input|image|use)\b/i.test(tag),
    async (tag) => {
      const withSources = await rewriteHtmlAttributes(
        tag,
        ['src', 'poster', 'data', 'href', 'xlink:href'],
        async (reference) =>
          (await snapshotLocalResource(context, baseUrl, decodeHTMLAttribute(reference))) ??
          reference,
      );
      return rewriteHtmlAttributes(withSources, ['srcset'], async (value) =>
        inlineSrcset(value, baseUrl, context),
      );
    },
  );
  rewritten = await rewriteHtmlStyleElementsAsync(rewritten, baseUrl, context);
  const result = await replaceHtmlTagsAsync(
    rewritten,
    (tag) => tag[1] !== '/' && /\bstyle\s*=/i.test(tag),
    (tag) =>
      rewriteHtmlAttributes(tag, ['style'], async (css) => {
        const rewrittenCss = await inlineCssUrls(decodeHTMLAttribute(css), baseUrl, context);
        return rewrittenCss;
      }),
  );
  await verifyDirectorySnapshots(context);
  return result;
}

const DESCRIPTION = [
  '把 HTML 渲染成 PDF(用 Cindy 内置的 Chromium 排版,不需要用户装任何东西)。',
  '',
  '【何时用】需要精确版式的正式文档:报告、简历、发票、带图表的材料。',
  '推荐做法是先写一份自包含的 HTML(样式内联,不依赖外部 CSS 文件),再用本工具出 PDF。',
  '如果产物要给人二次编辑,请改用 make_docx —— PDF 不好改。',
  '',
  '【输入】htmlPath(工作目录内的 .html 文件)与 html(内联源码)二选一,必须给且只给一个。',
  'HTML 源码上限 16 MB;文件路径与内联源码使用同一上限。',
  '为防止不可信 HTML 借用户网络身份探测内网或触发跟踪,渲染窗会阻断外部网络请求。',
  '图片/字体/样式可直接引用任务目录内的相对路径;工具会先把已验证的本地资源快照成 data URI,再交给渲染器。外部网络请求仍会阻断。',
  '',
  '【模板】template 默认 auto:没有 <style> / 外链 CSS 的裸 HTML 会自动套内置报告模板',
  '(系统字体、标题层级、表格斑马纹、打印页边距)。已经自己写了样式的原样透传。',
  'template:"none" 关闭;theme: light / dark / navy 只影响自动套上的模板。',
  '',
  '【排版】pageSize 默认 A4;margins 单位是英寸,默认四边 0.4。',
  '自动套模板且未显式传 margins 时,Electron 边距归零,改由 CSS @page 管边距,避免双边距。',
  'printBackground 默认 true(否则深色底、色块全部不打印)。',
  '分页控制在 HTML 里用 CSS: page-break-after / break-inside: avoid。',
  '',
  '【字体】渲染前会等 @font-face 加载完(最多 5 秒)。等不到会照常出片,但返回里',
  'fontsReady=false —— 那说明 PDF 里的字体很可能被换成了系统默认字体。要么把字体',
  '改成 base64 内联进 HTML,要么接受回退,别不看这个字段就交付。',
  '',
  '【自检】出片后**务必再调 inspect_pdf 回读一次**:整页空白的 PDF 字节数看着完全',
  '正常,只看 bytes 判断不出来。inspect_pdf 会直接告诉你哪几页是白的、总共几页、',
  '纸张对不对。返回里的 bytes 只能筛掉最极端的情况。',
  '',
  '【输出】outPath 必须在本任务的工作目录内。同名文件默认不覆盖,确要覆盖再传 overwrite: true。',
].join('\n');

const PAGE_SIZES: readonly DocsPdfPageSize[] = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid'];

export function registerRenderPdfTool(
  registry: DocsToolRegistry,
  sessionCtx: DocsMcpSessionCtx,
  renderHtmlToPdf: RenderHtmlToPdfFn,
  writeDocsOutput: WriteDocsOutputFn,
): void {
  registry.register({
    name: 'render_pdf',
    category: 'convert',
    description: DESCRIPTION,
    inputShape: {
      htmlPath: z.string().optional().describe('工作目录内的 .html 文件路径。与 html 二选一。'),
      html: z
        .string()
        .optional()
        .describe(
          '内联 HTML 源码。与 htmlPath 二选一。相对图片/字体/样式以任务工作目录为基准快照;file:// 与工作目录外路径会被拒绝。',
        ),
      outPath: z.string().min(1).describe('输出 .pdf 路径,工作目录内的相对路径或绝对路径。'),
      pageSize: z
        .enum(PAGE_SIZES as unknown as [DocsPdfPageSize, ...DocsPdfPageSize[]])
        .default('A4')
        .describe('纸张尺寸,默认 A4。'),
      landscape: z.boolean().default(false).describe('是否横向。默认纵向。'),
      printBackground: z.boolean().default(true).describe('是否打印背景色与背景图。默认 true。'),
      margins: z
        .object({
          top: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
          bottom: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
          left: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
          right: z.number().min(0).max(5).default(DEFAULT_MARGIN_INCHES),
        })
        .optional()
        .describe('页边距(英寸)。不传时四边都是 0.4。'),
      template: z
        .enum(['auto', 'report', 'none'])
        .default('auto')
        .describe('auto=无样式时套内置报告模板;report=同样只套无样式 HTML;none=不套。'),
      theme: z
        .enum(['light', 'dark', 'navy'])
        .default('light')
        .describe('自动套模板时使用的色板。已有样式的 HTML 不受影响。'),
      overwrite: z.boolean().default(false).describe('目标文件已存在时是否覆盖。默认 false。'),
    },
    handler: async ({
      htmlPath,
      html,
      outPath,
      pageSize,
      landscape,
      printBackground,
      margins,
      template,
      theme,
      overwrite,
    }) => {
      const hasPath = typeof htmlPath === 'string' && htmlPath.length > 0;
      const hasInline = typeof html === 'string' && html.length > 0;
      if (hasPath === hasInline) {
        return errorPayload(
          'INVALID_ARGS',
          hasPath
            ? 'htmlPath 和 html 只能给一个:要么指一个已有的 HTML 文件,要么直接给源码。'
            : '必须给 htmlPath(已有的 HTML 文件)或 html(内联源码)之一。',
          { gotHtmlPath: hasPath, gotHtml: hasInline },
        );
      }

      try {
        const root = resolveSessionRoot(sessionCtx);
        assertOutputExtension(outPath, '.pdf');
        const abs = await prepareOutputPath(root, outPath, overwrite);
        const sourcePath = hasPath ? await prepareInputPath(root, htmlPath!) : undefined;
        const sourceDirectory = sourcePath
          ? await captureDirectorySnapshot(path.dirname(sourcePath))
          : undefined;
        const initialDirectorySnapshots = sourceDirectory
          ? new Map([[path.resolve(path.dirname(sourcePath!)), sourceDirectory]])
          : undefined;
        // Capture the source's canonical relative location before reading. Keep the
        // lexical root prefix (macOS commonly exposes /var as /private/var through
        // realpath) so later resource boundary checks use the same root spelling.
        // The bounded reader below verifies the source identity and root again; using
        // this stable relative location prevents a parent-path rebind from changing
        // the resource base between the HTML snapshot and inlining.
        const sourceSnapshotPath = sourcePath
          ? await (async () => {
              const [realRoot, realSource] = await Promise.all([
                fs.realpath(root),
                fs.realpath(sourcePath),
              ]);
              const relative = path.relative(realRoot, realSource);
              if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new DocsPathError(
                  'PATH_NOT_ALLOWED',
                  `输入文件不在任务工作目录内: ${sourcePath}`,
                  '请把 HTML 文件放在当前任务工作目录内后重试。',
                );
              }
              return path.join(root, relative);
            })()
          : undefined;
        const sourceBytes = sourcePath
          ? await readInputFileWithinLimit(
              root,
              sourcePath,
              RENDER_PDF_MAX_HTML_BYTES,
              (bytes) =>
                new DocsPathError(
                  'FILE_TOO_LARGE',
                  `HTML 过大: ${bytes} 字节`,
                  `这份 HTML 有 ${(bytes / 1024 / 1024).toFixed(1)} MB,超出 PDF 渲染上限(16 MB)。请压缩内联图片/字体或拆分文档后重试。`,
                ),
            )
          : undefined;
        const sourceHtml = sourceBytes ? decodeUnicodeText(sourceBytes, 'HTML') : html!;
        if (!sourcePath) {
          const inlineBytes = Buffer.byteLength(sourceHtml, 'utf8');
          if (inlineBytes > RENDER_PDF_MAX_HTML_BYTES) {
            throw new DocsPathError(
              'FILE_TOO_LARGE',
              `HTML 过大: ${inlineBytes} 字节`,
              `这份 HTML 有 ${(inlineBytes / 1024 / 1024).toFixed(1)} MB,超出 PDF 渲染上限(16 MB)。请压缩内联图片/字体或拆分文档后重试。`,
            );
          }
        }
        const snapshotHtml = await inlineLocalResources(
          root,
          sourceSnapshotPath ?? sourcePath ?? path.join(root, '__cindy_inline__.html'),
          sourceHtml,
          sourceDirectory,
          initialDirectorySnapshots,
        );
        const palette = resolveDocsTheme((theme ?? DEFAULT_DOCS_THEME) as DocsThemeName);
        const wrapped = applyReportTemplate(snapshotHtml, palette, template);
        const userSetMargins = margins !== undefined;
        const effectiveMargins = userSetMargins
          ? {
              top: margins.top ?? DEFAULT_MARGIN_INCHES,
              bottom: margins.bottom ?? DEFAULT_MARGIN_INCHES,
              left: margins.left ?? DEFAULT_MARGIN_INCHES,
              right: margins.right ?? DEFAULT_MARGIN_INCHES,
            }
          : wrapped.applied
            ? { top: 0, bottom: 0, left: 0, right: 0 }
            : {
                top: DEFAULT_MARGIN_INCHES,
                bottom: DEFAULT_MARGIN_INCHES,
                left: DEFAULT_MARGIN_INCHES,
                right: DEFAULT_MARGIN_INCHES,
              };

        const renderInput = sourcePath
          ? {
              // The host must consume the exact bytes already checked above.
              // Local task resources have already been converted to data:
              // snapshots, so the host never needs to reopen the caller's directory.
              htmlBytes: Buffer.from(wrapped.html, 'utf8'),
            }
          : { html: wrapped.html };
        const { buffer, fontsReady } = await renderHtmlToPdf({
          ...renderInput,
          pageSize,
          landscape,
          printBackground,
          margins: effectiveMargins,
          timeoutMs: RENDER_PDF_TIMEOUT_MS,
          fontTimeoutMs: RENDER_PDF_FONT_TIMEOUT_MS,
        });

        if (!buffer || buffer.length === 0) {
          return errorPayload(
            'RENDER_EMPTY',
            '渲染出来是空的 PDF。请检查 HTML 里是否真有可见内容(常见原因:整页被 CSS 隐藏、外部样式没加载到)。',
            {},
          );
        }
        await writeDocsOutput({ root, path: abs, data: buffer, overwrite });

        const described = describeOutput(root, abs, buffer.byteLength);
        const warnings: string[] = [];
        if (described.bytes < SUSPICIOUS_PDF_BYTES) {
          warnings.push(
            'PDF 字节数异常小,很可能渲染成了白页。用 inspect_pdf 回读确认,必要时检查 HTML 与外部资源后重做,不要直接交付。',
          );
        }
        if (!fontsReady) {
          warnings.push(
            '等字体加载超时,PDF 里的字体可能已被换成系统默认字体。若排版对字体有要求,请把字体 base64 内联进 HTML 后重做。',
          );
        }
        return okPayload({
          ...described,
          format: 'pdf',
          pageSize,
          landscape,
          fontsReady,
          template,
          theme,
          templateApplied: wrapped.applied,
          nextStep: '用 inspect_pdf 回读这份 PDF,确认页数、纸张与是否有空白页,再交付。',
          artifact: artifactMetadata({
            format: 'pdf',
            title: extractHtmlTitle(snapshotHtml),
            theme,
            summary: { kind: 'bytes', value: buffer.byteLength },
          }),
          ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
        });
      } catch (err) {
        if (err instanceof DocsPathError) {
          return errorPayload(err.code, err.hint, { message: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = /timeout|超时/i.test(message);
        return errorPayload(
          timedOut ? 'RENDER_TIMEOUT' : 'RENDER_FAILED',
          timedOut
            ? `渲染超过 ${RENDER_PDF_TIMEOUT_MS / 1000} 秒被中止。常见原因是 HTML 在等一个加载不出来的外部资源;把外部图片/字体改成内联或本地文件后重试。`
            : `渲染 PDF 失败:${message}`,
          { message },
        );
      }
    },
  });
}
