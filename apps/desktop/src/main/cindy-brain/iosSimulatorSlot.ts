/**
 * iosSimulatorSlot.ts — 插件的内置 iOS 模拟器能力槽。
 * ---------------------------------------------------------------------------
 * 本槽只提供低带宽、Host-owned 的两件事:
 * 1. 读取当前台前任务的公开模拟器状态；
 * 2. 请求 Host 打开已有的内置模拟器面板。
 *
 * 不跨插件边界传输视频帧、viewer lease、触控、Sidecar 路径或进程句柄。
 * 插件也不能自报 sessionId；任务身份只取 Host 已签发的台前窗口 grant。实际
 * WDA / Native 路由、生命周期、恢复和 fallback 继续走既有 iOS Simulator Host。
 */

import {
  GHOST_IOS_SIMULATOR_CAPABILITY_API_VERSION,
  type GhostPipeIOSSimulatorErrorCode,
  type GhostPipeIOSSimulatorResult,
  type GhostIOSSimulatorStatusProbeResult,
  type InstalledGhost,
} from '../../shared/ghost.js';

export const GHOST_IOS_SIMULATOR_OPEN_MIN_INTERVAL_MS = 5_000;
export const GHOST_IOS_SIMULATOR_STATUS_CACHE_MS = 1_000;

/** Host-authenticated foreground context; plugins can neither supply nor alter it. */
export interface IOSSimulatorSlotFocusContext {
  sessionId: string;
  windowWebContentsId: number;
  revision: number;
}

