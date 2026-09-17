import { createServer, type Server } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { createReadStream, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createFileReadQueue } from '@cindy/device-link';
import { HTML_SNAPSHOT_CSP, withSnapshotHtmlCsp } from '@cindy/maker-shared/file-preview';
import type { DirEntry } from '@cindy/file-browser-core';
import { toWorkdirRel } from '../../shared/workdirPath.js';

export interface HtmlPreviewArgs {
  origin:
    | { kind: 'local' }
    | { kind: 'device'; deviceId: string }
    | { kind: 'ssh'; remoteHostId: string };
  workdir: string;
  absPath: string;
}
export interface PreviewSource {
  isCurrent?(): boolean;
  onResourceError?(status: number): void;
  stat(root: string, rel: string): Promise<Omit<DirEntry, 'name'>>;
  read(root: string, entry: DirEntry, signal?: AbortSignal): Promise<string>;
  /** Media goes through the existing managed store; other files are copied into staging. */
  materialize(source: string, destination: string, expectedSize: number): Promise<string>;
}


/** Copy a fixed-size ordinary file, refusing growth and symlink substitution. */
export async function copyPreviewFile(
  source: string,
  destination: string,
  expectedSize: number,
): Promise<void> {
  const before = await fs.lstat(source);
  if (!before.isFile()) throw new Error('PREVIEW_CHANGED');
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await input.stat();
    if (
      !stat.isFile() ||
      stat.size !== expectedSize ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino
    )
      throw new Error('PREVIEW_CHANGED');
    const space = await fs.statfs(path.dirname(destination));
    if (space.bavail * space.bsize < expectedSize + 256 * 1024 * 1024) throw new Error('PREVIEW_DISK_FULL');
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < expectedSize) {
        const { bytesRead } = await input.read(
          buffer,
          0,
          Math.min(buffer.length, expectedSize - offset),
          offset,
        );
        if (!bytesRead) throw new Error('PREVIEW_CHANGED');
        await output.writeFile(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await input.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error('PREVIEW_CHANGED');
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};
export function previewLocation(args: HtmlPreviewArgs): { root: string; entry: string } {
  if (
    !args ||
    typeof args.absPath !== 'string' ||
    typeof args.workdir !== 'string' ||
    !args.origin ||
    !['local', 'device', 'ssh'].includes(args.origin.kind)
  )
    throw new Error('BAD_ARGS');
  if (args.origin.kind === 'device' && !args.origin.deviceId) throw new Error('BAD_ARGS');
  if (args.origin.kind === 'ssh' && !args.origin.remoteHostId) throw new Error('BAD_ARGS');
  const p = /^[A-Za-z]:[\\/]|^\\\\/.test(args.absPath) ? path.win32 : path.posix;
  if (
    !p.isAbsolute(args.absPath) ||
    !/\.(html?|xhtml)$/i.test(args.absPath) ||
    args.absPath.includes('\0')
  ) {
    throw new Error('BAD_ARGS');
  }
  if (args.origin.kind === 'ssh' && !toWorkdirRel(args.workdir, args.absPath))
    throw new Error('OUTSIDE_WORKDIR');
  return { root: p.dirname(args.absPath), entry: p.basename(args.absPath) };
}

/** Fetch only requested resources. A failed resource never invalidates another page. */
export async function createHtmlPreview(args: HtmlPreviewArgs, source: PreviewSource) {
  const { root, entry } = previewLocation(args);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-html-preview-'));
  let server: Server | undefined;
  let closed = false;
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const queue = createFileReadQueue();
  const materialized = new Map<string, { path: string; size: number }>();
  const current = () => !closed && source.isCurrent?.() !== false;
  const close = async () => {
    closed = true;
    controller.abort();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    // Shared cache fills may finish after cancellation; never delete their destination mid-write.
    void Promise.allSettled([...pending])
      .then(() => fs.rm(staging, { recursive: true, force: true }))
      .catch(() => { /* Temporary storage can be reclaimed by the OS if cleanup fails. */ });
  };
  try {
    const initial = await source.stat(root, entry);
    if (initial.type !== 'file') throw new Error('NOT_FOUND');
    const materialize = async (relPath: string, directory: string, signal: AbortSignal) => {
      if (!current() || signal.aborted) throw new Error('PREVIEW_CANCELLED');
      const metadata = await source.stat(root, relPath);
      if (metadata.type !== 'file' || metadata.relPath !== relPath || !Number.isSafeInteger(metadata.size) || metadata.size < 0)
        throw new Error('NOT_FOUND');
      const file = { ...metadata, name: relPath.split('/').pop()! };
      const sourcePath = await source.read(root, file, signal);
      if (!current() || signal.aborted) throw new Error('PREVIEW_CANCELLED');
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile() || stat.size !== file.size) throw new Error('PREVIEW_CHANGED');
      const dest = path.join(directory, 'asset');
      const materialized = await source.materialize(sourcePath, dest, file.size);
      if ((await fs.stat(materialized)).size !== file.size) throw new Error('PREVIEW_CHANGED');
      // Guard HTML documents, including secondary pages, before publishing the snapshot.
      // Copy guarded HTML into this snapshot even if materialize returned a shared cache path.
      // XML documents retain their parser/MIME and use the response CSP, not an HTML prolog.
      let assetPath = materialized;
      let assetSize = stat.size;
      if (/\.html?$/i.test(file.relPath)) {
        const original = await fs.readFile(materialized);
        let html: string | undefined;
        try {
          html = new TextDecoder('utf-8', { fatal: true }).decode(original);
        } catch {
          // Preserve legacy encodings; the response CSP still applies to these documents.
        }
        // Do not reinterpret UTF-16 or a document declaring a different encoding as UTF-8.
        const charsets = html?.matchAll(/charset\s*=\s*["']?\s*([^\s"'/>;]+)/gi);
        if (
          html !== undefined &&
          !html.includes('\0') &&
          [...(charsets ?? [])].every((match) => /^utf-?8$/i.test(match[1]))
        ) {
          const guarded = withSnapshotHtmlCsp(html);
          await fs.writeFile(dest, guarded, { encoding: 'utf8', mode: 0o600 });
          assetPath = dest;
          assetSize = Buffer.byteLength(guarded);
        }
      }
      if (!current() || signal.aborted) throw new Error('PREVIEW_CANCELLED');
      return { path: assetPath, size: assetSize };
    };
    const token = randomBytes(24).toString('hex');
    const cookieName = `cindy_preview_${token}`;
    let origin = '';
    server = createServer((req, res) => {
      res.setHeader('Content-Security-Policy', HTML_SNAPSHOT_CSP);
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const deny = (status: number) => {
        res.writeHead(status);
        res.end();
      };
      if (!current()) return deny(410);
      if (req.headers.host !== origin.slice('http://'.length)) return deny(403);
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405);
      if (
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] &&
          !['none', 'same-origin'].includes(String(req.headers['sec-fetch-site'])))
      )
        return deny(403);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', origin);
      } catch {
        return deny(400);
      }
      if (url.pathname === `/${token}/`) {
        res.setHeader('Set-Cookie', `${cookieName}=1; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(302, { Location: '/' + encodeURIComponent(entry) });
        res.end();
        return;
      }
      if (!(req.headers.cookie ?? '').split(';').some((c) => c.trim() === `${cookieName}=1`))
        return deny(403);
      if (req.headers.referer) {
        try {
          if (new URL(req.headers.referer).origin !== origin) return deny(403);
        } catch {
          return deny(403);
        }
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return deny(400);
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      const relPath = pathname.slice(1);
      if (!relPath || /[\\:\0\r\n]/.test(relPath) || relPath.split('/').some((part) => !part || part.startsWith('.')))
        return deny(404);
      const requestController = new AbortController();
      res.once('close', () => requestController.abort());
      const signal = AbortSignal.any([controller.signal, requestController.signal]);
      const work = queue('preview', async () => {
        let asset = materialized.get(relPath);
        if (!asset) {
          const directory = await fs.mkdtemp(path.join(staging, 'request-'));
          try {
            asset = await materialize(relPath, directory, signal);
            materialized.set(relPath, asset);
          } catch (error) {
            await fs.rm(directory, { recursive: true, force: true });
            throw error;
          }
        }
        if (res.destroyed || !current()) return;
        res.setHeader('Content-Type', MIME[path.extname(pathname).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Content-Length', asset.size);
        if (req.method === 'HEAD') { res.end(); return; }
        await pipeline(createReadStream(asset.path), res);
      }, signal);
      pending.add(work);
      void work.catch((error) => {
        if (res.destroyed) return;
        if (res.headersSent) { res.destroy(); return; }
        const message = error instanceof Error ? error.message : '';
        const status = /NOT_FOUND|ENOENT/.test(message) ? 404 : /TOO_LARGE/.test(message) ? 413 : 502;
        source.onResourceError?.(status);
        deny(status);
      }).finally(() => pending.delete(work));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject);
        resolve();
      });
    });
    server.unref();
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (source.isCurrent && !source.isCurrent()) throw new Error('PREVIEW_CANCELLED');
    return { url: `${origin}/${token}/`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
