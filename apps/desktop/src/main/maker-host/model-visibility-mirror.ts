/**
 * model-visibility-mirror —— renderer 「模型显示/隐藏」override 在 main 进程的**内存镜像**。
 *
 * 背景:用户在「设置 → 模型供应商」逐个开关的可见性 override 真源在 renderer 的 localStorage
 * (`modelVisibilityPrefs`),main 进程读不到。IM `/model` 跑在 main,要和应用内模型列表**逐模型
 * 一致**(含用户手动隐藏的),就需要这份数据。
 *
 * 方案:renderer 单向把整张 override map 推给 main(启动时一次 + 每次开关变更),main 在此缓存。
 * **不落盘**——真源仍是 renderer localStorage,这里只是进程内副本;app 重启后由 renderer 重推。
 * 若 renderer 窗口被销毁过,main 用的是上次推来的快照(prefs 改动极少,实际不影响)。
 *
 * 放在 maker-host(而非 im/shared):它是 host 级的 renderer-pref 镜像,写入方是 maker-ipc 的
 * MODEL_VISIBILITY_SYNC handler、读取方是 im(/model 派生列表),两边都依赖 maker-host,避免
 * maker-ipc → im 的反向耦合。
 *
 * key 形如 `${agent}:${providerId}:${modelId}`,与 renderer modelVisibilityPrefs.keyOf 一致。
 */

import type { AgentKind } from '@cindy/model-providers';

import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';

/** override 表:key=`${agent}:${providerId}:${modelId}` → 用户显式设定的可见性。 */
type VisibilityMap = Record<string, boolean>;

let mirror: VisibilityMap = {};

/** 与 renderer modelVisibilityPrefs.keyOf 保持一致(改一处要同步另一处)。 */
function keyOf(agent: AgentKind, providerId: string, modelId: string): string {
  return `${agent}:${providerId}:${modelId}`;
}

/**
 * 接收 renderer 推来的整张 override map(MODEL_VISIBILITY_SYNC handler 调用)。
 * 整表替换语义(renderer 每次推完整快照),只保留 value 为 boolean 的条目(防脏数据)。
 * 返回净化后的镜像是否实际变化，调用方据此避免重复广播目录失效事件。
 */
export function setModelVisibilityMirror(raw: unknown): boolean {
  const next: VisibilityMap = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k && typeof v === 'boolean') next[k] = v;
    }
  }

  const currentKeys = Object.keys(mirror);
  const nextKeys = Object.keys(next);
  if (
    currentKeys.length === nextKeys.length
    && currentKeys.every((key) => mirror[key] === next[key])
  ) {
    return false;
  }

  mirror = next;
  return true;
}

/**
 * 应用 renderer 的整表快照，并只在规范化值实变时通知目录消费者失效。
 * 抽成可直接行为测试的边界，避免 IPC 接线只能靠源码字符串断言。
 */
export function syncModelVisibilityMirror(
  raw: unknown,
  onChanged: () => void,
): boolean {
  if (!setModelVisibilityMirror(raw)) return false;
  onChanged();
  return true;
}

/**
 * 只接受当前稳定 owner 的 renderer 快照。账号切换期间或旧 generation 的迟到 invoke 必须
 * fail closed，否则 A 的内存镜像会在 B 登录后继续影响 IM /model 与 device-link 控制端。
 */
export function syncModelVisibilityMirrorForOwner(
  raw: unknown,
  requestedOwner: unknown,
  activeOwner: DataOwnerPushStamp,
  boundaryPending: boolean,
  onChanged: () => void,
): boolean {
  if (
    boundaryPending
    || !isDataOwnerPushStamp(requestedOwner)
    || requestedOwner.dataOwnerId !== activeOwner.dataOwnerId
    || requestedOwner.ownerGeneration !== activeOwner.ownerGeneration
  ) {
    return false;
  }
  return syncModelVisibilityMirror(raw, onChanged);
}

/**
 * 取某 (agent, 来源, 模型) 的可见性 override(用户没显式开关过 ⇒ undefined,调用方回落目录默认)。
 * 与共享包 `isModelVisible(override, defaultEnabled)` 配合得到最终可见性。
 */
export function getModelVisibilityOverride(
  agent: AgentKind,
  providerId: string,
  modelId: string,
): boolean | undefined {
  return mirror[keyOf(agent, providerId, modelId)];
}

/**
 * 整表快照(浅拷贝)。PROVIDER_LIST 用它把被控端的可见性 override 一并回给 device-link
 * 控制端(手机),让手机模型列表按**被控端**用户的显示开关过滤(与本机 / IM /model 同口径)。
 */
export function getModelVisibilityMirrorSnapshot(): Record<string, boolean> {
  return { ...mirror };
}

/** Clear the process-global mirror at an account boundary before the next owner is committed. */
export function clearModelVisibilityMirror(): void {
  mirror = {};
}

/** 测试用 —— 重置镜像。 */
export function __resetModelVisibilityMirrorForTest(): void {
  clearModelVisibilityMirror();
}
