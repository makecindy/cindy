/**
 * The files a companion's reply refers to (cloud-companions.md §4): generated media by their
 * `cindy-media://` address, and files the reply names inside the companion's own work folder
 * (`documents/report.docx`, a Markdown link, an `xdt-file://` link). They go to the room with the
 * reply so a computer that takes the companion over can open them. Only what the reply names and
 * what exists inside the task's own folder is sent; nothing else on the disk is ever read.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseToolResultPayload } from '@cindy/maker-shared/payload-summary';
import { buildLooseUrl, extractLoosePath } from '../session-share/mediaUrlRewrite.pure.js';
import type { CompanionMirrorAttachment } from './mirror.js';

/** A reply sends at most this many files to the room. */
export const REPLY_ARTIFACTS_MAX = 8;

const PRODUCED_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const BLOB_URL = /\bcindy-media:\/\/blobs\/[0-9a-f]{64}\.[a-z0-9]+/g;
/**
 * Only deliverables go to the room, whatever form the path is written in: documents, spreadsheets,
 * presentations, PDF, CSV/TSV, archives, Markdown, images, audio and video. Code, configuration,
 * data (json/yaml/env/txt) and key files are never sent, even inside the work folder, because the
 * reply naming them is not the owner choosing to hand them over.
 */
const DELIVERABLE_EXT = new Set([
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pages', 'numbers', 'key', 'pdf', 'csv', 'tsv', 'zip', 'md',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'mov', 'webm', 'm4v',
]);
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', bmp: 'image/bmp',
  pdf: 'application/pdf', zip: 'application/zip', csv: 'text/csv', tsv: 'text/tab-separated-values', md: 'text/markdown',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const isDeliverablePath = (candidate: string) => DELIVERABLE_EXT.has(/\.([A-Za-z0-9]{1,8})$/.exec(candidate)?.[1]?.toLowerCase() ?? '');
/** UNC / WebDAV / device paths are never opened (realpath could contact a remote server). */
const NETWORK_PATH = /^[\\/]{2}|^[\\/]\?\?[\\/]/;

export interface ReplyReferences { blobs: string[]; paths: string[] }

