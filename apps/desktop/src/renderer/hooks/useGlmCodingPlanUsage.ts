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
 * module cache 也按 providerId 分槽,**并按 data owner 整体清空**(双账号同名
 * provider 时防串号,见 ownerScopedGlmSnapshots)。
 */

import { useEffect, useState } from 'react';

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { GlmCodingPlanUsageSnapshot } from '../../shared/glmCodingPlanUsage';

export type { GlmCodingPlanUsageSnapshot };

/** push payload 形状(与 usageBroadcaster.GlmCodingPlanUsagePushPayload 同构)。 */
interface GlmCodingPlanUsagePushPayload {
  providerId: string;
  /** 广播时刻的 data owner —— 与当前 owner 不符的迟到推送整体丢弃(#2768 r3788720174)。 */
  ownerId?: string | null;
  snapshot: GlmCodingPlanUsageSnapshot | null;
}

/**
 * module 缓存按 data owner 隔离(#2768 首轮 review r3785828841):双账号各有同名 GLM
 * provider 时,provider id 复用而归属换了 —— owner 变化必须整体清空,否则新账号的
 * chip 会先 seed 上一个账号的余量(IPC 读失败时无限期)。口径对齐
 * providersSnapshotStore.getCachedProvidersSnapshot 的 owner 校验。
 * 导出仅供单测直接验证 owner 切换语义,组件代码走 ownerScopedGlmSnapshots()。
 */
let glmSnapshotsOwnerId: string | null = null;
const glmSnapshots = new Map<string, GlmCodingPlanUsageSnapshot | null>();

export function ownerScopedGlmSnapshots(): Map<string, GlmCodingPlanUsageSnapshot | null> {
  const { dataOwnerId } = getDataOwnerGeneration();
  if (glmSnapshotsOwnerId !== dataOwnerId) {
    glmSnapshotsOwnerId = dataOwnerId;
    glmSnapshots.clear();
  }
  return glmSnapshots;
}

/** owner id 是否仍是当前 data owner(warm read 与迟到推送判定共用同一口径)。 */
export function isDataOwnerIdCurrent(ownerId: string | null): boolean {
  return ownerId === getDataOwnerGeneration().dataOwnerId;
}

/**
 * 推送世代戳是否仍然当前:ownerId 缺失(旧版 main / 异常)按未知沿用不误丢;
 * 携带 ownerId 且与当前 data owner 不符 → 过期(旧账号排队的迟到推送)。
 */
export function isGlmPushOwnerCurrent(payload: GlmCodingPlanUsagePushPayload): boolean {
  if (payload.ownerId === undefined || payload.ownerId === null) return true;
  return isDataOwnerIdCurrent(payload.ownerId);
}

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
    // 迟到的旧账号推送(owner 戳与当前 owner 不符)整体丢弃,不落任何 owner 的缓存。
    if (!isGlmPushOwnerCurrent(payload)) return;
    ownerScopedGlmSnapshots().set(payload.providerId, payload.snapshot);
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
    enabled && providerId ? (ownerScopedGlmSnapshots().get(providerId) ?? null) : null,
  );

  useEffect(() => {
    setSnapshot(enabled && providerId ? (ownerScopedGlmSnapshots().get(providerId) ?? null) : null);
  }, [enabled, providerId]);

  useEffect(() => {
    if (!enabled || !providerId) return;
    const api = readUsageApi();
    if (!api?.getGlmCodingPlan) return;

    let cancelled = false;
    // 读发起时的 data owner:resolve 时复核 —— IPC 挂起期间切账号的话,结果属于旧
    // owner,不得写进新 owner 的缓存(chip 会先 seed 旧账号余量;#2768 七轮 Codex
    // P1)。与迟到推送判定(isGlmPushOwnerCurrent)同口径。
    const readOwnerId = getDataOwnerGeneration().dataOwnerId;
    void api
      .getGlmCodingPlan(providerId)
      .then((persisted) => {
        if (cancelled) return;
        if (!isDataOwnerIdCurrent(readOwnerId)) return;
        const resolved = resolvePersistedGlmCodingPlanRead(persisted);
        if (resolved.action === 'clear') {
          ownerScopedGlmSnapshots().set(providerId, null);
          setSnapshot(null);
          return;
        }
        if (resolved.action === 'apply') {
          ownerScopedGlmSnapshots().set(providerId, resolved.snapshot);
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
      if (!isGlmPushOwnerCurrent(payload)) return;
      const next = reduceGlmCodingPlanPush(
        ownerScopedGlmSnapshots().get(providerId) ?? null,
        payload,
      );
      ownerScopedGlmSnapshots().set(providerId, next);
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
