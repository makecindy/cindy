/**
 * pluginHarnesses — 插件提供的任务执行引擎注册表(Desktop main,docs/plans/acp-plugin-bridge.md)。
 *
 * 只列「已启用 + 整包批准有效 + 清单声明 + receipt `approvedHarnesses` 明确批准 + 协议已支持
 * (`acp`)」的引擎;名称按当前界面语言选好。可用状态只读插件经 `PUT /harnesses` 发布并落盘的
 * 元数据,从不调用插件;从未发布 = `unknown`。
 *
 * 接线(本模块不 import index.ts 与 maker-core,避免循环与反向依赖):
 * - `cindy-brain/index.ts` 的 `registerGhostIpc` 调用 `configurePluginHarnessRegistry(deps)`
 *   注入当前账号可见的已装插件、可用状态读取、界面语言与 broker 的 `spawnHarness`;
 * - 花名册变化(`broadcastGhostsChanged`,与 browserExtensionSlot 同一对账点)、界面语言切换、
 *   `PUT /harnesses` 内容变化后由 index.ts 调用 `reconcilePluginHarnesses()` 重算并通知;
 * - 引擎侧(第 3 步)只用 `getPluginHarnessRegistry()` 的 list / onChange / spawn。配置前
 *   list 为空、spawn 拒绝。
 *
 * `ghostId` 是插件实例键(`installedGhostStoragePart`,旧 root 安装即 manifest id),与 broker、
 * getGhost 同一身份,不会把同名的组织实例与 root 实例混为一谈;实例键不含 `:`,所以
 * `key = ${ghostId}:${harnessId}` 无歧义。
 */
import { ghostHarnessText, storedGhostHarnessAvailability, type GhostHarnessMode, type GhostHarnessModel } from '@cindy/plugin-protocol';

