/**
 * useGlmCodingPlanUsage — GLM Coding Plan 订阅余量实时推送(per-provider)。
 *
 * 数据语义:5 小时 token 窗 / MCP 月度窗的已用百分比(+未证实的 reset 字段),
 * 类型与 fail-safe 语义见 shared/glmCodingPlanUsage.ts。
 *
 * 数据通道:main 的 monitor 端点 reader(cached-first + 节流 + 429 退避 + 换 key 防串号)
 * → usageBroadcaster 落库 + push。IPC 出口:
 *   electronAPI.maker.usage.{getGlmCodingPlan, onGlmCodingPlanUsageChanged}
 * push payload = { providerId, snapshot | null },本 hook 按 providerId 过滤。
 *
 * 触发时机:mount 时调一次 getGlmCodingPlan(main 端 cached-first,无快照会触发后台
 * 刷新),后续端点刷新 / CRUD 清快照时 main push。与 useClaudeSubscriptionUsage 的
 * 差别是身份维度:GLM Coding Plan 是用户自定义 provider,快照按 provider 隔离,
 * module cache 也按 providerId 分槽。
 */

import { useEffect, useState } from 'react';

import type { GlmCodingPlanUsageSnapshot } from '../../shared/glmCodingPlanUsage';

export type { GlmCodingPlanUsageSnapshot };

/** push payload 形状(与 usageBroadcaster.GlmCodingPlanUsagePushPayload 同构)。 */
interface GlmCodingPlanUsagePushPayload {
  providerId: string;
  snapshot: GlmCodingPlanUsageSnapshot | null;
}

const lastSnapshots = new Map<string, GlmCodingPlanUsageSnapshot | null>();

function isSnapshot(v: unknown): v is GlmCodingPlanUsageSnapshot {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isPushPayload(v: unknown): v is GlmCodingPlanUsagePushPayload {
  return isSnapshot(v) && typeof (v as { providerId?: unknown }).providerId === 'string';
}

/** push payload → 下一个缓存值(纯函数, 供单测): null 清空, 快照覆盖, 异常保留。 */
export function reduceGlmCodingPlanPush(
  current: GlmCodingPlanUsageSnapshot | null,
  payload: unknown,
): GlmCodingPlanUsageSnapshot | null {
  if (!isPushPayload(payload)) return current;
  return payload.snapshot;
}

// module 级常驻订阅(与 useClaudeSubscriptionUsage 同理由):chip 卸载期间发生 CRUD 清
// 快照 / 后台刷新时,module 缓存也要同步,否则下次 mount 会先 seed 旧数据闪一帧。
let moduleSubscriptionInstalled = false;
function ensureModuleSubscription(): void {
  if (moduleSubscriptionInstalled) return;
  const api = readUsageApi();
  if (!api?.onGlmCodingPlanUsageChanged) return;
  moduleSubscriptionInstalled = true;
  api.onGlmCodingPlanUsageChanged((payload: unknown) => {
    if (!isPushPayload(payload)) return;
    lastSnapshots.set(payload.providerId, payload.snapshot);
  });
}

/** 归一 warm-start 读结果(纯函数, 供单测;语义同 useClaudeSubscriptionUsage)。 */
export function resolvePersistedGlmCodingPlanRead(
  persisted: unknown,
):
  | { action: 'clear' }
  | { action: 'apply'; snapshot: GlmCodingPlanUsageSnapshot }
  | { action: 'ignore' } {
  if (persisted === null) return { action: 'clear' };
  if (isSnapshot(persisted)) return { action: 'apply', snapshot: persisted };
  return { action: 'ignore' };
}

function readUsageApi(): {
  getGlmCodingPlan?: (providerId: string) => Promise<unknown | null>;
  onGlmCodingPlanUsageChanged?: (cb: (payload: unknown) => void) => () => void;
} | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getGlmCodingPlan?: (providerId: string) => Promise<unknown | null>;
          onGlmCodingPlanUsageChanged?: (cb: (payload: unknown) => void) => () => void;
        };
      };
    };
  }).electronAPI?.maker?.usage;
}

export function useGlmCodingPlanUsage(
  providerId: string | null | undefined,
  enabled: boolean,
): GlmCodingPlanUsageSnapshot | null {
  ensureModuleSubscription();
  const key = providerId ?? '';
  const [snapshot, setSnapshot] = useState<GlmCodingPlanUsageSnapshot | null>(() =>
    enabled && providerId ? (lastSnapshots.get(providerId) ?? null) : null,
  );

  useEffect(() => {
    setSnapshot(enabled && providerId ? (lastSnapshots.get(providerId) ?? null) : null);
  }, [enabled, providerId]);

  useEffect(() => {
    if (!enabled || !providerId) return;
    const api = readUsageApi();
    if (!api?.getGlmCodingPlan) return;

    let cancelled = false;
    void api
      .getGlmCodingPlan(providerId)
      .then((persisted) => {
        if (cancelled) return;
        const resolved = resolvePersistedGlmCodingPlanRead(persisted);
        if (resolved.action === 'clear') {
          lastSnapshots.set(providerId, null);
          setSnapshot(null);
          return;
        }
        if (resolved.action === 'apply') {
          lastSnapshots.set(providerId, resolved.snapshot);
          setSnapshot(resolved.snapshot);
        }
      })
      .catch(() => {
        /* Best-effort warm start; push 更新仍会刷新 chip。 */
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, providerId]);

  useEffect(() => {
    if (!enabled || !providerId) return;
    const api = readUsageApi();
    if (!api?.onGlmCodingPlanUsageChanged) return;

    let cancelled = false;
    const unsubscribe = api.onGlmCodingPlanUsageChanged((payload: unknown) => {
      if (cancelled || !isPushPayload(payload)) return;
      if (payload.providerId !== providerId) return;
      const next = reduceGlmCodingPlanPush(lastSnapshots.get(providerId) ?? null, payload);
      lastSnapshots.set(providerId, next);
      setSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, providerId, key]);

  return snapshot;
}

/** 主动催一次刷新(倒计时归零等新快照时);main 端 read() 自带节流,重复调用安全。 */
export function requestGlmCodingPlanRefresh(providerId: string): void {
  const api = readUsageApi();
  if (!api?.getGlmCodingPlan) return;
  void api.getGlmCodingPlan(providerId).catch(() => {
    /* Best-effort nudge; push 更新仍会刷新 chip。 */
  });
}
