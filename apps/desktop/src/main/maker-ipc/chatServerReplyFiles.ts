import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { messages, sessions } from '../localDb/schema.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import { safeDecodeHrefForLookup } from '../pathResolver.js';
import { isPathWithin, localTaskImagePath, taskImageReferences } from '../cindy-media/taskImageMarkdown.js';
import { isNetworkOrDevicePath } from './chatServerReplyAttachments.js';
import { BOT_GROUP_ATTACHMENTS_MAX } from '../../shared/botGroupChat.js';
import type { ChatUploadAttachment } from './chatServerMedia.js';
import { replyFileLinks, withoutLineLocator } from './chatServerReplyFallback.js';

const MAX_BYTES = 100 * 1024 * 1024;
const unavailable = () => new Error('ATTACHMENT_UNAVAILABLE');

function localPath(url: string, workDir: string): string {
  url = withoutLineLocator(url);
  let value = url;
  try {
    if (/^sandbox:/i.test(url)) {
      const match = /^sandbox:\/*(?:([a-z]:[\\/][^\n]*)|(\/[^\n]*))$/i.exec(url);
      if (!match) throw unavailable();
      value = match[1] ?? match[2]!;
      if (/%(?:2f|5c)/i.test(value)) throw unavailable();
      const decoded = safeDecodeHrefForLookup(value);
      if (decoded === null) throw unavailable();
      value = decoded;
    } else if (/^xdt-file:/i.test(url)) {
      const parsed = new URL(url);
      // A remote reference must never be interpreted as a path on this machine.
      if (parsed.searchParams.has('remoteHostId') || parsed.username || parsed.password) throw unavailable();
      if (parsed.searchParams.has('path')) {
        if (!['', 'local', 'open'].includes(parsed.hostname)) throw unavailable();
        value = parsed.searchParams.get('path')!;
        if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) throw unavailable();
      } else {
        try { value = fileURLToPath(url.replace(/^xdt-file:/i, 'file:')); }
        catch (error) {
          // Legacy hostless direct paths may contain an unencoded percent sign.
          // Match the existing decode-once-or-literal contract, without turning
          // a rejected host/network URL into a local path.
          if (!(error instanceof URIError) || !/^xdt-file:\/\/\//i.test(url)) throw error;
          value = url.slice('xdt-file://'.length).split(/[?#]/, 1)[0]!;
          if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
        }
      }
    } else if (/^file:/i.test(url)) {
      try { value = fileURLToPath(url); }
      catch (error) {
        if (!(error instanceof URIError) || !['', 'localhost'].includes(new URL(url).hostname)) throw error;
        // Match the existing literal-percent compatibility without admitting remote hosts.
        const literal = /^file:(?:\/\/(?:localhost)?)?(\/[^?#]*)/i.exec(url)?.[1];
        if (!literal) throw error;
        value = literal;
        if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
      }
    } else {
      // Match ordinary Markdown lookup without decoding protocol/query paths twice.
      const decoded = safeDecodeHrefForLookup(url);
      if (decoded === null) throw unavailable();
      value = decoded;
    }
  } catch { throw unavailable(); }
  // Never resolve a network/device path, including on another host platform.
  if (isNetworkOrDevicePath(value) || value.includes('\0')) throw unavailable();
  if (/^[A-Za-z]:/.test(value) && process.platform !== 'win32') throw unavailable();
  return path.resolve(workDir, value);
}

/** One descriptor, bounded reads and inode checks keep a symlink swap from exporting another file. */
export async function readReplyFile(source: string, root: string, assertCurrent: () => void): Promise<Buffer> {
  assertCurrent();
  if (!isPathWithin(root, source)) throw unavailable();
  const real = await fs.realpath(source);
  if (!isPathWithin(root, real)) throw unavailable();
  const expected = await fs.stat(real, { bigint: true });
  // A hard link can point to an inode also named outside this task directory.
  // realpath cannot prove that all of its other names are in scope.
  if (expected.nlink !== 1n) throw unavailable();
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    const checked = await fs.realpath(source);
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_BYTES)) throw unavailable();
    if (before.ino === 0n || expected.ino !== before.ino || expected.dev !== before.dev || checked !== real) throw unavailable();
    assertCurrent();
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw unavailable();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw unavailable();
    assertCurrent();
    return buffer;
  } finally { await handle.close(); }
}

type ReplyFiles = { text: string; attachments: ChatUploadAttachment[]; refusal?: 'outside-working-dir' };