export interface IOSSimulatorSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  focusedContext(): IOSSimulatorSlotFocusContext | null;
  /**
   * User-initiated cold-start path. The Host must explicitly authorize the
   * exact foreground window/task and return a fresh Main-owned grant snapshot.
   */
  authorizeFocusedContext(): Promise<IOSSimulatorSlotFocusContext | null>;
  isContextCurrent(context: IOSSimulatorSlotFocusContext): boolean;
  /** Read-only, redacted snapshot; must not reconcile or renew ownership. */
  getStatus(sessionId: string): Promise<GhostIOSSimulatorStatusProbeResult>;
  /** false = 当前没有可承载右侧栏的 Host 窗口。 */
  focusViewer(context: IOSSimulatorSlotFocusContext, instanceId?: string): boolean;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function fail(
  errorCode: GhostPipeIOSSimulatorErrorCode,
  message: string,
): GhostPipeIOSSimulatorResult {
  return { ok: false, errorCode, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

export class GhostIOSSimulatorSlot {
  private readonly lastOpenAttemptAt = new Map<string, number>();
  private readonly statusCache = new Map<
    string,
    { capturedAt: number; result: GhostIOSSimulatorStatusProbeResult }
  >();
  private readonly statusInFlight = new Map<string, Promise<GhostIOSSimulatorStatusProbeResult>>();

  constructor(private readonly deps: IOSSimulatorSlotDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private contextKey(ghostId: string, context: IOSSimulatorSlotFocusContext): string {
    return `${ghostId}:${context.windowWebContentsId}:${context.revision}:${context.sessionId}`;
  }

  private async readStatus(
    ghostId: string,
    context: IOSSimulatorSlotFocusContext,
  ): Promise<GhostIOSSimulatorStatusProbeResult> {
    const key = this.contextKey(ghostId, context);
    const cached = this.statusCache.get(key);
    if (cached && this.now() - cached.capturedAt < GHOST_IOS_SIMULATOR_STATUS_CACHE_MS) {
      return cached.result;
    }
    const existing = this.statusInFlight.get(key);
    if (existing) return existing;
    const pending = this.deps
      .getStatus(context.sessionId)
      .then((result) => {
        this.statusCache.clear();
        this.statusCache.set(key, { capturedAt: this.now(), result });
        return result;
      })
      .finally(() => {
        this.statusInFlight.delete(key);
      });
    this.statusInFlight.set(key, pending);
    return pending;
  }

  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeIOSSimulatorResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('ios-simulator')) {
      return fail(
        'PERMISSION_DENIED',
        '插件未申请内置 iOS 模拟器权限(ios-simulator 槽),或当前未启用',
      );
    }
    if (!isRecord(payload) || typeof payload.kind !== 'string') {
      return fail('INVALID_REQUEST', 'ios-simulator-request 载荷必须是含 kind 的对象');
    }

    if (payload.kind === 'capabilities') {
      if (!hasOnlyKeys(payload, ['type', 'kind'])) {
        return fail('INVALID_REQUEST', 'capabilities 请求含未知字段');
      }
      return {
        ok: true,
        apiVersion: GHOST_IOS_SIMULATOR_CAPABILITY_API_VERSION,
        kind: 'capabilities',
        capabilities: {
          status: true,
          openHostPanel: true,
          pluginVideo: false,
          pluginInput: false,
        },
      };
    }

    if (payload.kind !== 'status' && payload.kind !== 'open-panel') {
      return fail('INVALID_REQUEST', '未知的内置 iOS 模拟器请求类型');
    }
    if (
      !hasOnlyKeys(
        payload,
        payload.kind === 'status' ? ['type', 'kind'] : ['type', 'kind', 'instanceId'],
      )
    ) {
      return fail('INVALID_REQUEST', `${payload.kind} 请求含未知字段`);
    }

    let instanceId: string | undefined;
    if (payload.kind === 'open-panel' && payload.instanceId !== undefined) {
      if (
        typeof payload.instanceId !== 'string' ||
        payload.instanceId.trim().length === 0 ||
        payload.instanceId.trim().length > 128
      ) {
        return fail('INVALID_REQUEST', 'instanceId 必须是 1–128 字符的字符串');
      }
      instanceId = payload.instanceId.trim();
    }

    if (payload.kind === 'open-panel') {
      const now = this.now();
      const lastAttemptAt = this.lastOpenAttemptAt.get(ghostId);
      this.lastOpenAttemptAt.set(ghostId, now);
      if (
        lastAttemptAt !== undefined &&
        now - lastAttemptAt < GHOST_IOS_SIMULATOR_OPEN_MIN_INTERVAL_MS
      ) {
        return fail('RATE_LIMITED', '打开内置模拟器的请求太频繁；请稍后重试');
      }
    }

    let context = this.deps.focusedContext();
    if (!context?.sessionId.trim() && payload.kind === 'open-panel') {
      context = await this.deps.authorizeFocusedContext();
    }
    if (!context?.sessionId.trim()) {
      return fail('HOST_NOT_READY', '当前没有打开的 Cindy 任务；先打开一个任务再使用内置模拟器');
    }

    let probe: GhostIOSSimulatorStatusProbeResult;
    try {
      probe = await this.readStatus(ghostId, context);
    } catch (error) {
      this.deps.log?.warn('ghost ios simulator status failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fail('IOS_SIMULATOR_HOST_ERROR', '无法读取内置模拟器状态；请稍后重试');
    }
    // 防异步查询期间切任务/切窗口；revision 可拦 A → B → A 的 ABA 切换。
    if (!this.deps.isContextCurrent(context)) {
      return fail('HOST_NOT_READY', '当前任务已切换；请刷新模拟器状态后重试');
    }
    if (!probe.ok) return fail(probe.errorCode, probe.message);

    if (payload.kind === 'status') {
      return {
        ok: true,
        apiVersion: GHOST_IOS_SIMULATOR_CAPABILITY_API_VERSION,
        kind: 'status',
        status: probe.status,
      };
    }

    if (instanceId) {
      if (!probe.status.instances.some((instance) => instance.instanceId === instanceId)) {
        return fail('INSTANCE_NOT_OWNED', '该模拟器不属于当前任务；请刷新状态后重试');
      }
    }

    if (!this.deps.focusViewer(context, instanceId)) {
      return fail('HOST_NOT_READY', '当前没有可打开内置模拟器面板的 Cindy 窗口');
    }
    this.deps.log?.info('ghost ios simulator panel requested', {
      ghostId,
      sessionId: context.sessionId,
      windowWebContentsId: context.windowWebContentsId,
      ...(instanceId ? { instanceId } : {}),
    });
    return {
      ok: true,
      apiVersion: GHOST_IOS_SIMULATOR_CAPABILITY_API_VERSION,
      kind: 'open-panel',
      ...(instanceId ? { instanceId } : {}),
    };
  }
}
