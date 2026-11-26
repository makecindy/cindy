import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ghostNetworkHostMatches, type InstalledGhost } from '../../shared/ghost.js';
import type { DownloadOptions, DownloadRequest, DownloadResult } from '../downloader/index.js';
import { DownloadError } from '../downloader/types.js';
import type { createOutboundTransport } from '../maker-host/outbound-fetch.js';
import { PluginDownloadCache } from './downloadCache.js';

const MAX_DOWNLOAD_BYTES = 8 * 1024 ** 3;

/**
 * Whole-artifact size declared by a 200/206 response and the offset its body starts at, or
 * null. Used only when the plugin omits `bytes`: the size must be known before any byte is
 * written so the cache budget is reserved up front. Re-encoded bodies (the downloader asks
 * for identity) are rejected rather than guessed.
 */
function declaredArtifactSize(response: Response): { total: number; start: number } | null {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return null;
  if (response.status === 206) {
    const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    return range ? { total: Number(range[2]), start: Number(range[1]) } : null;
  }
  const length = response.headers.get('content-length')?.trim() ?? '';
  return /^\d+$/.test(length) ? { total: Number(length), start: 0 } : null;
}

/**
 * The downloader caps writes only by `expectedSize` / `maxBytes`, which an omitted size leaves
 * at 8 GiB. A response may omit Content-Length (a 206 relies on Content-Range alone) and keep
 * sending, so stop the body itself once it passes what the response declared: never write
 * more than was reserved.
 */
function capResponseBody(response: Response, limit: number): Response {
  if (!response.body) return response;
  let seen = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit)
          controller.error(new DownloadError('SIZE', 'Download exceeds the size the response declared'));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Verified public artifacts, in the requesting plugin's host-managed cache only. */
