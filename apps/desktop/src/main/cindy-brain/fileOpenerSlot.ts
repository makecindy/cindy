/**
 * 把用户在 Cindy 里「用系统默认应用打开」的本机文件,先交给声明了该扩展名的插件。
 *
 * 只挑已启用、声明了 node 与 `fileOpener`、且用户没在详情里关掉的插件;唤醒它的逻辑页,
 * 发 `open-file` 事件,等它回 `file-open-result`。没有候选、投递失败、插件回 ok:false 或
 * 超时,一律返回未处理,由调用方照常交给系统默认应用——插件不可用时不能让文件打不开。
 * 回执只认发出请求的同一插件实例(发送方由 Main 按 webContents 反查,不信自报)。
 */

import { randomUUID } from 'node:crypto';

import { ghostFileOpenerMatches } from '@cindy/plugin-protocol';

import type { InstalledGhost } from '../../shared/ghost.js';

/** 含唤醒插件逻辑页的时间;插件只需在交给本机应用后回执,不必等窗口画出。 */
export const GHOST_FILE_OPEN_TIMEOUT_MS = 15_000;

export interface GhostFileOpenerDeps {
  listGhosts(): InstalledGhost[];
  instanceId(ghost: InstalledGhost): string;
  isEnabledByUser(instanceId: string): boolean;
  isRunning(instanceId: string): boolean;
  wake(ghost: InstalledGhost): Promise<void>;
  /** 投递到插件逻辑页;逻辑页不在线返回 false。 */
  send(instanceId: string, payload: unknown): boolean;
  now?(): number;
  newRequestId?(): string;
  timeoutMs?: number;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

export type GhostFileOpenOutcome =
  | { handled: true; instanceId: string; name: string }
  | { handled: false; reason: 'no-plugin' | 'declined' | 'timeout' | 'unavailable' };

interface PendingOpen {
  instanceId: string;
  resolve(ok: boolean | null): void;
}

export class GhostFileOpenerSlot {
  private readonly pending = new Map<string, PendingOpen>();

  constructor(private readonly deps: GhostFileOpenerDeps) {}

  /** 第一个能打开该文件的插件(按已装列表顺序);没有返回 null。 */
  candidate(filePath: string): InstalledGhost | null {
    return (
      this.deps.listGhosts().find(
        (ghost) =>
          ghost.enabled &&
          ghost.manifest.node !== undefined &&
          ghostFileOpenerMatches(ghost.manifest.fileOpener, filePath) &&
          this.deps.isEnabledByUser(this.deps.instanceId(ghost)),
      ) ?? null
    );
  }

  async open(filePath: string): Promise<GhostFileOpenOutcome> {
    const ghost = this.candidate(filePath);
    if (!ghost) return { handled: false, reason: 'no-plugin' };
    const instanceId = this.deps.instanceId(ghost);
    const requestId = this.deps.newRequestId?.() ?? randomUUID();
    const now = this.deps.now?.() ?? Date.now();
    const timeoutMs = this.deps.timeoutMs ?? GHOST_FILE_OPEN_TIMEOUT_MS;

    let settle: (ok: boolean | null) => void = () => undefined;
    const answer = new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => settle(null), timeoutMs);
      settle = (ok) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(ok);
      };
    });
    this.pending.set(requestId, { instanceId, resolve: (ok) => settle(ok) });

    try {
      if (!this.deps.isRunning(instanceId)) {
        // 唤醒也计入同一时限:插件起不来就别让用户一直等。
        const woke = await Promise.race([
          this.deps.wake(ghost).then(() => true),
          answer.then(() => false),
        ]);
        if (!woke) return { handled: false, reason: 'timeout' };
      }
      const delivered = this.deps.send(instanceId, {
        type: 'event',
        name: 'open-file',
        requestId,
        ts: now,
        deadline: now + timeoutMs,
        data: { path: filePath },
      });
      if (!delivered) {
        settle(null);
        return { handled: false, reason: 'unavailable' };
      }
    } catch (error) {
      settle(null);
      this.deps.log.warn('plugin file opener unavailable', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { handled: false, reason: 'unavailable' };
    }

    const ok = await answer;
    if (ok === null) {
      this.deps.log.warn('plugin file opener timed out', { instanceId });
      return { handled: false, reason: 'timeout' };
    }
    if (!ok) return { handled: false, reason: 'declined' };
    return { handled: true, instanceId, name: ghost.manifest.name };
  }

  /** 插件回执;发送方不是被问的那个实例、请求已结束或形状不对时静默丢弃。 */
  handleResult(senderInstanceId: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const { requestId, ok } = payload as { requestId?: unknown; ok?: unknown };
    if (typeof requestId !== 'string') return;
    const entry = this.pending.get(requestId);
    if (!entry || entry.instanceId !== senderInstanceId) return;
    entry.resolve(ok === true);
  }
}
