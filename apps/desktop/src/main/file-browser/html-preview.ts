import { createServer, type Server } from 'node:http';
import { createReadStream, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
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
  list(root: string, rel: string): Promise<DirEntry[]>;
  read(root: string, entry: DirEntry): Promise<string>;
  /** Media goes through the existing managed store; other files are copied into staging. */
  materialize(source: string, destination: string, expectedSize: number): Promise<string>;
}
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 2000;

/** Copy a fixed-size ordinary file, refusing growth and symlink substitution. */
export async function copyPreviewFile(source: string, destination: string, expectedSize: number): Promise<void> {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size !== expectedSize) throw new Error('PREVIEW_CHANGED');
    const output = await fs.open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < expectedSize) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, expectedSize - offset), offset);
        if (!bytesRead) throw new Error('PREVIEW_CHANGED');
        await output.writeFile(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await input.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('PREVIEW_CHANGED');
    } finally { await output.close(); }
  } finally { await input.close(); }
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

/** One bounded immutable snapshot per open. Never publish a partially fetched tree. */
export async function createHtmlPreview(args: HtmlPreviewArgs, source: PreviewSource) {
  const { root, entry } = previewLocation(args);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-html-preview-'));
  let server: Server | undefined;
  const close = async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await fs.rm(staging, { recursive: true, force: true });
  };
  try {
    const pending = [''];
    const files: DirEntry[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    while (pending.length) {
      if (source.isCurrent && !source.isCurrent()) throw new Error('PREVIEW_CANCELLED');
      const rel = pending.pop()!;
      if (rel.split('/').length > 32) throw new Error('PREVIEW_TOO_LARGE');
      for (const item of await source.list(root, rel)) {
        const expected = rel ? `${rel}/${item.name}` : item.name;
        if (
          !item.name ||
          /[\\/:\0]/.test(item.name) ||
          item.name === '.' ||
          item.name === '..' ||
          item.relPath !== expected ||
          seen.has(expected) ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0
        ) {
          throw new Error('BAD_ARGS');
        }
        // Publishing a snapshot has a separate policy from browsing files.
        // Hidden files remain browsable, but are not automatically served to a web page.
        if (item.name.startsWith('.')) continue;
        seen.add(expected);
        if (seen.size > MAX_ENTRIES) throw new Error('PREVIEW_TOO_LARGE');
        if (item.type === 'directory') pending.push(expected);
        else if (item.type === 'file') {
          bytes += item.size;
          if (bytes > MAX_BYTES) throw new Error('PREVIEW_TOO_LARGE');
          files.push(item);
        } else throw new Error('BAD_ARGS');
      }
    }
    if (!files.some((file) => file.relPath === entry)) throw new Error('NOT_FOUND');
    const assets = new Map<string, { path: string; size: number }>();
    for (const file of files) {
      if (source.isCurrent && !source.isCurrent()) throw new Error('PREVIEW_CANCELLED');
      const sourcePath = await source.read(root, file);
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile() || stat.size !== file.size) throw new Error('PREVIEW_CHANGED');
      const dest = path.join(staging, ...file.relPath.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const materialized = await source.materialize(sourcePath, dest, file.size);
      if ((await fs.stat(materialized)).size !== file.size) throw new Error('PREVIEW_CHANGED');
      assets.set('/' + file.relPath, { path: materialized, size: stat.size });
    }
    const token = randomBytes(24).toString('hex');
    const cookieName = `cindy_preview_${token}`;
    let origin = '';
    server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const deny = (status: number) => {
        res.writeHead(status);
        res.end();
      };
      if (source.isCurrent && !source.isCurrent()) return deny(410);
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
      const asset = assets.get(pathname);
      if (!asset) return deny(404);
      res.setHeader(
        'Content-Type',
        MIME[path.extname(pathname).toLowerCase()] ?? 'application/octet-stream',
      );
      res.setHeader('Content-Length', asset.size);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(asset.path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
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