export interface PluginDownloadDeps {
  guardedFetch: ReturnType<typeof createOutboundTransport>['guardedOutboundFetch'];
  getGhost(id: string): InstalledGhost | null;
  root(id: string): string;
  scope(): string;
  send(id: string, event: unknown): void;
  download(options: DownloadOptions): Promise<DownloadResult>;
}
export class PluginDownloadSlot {
  private stopped = false;
  private cache = new PluginDownloadCache();
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<unknown>; fingerprint: string; current: () => boolean }
  >();
  constructor(private deps: PluginDownloadDeps) {}
  abortAll() {
    this.cache.revokeAll();
    for (const item of this.active.values()) item.controller.abort();
  }
  async stopAndWait() {
    this.stopped = true;
    this.abortAll();
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
  }
  async removePlugin(id: string, root = this.deps.root(id), scope = this.deps.scope()) {
    const work = [...this.active].filter(([key]) => {
      const parts = JSON.parse(key);
      return parts[0] === scope && parts[1] === id;
    });
    for (const [, item] of work) item.controller.abort();
    await Promise.allSettled(work.map(([, item]) => item.promise));
    try {
      const parent = await fs.realpath(path.dirname(root));
      await this.cache.removePlugin(path.join(parent, path.basename(root)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async withNodeDownloads(
    id: string,
    payload: Record<string, unknown>,
    run: (payload: unknown) => Promise<unknown>,
    callerActive: () => boolean = () => true,
  ) {
    if (this.stopped || !callerActive())
      return { ok: false, errorCode: 'INVALID_REQUEST', message: '下载服务已停止' };
    if (payload.downloadTokens === undefined) return run(payload);
    const releases: Array<() => void> = [];
    try {
      const tokens = payload.downloadTokens;
      if (
        !tokens ||
        typeof tokens !== 'object' ||
        Array.isArray(tokens) ||
        Object.keys(tokens).length > 32
      )
        throw Error('Invalid download receipts');
      if (
        payload.params !== undefined &&
        (!payload.params ||
          typeof payload.params !== 'object' ||
          Array.isArray(payload.params) ||
          Object.hasOwn(payload.params, 'downloads'))
      )
        throw Error('Invalid download params');
      const scope = this.deps.scope(),
        ghost = this.deps.getGhost(id);
      if (!ghost?.enabled || !ghost.manifest.node) throw Error('Plugin unavailable');
      const approval = JSON.stringify(ghost.approval);
      const downloads: Record<string, string> = {};
      for (const [name, token] of Object.entries(tokens)) {
        if (
          !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(name) ||
          ['constructor', 'prototype', '__proto__'].includes(name) ||
          typeof token !== 'string'
        )
          throw Error('Invalid download receipt');
        const lease = await this.cache.acquire(token, scope, id, approval);
        releases.push(lease.release);
        downloads[name] = lease.path;
      }
      if (
        this.stopped ||
        !callerActive() ||
        this.deps.scope() !== scope ||
        !this.deps.getGhost(id)?.enabled ||
        JSON.stringify(this.deps.getGhost(id)?.approval) !== approval
      )
        throw Error('Plugin changed');
      const { downloadTokens: _tokens, ...request } = payload;
      return await run({
        ...request,
        params: { ...((payload.params as object) ?? {}), downloads },
      });
    } catch {
      return {
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: '下载凭据已失效，请重新获取文件后重试',
      };
    } finally {
      for (const release of releases) release();
    }
  }
  async handle(
    id: string,
    value: unknown,
    callerActive: () => boolean = () => true,
  ): Promise<unknown> {
    try {
      if (this.stopped) throw Error('Download service stopped');
      if (!value || typeof value !== 'object') throw Error('Invalid download request');
      const p = value as Record<string, unknown>;
      if (typeof p.id !== 'string' || !/^[\w-]{1,100}$/.test(p.id))
        throw Error('Invalid download id');
      const scope = this.deps.scope(),
        key = JSON.stringify([scope, id, p.id]);
      if (p.kind === 'cancel') {
        const item = this.active.get(key);
        item?.controller.abort();
        await item?.promise;
        return { ok: true };
      }
      if (
        p.kind !== 'start' ||
        Object.keys(p).some((k) => !['type', 'kind', 'id', 'url', 'sha256', 'bytes'].includes(k))
      )
        throw Error('Invalid download request');
      // `bytes` is optional: publishers often sign only a SHA-256 (e.g. a release manifest),
      // and looking the size up elsewhere can hit third-party rate limits. Without it the
      // size comes from the response headers; the SHA-256 still decides what is accepted.
      if (
        typeof p.url !== 'string' ||
        p.url.length > 8192 ||
        typeof p.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.sha256) ||
        (p.bytes !== undefined &&
          (!Number.isSafeInteger(p.bytes) ||
            (p.bytes as number) < 1 ||
            (p.bytes as number) > MAX_DOWNLOAD_BYTES))
      )
        throw Error('URL and SHA-256 are required; a given size must be exact (up to 8 GiB)');
      const declaredBytes = p.bytes as number | undefined;
      const ghost = this.deps.getGhost(id);
      if (!ghost?.enabled || !ghost.manifest.node || !ghost.manifest.network?.hosts.length)
        throw Error('Download requires node and network.hosts declarations');
      const approval = JSON.stringify(ghost.approval);
      const current = () =>
        !this.stopped &&
        callerActive() &&
        this.deps.scope() === scope &&
        this.deps.getGhost(id)?.enabled === true &&
        JSON.stringify(this.deps.getGhost(id)?.approval) === approval;
      const validateUrl = (raw: string) => {
        if (!current()) throw Error('Download owner or plugin changed');
        const u = new URL(raw);
        if (
          raw.length > 8192 ||
          /[\u0000-\u0020\u007f]/.test(raw) ||
          u.protocol !== 'https:' ||
          u.port ||
          u.username ||
          u.password ||
          !ghost.manifest.network!.hosts.some((h) => ghostNetworkHostMatches(h, u.hostname))
        )
          throw Error('Download URL is outside declared HTTPS hosts');
      };
      validateUrl(p.url);
      const isUrlAllowed = (raw: string) => {
        try {
          validateUrl(raw);
          return true;
        } catch {
          return false;
        }
      };
      const fingerprint = JSON.stringify([p.url, p.sha256, p.bytes]);
      const existing = this.active.get(key);
      if (existing) {
        if (!existing.current()) {
          existing.controller.abort();
          await existing.promise;
          return this.handle(id, value, callerActive);
        }
        if (existing.fingerprint !== fingerprint) throw Error('Download id already in use');
        return existing.promise;
      }
      if (this.active.size >= 8) throw Error('Too many active downloads');
      const controller = new AbortController();
      // Transport bytes may reset when a server ignores Range on retry. Keep
      // display progress stable without changing the bytes used for validation.
      let displayedLoaded = 0;
      // The exact size: declared by the plugin, or learned from the first full/partial
      // response and then required to stay the same for every reconnection.
      let size = declaredBytes;
      const emit = (data: Record<string, unknown>) => {
        if (current())
          this.deps.send(id, {
            type: 'event',
            name: 'download-progress',
            data: { id: p.id, ...data },
          });
      };
      const promise = (async () => {
        // Distinct operations cannot share the first caller's signal or progress callback.
        const suppliedRoot = this.deps.root(id);
        // Host-selected ancestors may use aliases (e.g. /var on macOS). Resolve
        // only that trusted parent; plugin/artifact entries still reject symlinks.
        await fs.mkdir(path.dirname(suppliedRoot), { recursive: true });
        const root = path.join(
            await fs.realpath(path.dirname(suppliedRoot)),
            path.basename(suppliedRoot),
          ),
          dir = path.join(
            root,
            createHash('sha256')
              .update(JSON.stringify([scope, p.id, fingerprint]))
              .digest('hex'),
          );
        // An unknown size starts with the entry overhead only; the request hook reserves the
        // real size once the response declares it, before the downloader writes any byte.
        await this.cache.reserve(path.dirname(root), dir, declaredBytes ?? 0);
        try {
          if ((await fs.realpath(dir)) !== path.resolve(dir))
            throw Error('Download cache must not contain symbolic links');
          const targetPath = path.join(dir, 'artifact');
          for (const file of [targetPath, targetPath + '.part', targetPath + '.meta.json']) {
            try {
              if (!(await fs.lstat(file)).isFile()) throw Error('Unsafe download cache entry');
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
          }
          if (!current() || controller.signal.aborted) throw Error('Download cancelled');
          emit({
            phase: 'queued',
            loaded: 0,
            ...(declaredBytes === undefined ? {} : { total: declaredBytes }),
            speedBps: 0,
          });
          const watch = setInterval(() => {
            if (!current()) controller.abort();
          }, 250);
          const reserveReplacement = async (bytes: number) => {
            try {
              await this.cache.reserve(path.dirname(root), dir, bytes, true);
            } catch {
              throw new DownloadError('SIZE', 'Download cache cannot reserve replacement space');
            }
          };
          // Plugin-supplied URLs: one SSRF-guarded hop at a time (DNS pinning, HTTPS only,
          // no ambient cookies), re-checking the owner before every connection.
          const request: DownloadRequest = async (url, init) => {
            controller.signal.throwIfAborted();
            // Cache hits never reach this callback. On a miss, the old target
            // remains beside the growing .part until the downloader publishes it.
            if (size !== undefined) await reserveReplacement(size);
            const sent = await this.deps.guardedFetch(url, { ...init, credentials: 'omit' }, () => {
              controller.signal.throwIfAborted();
              // A revoked owner is final: do not let the downloader retry this hop.
              if (!isUrlAllowed(url))
                throw new DownloadError('URL_POLICY', 'Download URL is not allowed');
            });
            const status = sent.response.status;
            if (declaredBytes !== undefined || (status !== 200 && status !== 206)) return sent;
            // The downloader only writes after this returns, so a missing, oversized or
            // changed size (the file was replaced between attempts) never reaches disk.
            try {
              const declared = declaredArtifactSize(sent.response);
              if (
                declared === null ||
                declared.total < 1 ||
                declared.total > MAX_DOWNLOAD_BYTES ||
                declared.start >= declared.total ||
                (size !== undefined && declared.total !== size)
              )
                throw new DownloadError('SIZE', 'Download response does not declare a usable size');
              if (size === undefined) {
                await reserveReplacement(declared.total);
                size = declared.total;
              }
              return {
                ...sent,
                response: capResponseBody(sent.response, declared.total - declared.start),
              };
            } catch (error) {
              await sent.response.body?.cancel().catch(() => {});
              await sent.release?.();
              throw error;
            }
          };
          try {
            const result = await this.deps.download({
              url: p.url as string,
              targetPath,
              sha256: p.sha256 as string,
              expectedSize: declaredBytes,
              maxBytes: declaredBytes ?? MAX_DOWNLOAD_BYTES,
              timeout: { totalMs: 2 * 60 * 60 * 1000 },
              isUrlAllowed,
              request,
              signal: controller.signal,
              logger: { debug() {}, info() {}, warn() {}, error() {} },
              onProgress: (e) => {
                const total = size ?? e.total;
                displayedLoaded = Math.max(displayedLoaded, Math.min(e.loaded, total ?? e.loaded));
                emit({
                  phase: 'downloading',
                  ...e,
                  loaded: displayedLoaded,
                  total,
                  percent: total ? (displayedLoaded / total) * 100 : null,
                });
              },
              onVerifying: () =>
                emit({
                  phase: 'verifying',
                  ...(size === undefined ? {} : { loaded: size, total: size }),
                  speedBps: 0,
                }),
              onRetry: (e) => emit({ phase: 'retrying', attempt: e.attempt, delayMs: e.delayMs }),
            });
            if (!current() || controller.signal.aborted) throw Error('Download cancelled');
            // A verified cache hit never connects, so only a fresh transfer has a learned size.
            const expectedSize = declaredBytes ?? (result.fromCache ? undefined : size);
            if (expectedSize !== undefined && result.size !== expectedSize)
              throw Error('Downloaded size mismatch');
            const token = await this.cache.issue(dir, scope, id, approval);
            if (!current() || controller.signal.aborted) throw Error('Plugin changed');
            emit({
              phase: 'completed',
              loaded: result.size,
              total: result.size,
              speedBps: 0,
              fromCache: result.fromCache,
            });
            return {
              ok: true,
              token,
              bytes: result.size,
              sha256: result.sha256,
              fromCache: result.fromCache,
            };
          } finally {
            clearInterval(watch);
          }
        } finally {
          this.cache.release(dir);
        }
      })()
        .catch(() => {
          emit({ phase: controller.signal.aborted ? 'cancelled' : 'failed' });
          return {
            ok: false,
            message: controller.signal.aborted
              ? '下载已取消'
              : '下载失败，请重试（网络、权限或文件校验未通过）',
          };
        })
        .finally(() => this.active.delete(key));
      this.active.set(key, { controller, promise, fingerprint, current });
      return promise;
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
