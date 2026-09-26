import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ghostNetworkHostMatches, type InstalledGhost } from '../../shared/ghost.js';
import type { DownloadOptions, DownloadResult } from '../downloader/index.js';
import { PluginDownloadCache } from './downloadCache.js';

/** Verified public artifacts, in the requesting plugin's host-managed cache only. */
export interface PluginDownloadDeps {
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
    { controller: AbortController; promise: Promise<unknown>; fingerprint: string }
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
  ) {
    if (this.stopped) return { ok: false, errorCode: 'INVALID_REQUEST', message: '下载服务已停止' };
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
        this.active.get(key)?.controller.abort();
        return { ok: true };
      }
      if (
        p.kind !== 'start' ||
        Object.keys(p).some((k) => !['type', 'kind', 'id', 'url', 'sha256', 'bytes'].includes(k))
      )
        throw Error('Invalid download request');
      if (
        typeof p.url !== 'string' ||
        p.url.length > 8192 ||
        typeof p.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.sha256) ||
        !Number.isSafeInteger(p.bytes) ||
        (p.bytes as number) < 1 ||
        (p.bytes as number) > 2 ** 31
      )
        throw Error('URL, SHA-256 and exact size (up to 2 GiB) are required');
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
      const fingerprint = JSON.stringify([p.url, p.sha256, p.bytes]);
      const existing = this.active.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw Error('Download id already in use');
        return existing.promise;
      }
      if (this.active.size >= 8) throw Error('Too many active downloads');
      const controller = new AbortController();
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
        await this.cache.reserve(path.dirname(root), dir, p.bytes as number);
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
          emit({ phase: 'queued', loaded: 0, total: p.bytes, speedBps: 0 });
          const watch = setInterval(() => {
            if (!current()) controller.abort();
          }, 250);
          try {
            const result = await this.deps.download({
              streaming: true,
              url: p.url as string,
              targetPath,
              sha256: p.sha256 as string,
              expectedSize: p.bytes as number,
              maxBytes: p.bytes as number,
              validateUrl,
              signal: controller.signal,
              logger: { debug() {}, info() {}, warn() {}, error() {} },
              onProgress: (e) => emit({ phase: 'downloading', ...e }),
              onVerifying: () =>
                emit({ phase: 'verifying', loaded: p.bytes, total: p.bytes, speedBps: 0 }),
              onRetry: (e) => emit({ phase: 'retrying', attempt: e.attempt, delayMs: e.delayMs }),
            });
            if (!current() || controller.signal.aborted) throw Error('Download cancelled');
            if (result.size !== p.bytes) throw Error('Downloaded size mismatch');
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
      this.active.set(key, { controller, promise, fingerprint });
      return promise;
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
