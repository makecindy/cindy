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

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushStampCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { GlmCodingPlanUsageSnapshot } from '../../shared/glmCodingPlanUsage';

export type { GlmCodingPlanUsageSnapshot };

/** push payload 形状(与 usageBroadcaster.GlmCodingPlanUsagePushPayload 同构)。 */
interface GlmCodingPlanUsagePushPayload {
  providerId: string;
  /** 旧字段:仅 id 的 owner 戳,新 main 的完整 ownerStamp 存在时以完整戳为准。 */
  ownerId?: string | null;
  /** 完整 owner 戳(id+ownerGeneration,#2768 十轮):同账号重登后世代前进,只比 id 挡不住重登前排队的迟到推送。 */
  ownerStamp?: unknown;
  snapshot: GlmCodingPlanUsageSnapshot | null;
}

/**
 * module 缓存按 data owner **完整世代**隔离(#2768 首轮 r3785828841 + 十轮 P1-b):
 * 双账号各有同名 GLM provider 时,provider id 复用而归属换了 —— owner 变化必须整体
 * 清空,否则新账号的 chip 会先 seed 上一个账号的余量。十轮起比对的维度从 id 升为
 * (id, generation):同账号重登/本地档案恢复同样属于「上一会话的数据不可直接给下一
 * 会话用」。口径对齐 providersSnapshotStore.getCachedProvidersSnapshot 的 owner 校验。
 * 导出仅供单测直接验证 owner 切换语义,组件代码走 ownerScopedGlmSnapshots()。
 */
let glmSnapshotsOwner: { dataOwnerId: string | null; generation: number } | null = null;
const glmSnapshots = new Map<string, GlmCodingPlanUsageSnapshot | null>();

export function ownerScopedGlmSnapshots(): Map<string, GlmCodingPlanUsageSnapshot | null> {
  const { dataOwnerId, generation } = getDataOwnerGeneration();
  if (
    glmSnapshotsOwner === null
    || glmSnapshotsOwner.dataOwnerId !== dataOwnerId
    || glmSnapshotsOwner.generation !== generation
  ) {
    glmSnapshotsOwner = { dataOwnerId, generation };
    glmSnapshots.clear();
  }
  return glmSnapshots;
}

/** owner id 是否仍是当前 data owner(legacy 口径,见 isGlmPushOwnerCurrent 的降级链)。 */
export function isDataOwnerIdCurrent(ownerId: string | null): boolean {
  return ownerId === getDataOwnerGeneration().dataOwnerId;
}

/**
 * 推送 owner 戳是否仍然当前(#2768 十轮 P1-b):
 *   - 携带完整 ownerStamp(id+ownerGeneration,新 main)→ 交给房子的世代感知校验
 *     isDataOwnerPushStampCurrent:既比 id 也比世代,同 id 重登前排队的迟到推送被拒;
 *     形状非法的戳 fail-closed(不再无条件接受 null/畸形戳)。
 *   - 仅 ownerId(旧版 main)→ 降级为 id 比对;完全无戳的超旧推送按未知沿用不误丢。
 */
export function isGlmPushOwnerCurrent(payload: GlmCodingPlanUsagePushPayload): boolean {
  if (payload.ownerStamp !== undefined) {
    return isDataOwnerPushStampCurrent(payload.ownerStamp);
  }
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
    // 读发起时的完整 owner 世代:resolve 时复核 —— IPC 挂起期间切账号**或同账号
    // 重登**(世代前进)的话,结果属于旧会话,不得写进当前缓存(chip 会先 seed 旧
    // 会话余量;#2768 七轮 Codex P1 + 十轮 P1-b 升级为完整世代比对)。
    const readOwner = getDataOwnerGeneration();
    void api
      .getGlmCodingPlan(providerId)
      .then((persisted) => {
        if (cancelled) return;
        if (!isDataOwnerGenerationCurrent(readOwner)) return;
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