/** Files stay outside the media store; the existing group uploader receives authorized bytes. */
export async function prepareChatReplyFiles(text: string, sessionId: string, assertExecution: () => void, fallbackMessageClientId?: string | null): Promise<ReplyFiles> {
  const snapshot = getCurrentDbClientSnapshot();
  let markdown = text;
  if (fallbackMessageClientId) {
    if (!snapshot) throw unavailable();
    const [row] = await snapshot.client.drizzle.select({ content: messages.content }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, fallbackMessageClientId),
        eq(messages.role, 'assistant'), isNull(messages.rewindAt))).limit(1);
    if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('OWNER_CHANGED');
    // The existing search projection flattens newlines. Only file delivery needs the
    // original Markdown; scheduling and replies without file links keep their old input.
    markdown = row ? visibleMessageText('assistant', row.content, { preserveWhitespace: true }) : text;
  }
  const parsed = replyFileLinks(markdown);
  if (!parsed.links.length) return { text, attachments: [] as ChatUploadAttachment[] };
  if (!snapshot) throw unavailable();
  const assertCurrent = () => {
    assertExecution();
    if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('OWNER_CHANGED');
  };
  const readSession = async () => {
    const [row] = await snapshot.client.drizzle.select({ workingDir: sessions.workingDir,
      remoteHostId: sessions.remoteHostId, status: sessions.status, clearedAt: sessions.clearedAt })
      .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    assertCurrent();
    if (!row?.workingDir || row.remoteHostId || row.status === 'deleted') throw unavailable();
    return row;
  };
  const scope = await readSession();
  const root = await fs.realpath(scope.workingDir!);
  assertCurrent();
  // Only this expected path refusal permits a text-only settlement. Preserve the
  // exact Markdown we inspected, including saved replies with original whitespace.
  const outside = (): ReplyFiles => {
    assertCurrent();
    return { text: markdown, attachments: [], refusal: 'outside-working-dir' };
  };
  const attachments: ChatUploadAttachment[] = [];
  const seen = new Set<string>();
  const imageSources = new Set<string>();
  if (parsed.links.length > BOT_GROUP_ATTACHMENTS_MAX) {
    const inspected = new Set<string>();
    for (const ref of taskImageReferences(parsed.text)) {
      const local = localTaskImagePath(ref.url);
      if (!local || isNetworkOrDevicePath(local) || inspected.has(ref.url)) continue;
      inspected.add(ref.url);
      const real = await fs.realpath(local).catch(() => undefined);
      assertCurrent();
      if (real && isPathWithin(root, real)) imageSources.add(real);
    }
  }
  let fileCount = 0;
  for (const link of parsed.links) {
    const source = localPath(link.url, scope.workingDir!);
    // /tmp can alias /private/tmp; normalize the trusted workdir prefix without following the file.
    const lexicalRoot = path.resolve(scope.workingDir!);
    let canonicalSource: string;
    if (!isPathWithin(lexicalRoot, source) && !isPathWithin(root, source)) {
      // Case aliases depend on the actual volume. Only an existing canonical
      // target within this task can override the lexical precheck.
      if (!isPathWithin(lexicalRoot.toLowerCase(), source.toLowerCase())
        && !isPathWithin(root.toLowerCase(), source.toLowerCase())) return outside();
      canonicalSource = await fs.realpath(source).catch(() => { throw unavailable(); });
      assertCurrent();
      if (!isPathWithin(root, canonicalSource)) return outside();
    } else canonicalSource = isPathWithin(root, source) ? source : path.resolve(root, path.relative(lexicalRoot, source));
    // Use the actual volume's inode identity (including case-insensitive APFS),
    // not a platform-wide casing assumption. Never follow the named symlink;
    // full realpath/descriptor containment is still enforced before reading.
    let identity = canonicalSource;
    let singleFile = false;
    let symbolic = false;
    try {
      const stat = await fs.lstat(canonicalSource, { bigint: true });
      if (stat.isFile() && stat.ino !== 0n) identity = `${stat.dev}:${stat.ino}`;
      singleFile = stat.isFile() && stat.nlink === 1n && stat.ino !== 0n;
      symbolic = stat.isSymbolicLink();
    } catch (error) {
      // Preserve deferred missing-file failure and the shared count limit.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    assertCurrent();
    if (!symbolic && seen.has(identity)) continue;
    // Metadata only: bytes still require the live authority and descriptor checks below.
    const candidate = singleFile || symbolic ? await fs.realpath(canonicalSource).catch(() => undefined) : undefined;
    assertCurrent();
    if (symbolic && candidate && isPathWithin(root, candidate)) {
      // Both existing readers accept in-root symlinks. Reconcile only a real,
      // ordinary single-link target; an escape or hard link must retain its reader.
      const target = await fs.lstat(candidate, { bigint: true }).catch(() => undefined);
      assertCurrent();
      singleFile = !!target?.isFile() && target.nlink === 1n && target.ino !== 0n;
      if (singleFile) identity = `${target!.dev}:${target!.ino}`;
    }
    if (seen.has(identity)) continue;
    const realSource = singleFile && candidate && isPathWithin(root, candidate) ? candidate : undefined;
    // Only potential rendered-image aliases defer counting to the validated
    // image merger. Independent files still fail at the existing limit here.
    if (!realSource || !imageSources.has(realSource)) {
      if (fileCount >= BOT_GROUP_ATTACHMENTS_MAX) throw unavailable();
      fileCount++;
    }
    seen.add(identity);
    let digest: string | undefined;
    attachments.push({ id: canonicalSource, sourceOffset: link.outputStart, name: path.basename(source), category: 'file',
      sourceUrl: link.url,
      sourcePaths: realSource ? [realSource] : [],
      mimeType: path.extname(source).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream',
      size: 0, path: null, url: null, assertCurrent,
      readBytes: async () => {
        const current = await readSession();
        if (current.workingDir !== scope.workingDir || current.clearedAt !== scope.clearedAt
          || await fs.realpath(current.workingDir!) !== root) throw unavailable();
        const bytes = await readReplyFile(canonicalSource, root, assertCurrent);
        const next = createHash('sha256').update(bytes).digest('hex');
        if (digest && digest !== next) throw unavailable();
        digest = next;
        return bytes;
      } });
  }
  return { text: parsed.text, attachments };
}