import { approvedGhostHarnesses, type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { NodeWorkerProcess } from './nodeRuntimeBroker.js';

export interface PluginHarness {
  /** `${ghostId}:${harnessId}`,任务记录里的稳定标识。 */
  key: string;
  ghostId: string;
  harnessId: string;
  /** 已按界面语言选好。 */
  name: string;
  description?: string;
  protocol: 'acp';
  availability: { state: 'available' | 'unavailable' | 'unknown'; reason?: string; message?: string; version?: string };
  /** The providing plugin's own icon (manifest `icon`, host-read data URL); absent = generic engine mark. */
  iconDataUrl?: string;
  /** Models the plugin lists for this engine (`PUT /harnesses`); absent = the plugin lists none. */
  models?: GhostHarnessModel[];
  /** The agent's own working modes the plugin lists (Cindy permission mode ids); absent = none. */
  modes?: GhostHarnessMode[];
  defaultMode?: GhostHarnessMode;
}

export interface PluginHarnessRegistry {
  /** 已启用 + 已批准 + 已声明 + 协议已支持。 */
  list(): PluginHarness[];
  /** 列表内容变化时通知(内容不变不通知);返回取消订阅函数。 */
  onChange(listener: (list: PluginHarness[]) => void): () => void;
  /** 原样 stdio 启动引擎入口;不在 list 中或已发布不可用时拒绝。 */
  spawn(key: string): Promise<NodeWorkerProcess>;
}

export interface PluginHarnessRegistryDeps {
  /** 当前账号可见的已装插件(availableGhosts)。 */
  listGhosts(): InstalledGhost[];
  /** 当前会话可用(账号要求、owner 边界);花名册广播传入的全量列表据此过滤。 */
  isAvailable(ghostId: string): boolean;
  /** 读取 `PUT /harnesses` 落盘的原始内容;没有时返回空对象。 */
  readAvailability(ghostId: string): unknown;
  /** 当前界面语言(app-context 的 uiLocale)。 */
  uiLocale(): string;
  /** broker.spawnHarness:fork 前后按安装、批准与 owner 现查守门。 */
  spawn(ghostId: string, harnessId: string): Promise<NodeWorkerProcess>;
  /**
   * 请插件重新发布引擎状态(含模型列表):给插件逻辑页发 `{ type: 'harnesses-refresh-requested' }`。
   * 逻辑页不在线时返回 false。缺省 = 不支持刷新。
   */
  requestRefresh?(ghostId: string): boolean;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface ReconcilablePluginHarnessRegistry extends PluginHarnessRegistry {
  /** 重算列表;内容变化才通知。`ghosts` 缺省时现读 deps.listGhosts()。 */
  reconcile(ghosts?: InstalledGhost[]): void;
  /** 丢弃缓存(不通知);下一次 list 现算。 */
  invalidate(): void;
}

function projectHarnesses(deps: PluginHarnessRegistryDeps, ghosts: InstalledGhost[]): PluginHarness[] {
  const locale = deps.uiLocale();
  const result: PluginHarness[] = [];
  for (const ghost of ghosts) {
    const harnesses = approvedGhostHarnesses(ghost);
    if (harnesses.length === 0) continue;
    const ghostId = installedGhostStoragePart(ghost);
    if (!deps.isAvailable(ghostId)) continue;
    let published: ReturnType<typeof storedGhostHarnessAvailability> = [];
    try {
      published = storedGhostHarnessAvailability(deps.readAvailability(ghostId), harnesses.map((harness) => harness.id));
    } catch (error) {
      // 读不到发布记录只让状态回到 unknown,不让引擎从列表消失。
      deps.log?.warn('plugin harness availability unreadable', {
        ghostId, error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const harness of harnesses) {
      const status = published.find((item) => item.id === harness.id);
      const text = ghostHarnessText(harness, locale);
      result.push({
        key: `${ghostId}:${harness.id}`,
        ghostId,
        harnessId: harness.id,
        name: text.name,
        ...(text.description !== undefined ? { description: text.description } : {}),
        protocol: 'acp',
        availability: status
          ? {
            state: status.available ? 'available' : 'unavailable',
            ...(status.reason !== undefined ? { reason: status.reason } : {}),
            ...(status.message !== undefined ? { message: status.message } : {}),
            ...(status.version !== undefined ? { version: status.version } : {}),
          }
          : { state: 'unknown' },
        ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
        ...(status?.models ? { models: status.models.map((model) => ({ ...model, ...(model.efforts ? { efforts: [...model.efforts] } : {}) })) } : {}),
        ...(status?.modes ? { modes: [...status.modes] } : {}),
        ...(status?.defaultMode ? { defaultMode: status.defaultMode } : {}),
      });
    }
  }
  return result;
}

/** 生产与测试共用的注册表实现;生产单例见 getPluginHarnessRegistry。 */
export function createPluginHarnessRegistry(deps: PluginHarnessRegistryDeps): ReconcilablePluginHarnessRegistry {
  const listeners = new Set<(list: PluginHarness[]) => void>();
  let current: PluginHarness[] | null = null;
  // 基线是空列表:首次重算就有引擎时,先订阅的引擎侧也能收到通知。
  let fingerprint = '[]';
  const compute = (ghosts?: InstalledGhost[]): PluginHarness[] => projectHarnesses(deps, ghosts ?? deps.listGhosts());
  const snapshot = (list: PluginHarness[]) => list.map((item) => ({ ...item, availability: { ...item.availability } }));
  const reconcile = (ghosts?: InstalledGhost[]): PluginHarness[] => {
    const next = compute(ghosts);
    const nextFingerprint = JSON.stringify(next);
    const changed = nextFingerprint !== fingerprint;
    current = next;
    fingerprint = nextFingerprint;
    if (!changed) return next;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot(next));
      } catch (error) {
        deps.log?.warn('plugin harness listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return next;
  };
  return {
    list() {
      return snapshot(current ?? reconcile());
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async spawn(key) {
      // 现算而不是读缓存:停用、撤权或刚发布的不可用状态都必须在启动这一刻生效。
      const fresh = compute();
      const harness = fresh.find((item) => item.key === key);
      if (!harness) throw new Error(`Task engine ${key} is not available: the plugin is not enabled, approved or declaring it`);
      if (harness.availability.state === 'unavailable') {
        throw new Error(`Task engine ${harness.name} is unavailable${harness.availability.message ? `: ${harness.availability.message}` : ''}`);
      }
      return deps.spawn(harness.ghostId, harness.harnessId);
    },
    reconcile(ghosts) {
      reconcile(ghosts);
    },
    invalidate() {
      current = null;
    },
  };
}

const UNCONFIGURED: PluginHarnessRegistryDeps = {
  listGhosts: () => [],
  isAvailable: () => false,
  readAvailability: () => ({}),
  uiLocale: () => 'en',
  spawn: async () => { throw new Error('Plugin task engines are not ready'); },
};

let registryDeps: PluginHarnessRegistryDeps = UNCONFIGURED;
const registry = createPluginHarnessRegistry({
  listGhosts: () => registryDeps.listGhosts(),
  isAvailable: (ghostId) => registryDeps.isAvailable(ghostId),
  readAvailability: (ghostId) => registryDeps.readAvailability(ghostId),
  uiLocale: () => registryDeps.uiLocale(),
  spawn: (ghostId, harnessId) => registryDeps.spawn(ghostId, harnessId),
  log: { warn: (message, meta) => registryDeps.log?.warn(message, meta) },
});

/**
 * index.ts 在 registerGhostIpc 中注入一次;之后由 reconcilePluginHarnesses 驱动重算。
 * 注入时不立即读花名册(插件管理器可能尚未就绪),下一次 list 或花名册广播再算。
 */
export function configurePluginHarnessRegistry(deps: PluginHarnessRegistryDeps): void {
  registryDeps = deps;
  registry.invalidate();
}

/** 花名册广播、语言切换与可用状态发布后调用;内容不变时不通知。 */
export function reconcilePluginHarnesses(ghosts?: InstalledGhost[]): void {
  registry.reconcile(ghosts);
}

export function getPluginHarnessRegistry(): PluginHarnessRegistry {
  return registry;
}

/** 与普通供应商模型自动刷新同一节奏：同一个插件 10 分钟内只请求一次。 */
export const PLUGIN_HARNESS_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const lastRefreshRequestAt = new Map<string, number>();

/**
 * 打开模型选择器时调用(普通供应商在同一时机自动刷新模型列表)：请每个提供引擎的插件重新发布
 * 引擎状态与模型列表。插件怎么取模型由插件自己决定；结果经 `PUT /harnesses` 回来，照常对账。
 * 只发给当前列出引擎的插件；冷却内与逻辑页不在线时不发(不在线的下次再试)。
 */
export function requestPluginHarnessRefresh(now = Date.now()): void {
  const send = registryDeps.requestRefresh;
  if (!send) return;
  const ghostIds = new Set(registry.list().map((harness) => harness.ghostId));
  for (const ghostId of ghostIds) {
    const last = lastRefreshRequestAt.get(ghostId);
    if (last !== undefined && now - last < PLUGIN_HARNESS_REFRESH_COOLDOWN_MS) continue;
    if (send(ghostId)) lastRefreshRequestAt.set(ghostId, now);
  }
}

/** Test seam: forget refresh cooldowns. */
export function resetPluginHarnessRefreshForTests(): void {
  lastRefreshRequestAt.clear();
}
