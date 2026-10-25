import type { AgentKind, ProviderView } from '@cindy/model-providers';

import { createIpcError } from '@cindy/remote-agent/shared/ipc-errors';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '@cindy/remote-agent/shared/dataOwnerPush';

export function createModelVisibilityMirror() {
/** 有效开关表:key=`${agent}:${providerId}:${modelId}` → 用户显式设定的可见性。 */
type VisibilityMap = Record<string, boolean>;

let mirror: VisibilityMap = {};
let strict = true;
let ready = false;
const readinessWaiters = new Set<(error?: Error) => void>();

function notReady(): Error {
  return createIpcError('MODEL_VISIBILITY_NOT_READY', 'current account model preferences have not synchronized');
}

/** Wait only for current-account preferences; never manufacture factory defaults. */
function waitForModelVisibilityMirror(timeoutMs = 5000): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      readinessWaiters.delete(finish);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(notReady()), timeoutMs);
    readinessWaiters.add(finish);
  });
}
let followCatalogKeys = new Set<string>();

/** 与 renderer modelVisibilityPrefs.keyOf 保持一致(改一处要同步另一处)。 */
function keyOf(agent: AgentKind, providerId: string, modelId: string): string {
  return `${agent}:${providerId}:${modelId}`;
}

/**
 * 接收 renderer 推来的整张 override map(MODEL_VISIBILITY_SYNC handler 调用)。
 * 整表替换语义(renderer 每次推完整快照),只保留 value 为 boolean 的条目(防脏数据)。
 * 返回净化后的镜像是否实际变化，调用方据此避免重复广播目录失效事件。
 */
function setModelVisibilityMirror(raw: unknown, policy?: unknown): boolean {
  const candidate = policy as { fallback?: unknown; followCatalogKeys?: unknown; pending?: unknown } | undefined;
  if (candidate?.pending === true) {
    if (!ready) return false;
    // Legacy preferences can appear after an empty origin first becomes ready.
    // Stop serving its earlier defaults until the renderer finishes migration.
    clearModelVisibilityMirror();
    return true;
  }
  const wasReady = ready;
  const nextStrict = candidate?.fallback === false;
  const nextFollow = new Set<string>(nextStrict && Array.isArray(candidate?.followCatalogKeys)
    ? candidate.followCatalogKeys.filter((key): key is string => typeof key === 'string') : []);
  const policyChanged = strict !== nextStrict || followCatalogKeys.size !== nextFollow.size
    || [...followCatalogKeys].some((key) => !nextFollow.has(key));
  const next: VisibilityMap = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k && typeof v === 'boolean') next[k] = v;
    }
  }

  const currentKeys = Object.keys(mirror);
  const nextKeys = Object.keys(next);
  if (
    wasReady && !policyChanged && currentKeys.length === nextKeys.length
    && currentKeys.every((key) => mirror[key] === next[key])
  ) {
    return false;
  }

  mirror = next;
  ready = true;
  for (const finish of readinessWaiters) finish();
  strict = nextStrict;
  followCatalogKeys = nextFollow;
  return true;
}

/**
 * 应用 renderer 的整表快照，并只在规范化值实变时通知目录消费者失效。
 * 抽成可直接行为测试的边界，避免 IPC 接线只能靠源码字符串断言。
 */
function syncModelVisibilityMirror(
  raw: unknown,
  onChanged: () => void,
  policy?: unknown,
): boolean {
  if (!setModelVisibilityMirror(raw, policy)) return false;
  onChanged();
  return true;
}

/**
 * 只接受当前稳定 owner 的 renderer 快照。账号切换期间或旧 generation 的迟到 invoke 必须
 * fail closed，否则 A 的内存镜像会在 B 登录后继续影响 IM /model 与 device-link 控制端。
 */
function syncModelVisibilityMirrorForOwner(
  raw: unknown,
  requestedOwner: unknown,
  activeOwner: DataOwnerPushStamp,
  boundaryPending: boolean,
  onChanged: () => void,
  policy?: unknown,
): boolean {
  if (
    boundaryPending
    || !isDataOwnerPushStamp(requestedOwner)
    || requestedOwner.dataOwnerId !== activeOwner.dataOwnerId
    || requestedOwner.ownerGeneration !== activeOwner.ownerGeneration
  ) {
    return false;
  }
  return syncModelVisibilityMirror(raw, onChanged, policy);
}

/**
 * 取有效可见性：未知路线关闭；仅明确恢复默认或旧 renderer 快照允许目录兜底。
 * 与共享包 `isModelVisible(override, defaultEnabled)` 配合得到最终可见性。
 */
function getModelVisibilityOverride(
  agent: AgentKind,
  providerId: string,
  modelId: string,
): boolean | undefined {
  if (!ready) throw notReady();
  const key = keyOf(agent, providerId, modelId);
  return mirror[key] ?? (strict && !followCatalogKeys.has(key) ? false : undefined);
}

/**
 * 整表快照(浅拷贝)。PROVIDER_LIST 用它把被控端的可见性 override 一并回给 device-link
 * 控制端(手机),让手机模型列表按**被控端**用户的显示开关过滤(与本机 / IM /model 同口径)。
 */
function getModelVisibilityMirrorSnapshot(providers: readonly ProviderView[] = [], allowPending = false): Record<string, boolean> {
  if (!ready && allowPending) return {};
  if (!ready) throw notReady();
  const snapshot = { ...mirror };
  // Expand the fallback into ordinary per-model booleans for legacy remote clients. The
  // provider list and visibility map come from the same catalog; no wire-schema change.
  for (const provider of providers) {
    for (const agent of provider.agents) {
      for (const model of provider.models[agent] ?? []) {
        const value = getModelVisibilityOverride(agent, provider.id, model.id);
        if (value !== undefined) snapshot[keyOf(agent, provider.id, model.id)] = value;
      }
    }
    const mediaAgent = provider.agents[0] ?? 'claude-code';
    for (const model of [...(provider.imageModels ?? []), ...(provider.videoModels ?? [])]) {
      const value = getModelVisibilityOverride(mediaAgent, provider.id, model.id);
      if (value !== undefined) snapshot[keyOf(mediaAgent, provider.id, model.id)] = value;
    }
  }
  return snapshot;
}

/** Clear the process-global mirror at an account boundary before the next owner is committed. */
function clearModelVisibilityMirror(): void {
  mirror = {};
  ready = false;
  for (const finish of readinessWaiters) finish(notReady());
  strict = true;
  followCatalogKeys = new Set();
}

/** 测试用 —— 重置镜像。 */
function __resetModelVisibilityMirrorForTest(): void {
  clearModelVisibilityMirror();
}

return {waitForModelVisibilityMirror, setModelVisibilityMirror, syncModelVisibilityMirror, syncModelVisibilityMirrorForOwner, getModelVisibilityOverride, getModelVisibilityMirrorSnapshot, clearModelVisibilityMirror, __resetModelVisibilityMirrorForTest};
}