/** What the reply text refers to, in reading order and without duplicates. Code fences are examples, not deliveries. */
export function collectReplyReferences(text: string): ReplyReferences {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  const blobs = [...new Set(prose.match(BLOB_URL) ?? [])];
  const paths: string[] = [];
  const add = (candidate: string | null) => {
    if (candidate && !candidate.includes('\0') && isDeliverablePath(candidate) && !paths.includes(candidate)) paths.push(candidate);
  };
  // Markdown link / image targets (a local path, or an xdt-file link).
  for (const match of prose.matchAll(/\]\(\s*<?([^)>\n]+?)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1]!.trim();
    if (target.startsWith('xdt-file://')) {
      add(extractLoosePath(target) ?? hostlessFilePath(target));
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !target.startsWith('#') && !target.startsWith('mailto:')) {
      add(safeDecode(target.split(/[?#]/, 1)[0]!));
    }
  }
  // Paths written in the text (inline code or plain).
  for (const raw of prose.split(/[\s"'`<>()[\]{}|，。；：！？、]+/)) {
    const token = raw.replace(/[.,;:]+$/, '');
    if (!token || token.includes('://')) continue;
    // Chinese text is written without spaces: try the token as is and without the words stuck to its ends.
    const bare = token.replace(/^[\u3400-\u9fff\uff00-\uffef]+/, '');
    for (const candidate of new Set([token, bare, token.replace(/[\u3400-\u9fff\uff00-\uffef]+$/, ''), bare.replace(/[\u3400-\u9fff\uff00-\uffef]+$/, '')])) {
      // A Windows path (`documents\report.docx`, `C:\work\report.docx`) has a folder part just like a `/` one.
      if (/[\\/]/.test(candidate) ? candidate.length > 1 : /^[\p{L}\p{N}_.@ -]+$/u.test(candidate)) add(candidate);
    }
  }
  return { blobs, paths };
}

/**
 * The stored images a tool handed back (`xdt_image_url` / `xdt_image_urls` in its result), which the
 * chat shows as images of the turn although the reply text never names them. A result that asked not
 * to be shown (`_xdt_render_image: false`) and any address that is not a stored blob give nothing.
 */
export function toolResultImageUrls(rawContent: string | null): string[] {
  if (!rawContent) return [];
  let text = rawContent;
  // A result is stored as JSON, sometimes as a JSON string holding the tool's own JSON.
  try {
    const once: unknown = JSON.parse(text);
    if (typeof once === 'string') text = once;
  } catch { return []; }
  // The same reading as the other channels: the ghost_call envelope is opened, and the host's own
  // ledger of produced media (`xdt_media_produced`) counts although the tool named no image field.
  const record = parseToolResultPayload(text);
  if (!record || record._xdt_render_image === false) return [];
  const produced = Array.isArray(record.xdt_media_produced) ? record.xdt_media_produced.filter(url => typeof url === 'string' && PRODUCED_IMAGE_EXT.test(url)) : [];
  const candidates = [record.xdt_image_url, ...(Array.isArray(record.xdt_image_urls) ? record.xdt_image_urls : []), ...produced];
  return [...new Set(candidates.filter((url): url is string => typeof url === 'string' && /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.[a-z0-9]+$/.test(url)))];
}

const ATTACHMENT_NAME_MAX = 60;

/**
 * The name a stored media blob gets in the room: the alt text the reply gave that image (`![alt](address)`),
 * else `image-<first 8 of the hash>`, with the address's extension. The address's own last segment is a 64-digit hash.
 */
export function blobAttachmentName(url: string, text: string, category: 'image' | 'file'): string {
  const [, hash = '', ext = ''] = /\/blobs\/([0-9a-f]{64})\.([a-z0-9]+)$/.exec(url) ?? [];
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  const alt = [...prose.matchAll(/!\[([^\]\n]*)\]\(\s*<?([^)>\s]+)/g)].find(match => match[2] === url)?.[1] ?? '';
  const label = alt.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ATTACHMENT_NAME_MAX).replace(/[. ]+$/, '');
  return `${label || `${category}-${hash.slice(0, 8)}`}.${ext}`;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** The hostless `xdt-file:///abs/path` form the agent is told to write. */
function hostlessFilePath(url: string): string | null {
  if (!url.startsWith('xdt-file:///')) return null;
  const decoded = safeDecode(url.slice('xdt-file://'.length).split(/[?#]/, 1)[0]!);
  return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The path to look up for a name the reply gave: an absolute one as written, a relative one inside
 * `root`. Where the separator is `/`, a relative name written with backslashes (a reply composed on
 * Windows) is read as folders too; where it is `\`, `join` already takes both.
 */
export function replyPathToLookup(candidate: string, root: string, impl: Pick<typeof path, 'isAbsolute' | 'join' | 'sep'> = path): string {
  if (impl.isAbsolute(candidate)) return candidate;
  return impl.join(root, impl.sep === '/' ? candidate.replace(/\\/g, '/') : candidate);
}

export interface ReplyArtifactDeps {
  /** The real folders this companion's task may read from (its work folder); empty when none. */
  roots: (sessionId: string) => Promise<string[]>;
  /** A stored media blob: its type and size, or null when this computer does not have it. */
  blob: (url: string, sessionId: string) => Promise<{ mimeType: string; size: number } | null>;
  /** Stored images the tools of the turn this reply ends produced (see `toolResultImageUrls`). */
  turnImages?: (sessionId: string, row: { id: string; createdAt: number }) => Promise<string[]>;
  maxBytes: number;
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

/** Files the reply names that can go to the room with it (see the file comment). */
export async function replyArtifactAttachments(
  row: { id: string; createdAt?: number }, text: string, sessionId: string, deps: ReplyArtifactDeps,
): Promise<CompanionMirrorAttachment[]> {
  const refs = collectReplyReferences(text);
  // Images the turn's tools made are part of what the chat shows with this reply, named or not.
  const turn = deps.turnImages && row.createdAt !== undefined
    ? await deps.turnImages(sessionId, { id: row.id, createdAt: row.createdAt }).catch((error: unknown) => {
      deps.log?.warn('Turn images could not be listed', { code: (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' });
      return [] as string[];
    }) : [];
  for (const url of turn) if (!refs.blobs.includes(url)) refs.blobs.push(url);
  if (!refs.blobs.length && !refs.paths.length) return [];
  const out: CompanionMirrorAttachment[] = [];
  const full = () => out.length >= REPLY_ARTIFACTS_MAX;
  for (const url of refs.blobs) {
    if (full()) break;
    try {
      const blob = await deps.blob(url, sessionId);
      if (!blob || blob.size <= 0 || blob.size > deps.maxBytes) continue;
      const category = blob.mimeType.startsWith('image/') ? 'image' : 'file';
      out.push({ id: `${row.id}:reply:${out.length}`, name: blobAttachmentName(url, text, category), category,
        mimeType: blob.mimeType, size: blob.size, url, path: null });
    } catch (error) { deps.log?.warn('Reply media not sent to the room', { code: (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' }); }
  }
  if (!refs.paths.length || full()) return out;
  const roots = await deps.roots(sessionId);
  if (!roots.length) return out;
  const seen = new Set<string>();
  for (const candidate of refs.paths) {
    if (full()) break;
    if (NETWORK_PATH.test(candidate)) continue;
    try {
      // Relative names are the work folder's; an absolute one must still end up inside it.
      const real = await fs.realpath(replyPathToLookup(candidate, roots[0]!));
      if (!isDeliverablePath(real)) continue;
      const root = roots.find(item => within(item, real));
      if (!root || seen.has(real)) continue;
      // Hidden files and folders (.env, .git, …) are never part of a delivery.
      if (path.relative(root, real).split(path.sep).some(part => part.startsWith('.'))) continue;
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size <= 0 || stat.size > deps.maxBytes) continue;
      seen.add(real);
      const ext = path.extname(real).slice(1).toLowerCase();
      const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      out.push({ id: `${row.id}:reply:${createHash('sha256').update(real).digest('hex').slice(0, 12)}`, name: path.basename(real).slice(0, 200),
        category: mimeType.startsWith('image/') ? 'image' : 'file', mimeType, size: stat.size, url: null, path: real });
    } catch { /* not a file here: the text only mentioned it */ }
  }
  return out;
}

/** A name safe inside Markdown link text. */
const markdownLabel = (name: string) => name.replace(/[\\`*_{}[\]<>#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');

/**
 * A reply as it reads on the computer that takes the companion over. A reply has no attachment
 * slots, so its files are reachable from the text itself: media the text already names (the same
 * content address) shows as before, anything else is linked below it, and a file that could not
 * come keeps its name.
 */
export function replyTextWithFiles(
  text: string, files: ReadonlyArray<{ name: string; url: string | null; path: string | null }>,
): string {
  const links = files.map(file => {
    if (file.url) return text.includes(file.url) ? '' : `![${markdownLabel(file.name)}](${file.url})`;
    if (file.path) return `[${markdownLabel(file.name)}](${buildLooseUrl('xdt-file', file.path)})`;
    return `[附件: ${file.name}]`;
  }).filter(Boolean);
  return [text, ...links].filter(Boolean).join('\n\n');
}
