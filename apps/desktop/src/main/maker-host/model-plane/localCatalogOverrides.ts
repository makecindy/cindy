/**
 * localCatalogOverrides —— 用户本地模型目录 override 的**纯合并逻辑**(零 IO;
 * 持久化见 maker-host/model-catalog-override-store.ts)。
 *
 * 定位:服务器缺失/出错时的本地抢修通道 —— local 永远最高优先级,远端刷新只换
 * remote 层、绝不能覆盖本地修改。与既有三根正交轴严格分工,本模块**禁碰**:
 *   - 显示/隐藏 → renderer modelVisibilityPrefs(defaultEnabled 不可 override);
 *   - 准入/停用 → model-disable-store;
 *   - 本地参考价 → usage/modelPriceOverrideStore;
 *   - RoutingDescriptor / auth / upstream → 永不属于任何 override 面。
 *
 * 形状(v1):key = `${providerId}:${modelId}`(**不含 agent**),一条记录经
 * base + perAgent(claude-code/codex) 表达跨 root 差异 —— 修 xAI Codex 专属
 * 思考档 = 一条 { perAgent: { codex: { efforts } } } patch,不用双写。
 *   - additions:完整新实体(base+perAgent 合成后须能力自洽),同 key 整条
 *     压过 remote/discovery(不做字段混合),且**显式复活**远端 retired;
 *   - patches:稀疏逐字段覆盖,可 dormant(宿主尚不存在时静置,出现即生效);
 *     patch.status 禁 'retired'(变相本地 tombstone;本地无 tombstone,
 *     想隐藏走 visibility/disable 轴)。
 * 单条 invalid 隔离(保留原文、告警、不参与合并),整文件其余条目继续生效。
 */

import type { CatalogModel } from '@cindy/model-providers';

import {
  MODEL_PLANE_POLICIES,
  type ModelPlaneWarning,
  type RootAgentKind,
} from './modelPlanePolicy.js';

type Effort = CatalogModel['efforts'][number];

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
/** patch/addition 可写的 status(retired 被显式排除:本地无 tombstone)。 */
const OVERRIDE_STATUSES: ReadonlySet<string> = new Set(['active', 'preview', 'deprecated']);

/** 可 override 的字段面(与三根既有轴零交集;defaultEnabled/价格/routing 均排除)。 */
export interface ModelCatalogOverrideFields {
  name?: string;
  group?: string;
  description?: string;
  sortOrder?: number;
  contextWindow?: number;
  maxOutput?: number;
  efforts?: Effort[];
  defaultEffort?: Effort | null;
  supportsFastMode?: boolean;
  /** 与 Registry 使用同一作者侧 lifecycle 词汇；应用到 CatalogModel 时 preview→alpha。 */
  status?: 'active' | 'preview' | 'deprecated';
}

/**
 * Registry `perAgent` 的同构子集：只描述运行时能力差异。展示字段和 lifecycle
 * 始终属于 base，避免一条模型在不同 harness 下拥有互相冲突的身份信息。
 */
export type ModelCatalogPerAgentOverrideFields = Pick<
  ModelCatalogOverrideFields,
  'contextWindow' | 'maxOutput' | 'efforts' | 'defaultEffort' | 'supportsFastMode'
>;

export interface ModelCatalogOverrideEntry {
  /** 消费 membership；缺省 = provider policy 的全部 root + wire bridge，且必须含至少一个 root。 */
  agents?: RootAgentKind[];
  base?: ModelCatalogOverrideFields;
  perAgent?: Partial<Record<RootAgentKind, ModelCatalogPerAgentOverrideFields>>;
}

export interface ModelCatalogOverrides {
  version: 1;
  /** key = `${providerId}:${modelId}`。 */
  additions: Record<string, ModelCatalogOverrideEntry>;
  patches: Record<string, ModelCatalogOverrideEntry>;
}

export const EMPTY_MODEL_CATALOG_OVERRIDES: ModelCatalogOverrides = {
  version: 1,
  additions: {},
  patches: {},
};

/** 防手改文件无界膨胀的每段条目硬上限(正常用户远碰不到)。 */
export const MAX_OVERRIDE_ENTRIES_PER_SECTION = 1024;

export interface SanitizeResult {
  overrides: ModelCatalogOverrides;
  /** 被隔离的 key(格式坏/字段非法/provider 不在 allowlist);调用方告警留痕。 */
  invalid: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseKey(key: string): { providerId: string; modelId: string } | null {
  const sep = key.indexOf(':');
  if (sep <= 0 || sep === key.length - 1) return null;
  const providerId = key.slice(0, sep);
  const modelId = key.slice(sep + 1);
  // allowlist 之外(含 xd 与任意未知 provider)一律无效:本地不能造 XD/未知供应商实体。
  if (!MODEL_PLANE_POLICIES.has(providerId)) return null;
  if (modelId.length > 256) return null;
  return { providerId, modelId };
}

function sanitizeFields(
  raw: unknown,
  scope: 'base' | 'perAgent' = 'base',
): ModelCatalogOverrideFields | null {
  if (!isPlainObject(raw)) return null;
  const out: ModelCatalogOverrideFields = {};
  for (const [k, v] of Object.entries(raw)) {
    if (
      scope === 'perAgent' &&
      k !== 'contextWindow' &&
      k !== 'maxOutput' &&
      k !== 'efforts' &&
      k !== 'defaultEffort' &&
      k !== 'supportsFastMode'
    ) {
      return null;
    }
    switch (k) {
      case 'name':
        if (typeof v !== 'string' || v.length === 0 || v.length > 256) return null;
        out.name = v;
        break;
      case 'group':
        if (typeof v !== 'string' || v.length === 0 || v.length > 128) return null;
        out.group = v;
        break;
      case 'description':
        if (typeof v !== 'string' || v.length === 0 || v.length > 2_000) return null;
        out.description = v;
        break;
      case 'sortOrder':
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        out.sortOrder = v;
        break;
      case 'contextWindow':
      case 'maxOutput':
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null;
        out[k] = v;
        break;
      case 'efforts':
        if (
          !Array.isArray(v) ||
          v.some((e) => typeof e !== 'string' || !VALID_EFFORTS.has(e)) ||
          new Set(v).size !== v.length
        )
          return null;
        out.efforts = v as Effort[];
        break;
      case 'defaultEffort':
        if (v !== null && (typeof v !== 'string' || !VALID_EFFORTS.has(v))) return null;
        out.defaultEffort = v as Effort | null;
        break;
      case 'supportsFastMode':
        if (typeof v !== 'boolean') return null;
        out.supportsFastMode = v;
        break;
      case 'status':
        // 'retired' 在此被拒:本地禁写 tombstone,复活远端 retired 只能走完整 addition。
        if (typeof v !== 'string' || !OVERRIDE_STATUSES.has(v)) return null;
        out.status = v as ModelCatalogOverrideFields['status'];
        break;
      default:
        // 未知字段(含 defaultEnabled/价格/routing 类)= 整条无效:override 面是
        // 显式契约,静默丢字段会让用户以为改了没生效。
        return null;
    }
  }
  // 同一字段块里同时写了 efforts/defaultEffort 时必须自洽；只写 efforts 仍然
  // 合法，因为 patch 可以继承宿主默认档、perAgent 也可以继承 base.defaultEffort。
  // 最终有效组合在 additionModelFor / overlayFields 再校验一次。
  if (out.efforts !== undefined && out.defaultEffort !== undefined) {
    if (out.efforts.length === 0) {
      if (out.defaultEffort !== null) return null;
    } else if (out.defaultEffort === null || !out.efforts.includes(out.defaultEffort)) {
      return null;
    }
  }
  return out;
}

function sanitizeEntry(raw: unknown): ModelCatalogOverrideEntry | null {
  if (!isPlainObject(raw)) return null;
  const out: ModelCatalogOverrideEntry = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'agents') {
      if (
        !Array.isArray(v) ||
        v.length === 0 ||
        v.some((a) => a !== 'claude-code' && a !== 'codex') ||
        new Set(v).size !== v.length
      )
        return null;
      out.agents = v as RootAgentKind[];
    } else if (k === 'base') {
      const fields = sanitizeFields(v);
      if (!fields) return null;
      out.base = fields;
    } else if (k === 'perAgent') {
      if (!isPlainObject(v)) return null;
      const perAgent: ModelCatalogOverrideEntry['perAgent'] = {};
      for (const [agent, fields] of Object.entries(v)) {
        if (agent !== 'claude-code' && agent !== 'codex') return null;
        const sanitized = sanitizeFields(fields, 'perAgent');
        if (!sanitized) return null;
        perAgent[agent] = sanitized;
      }
      out.perAgent = perAgent;
    } else {
      return null;
    }
  }
  const perAgentKeys = Object.keys(out.perAgent ?? {}) as RootAgentKind[];
  if (out.agents && perAgentKeys.some((agent) => !out.agents!.includes(agent))) return null;
  if (out.agents === undefined && out.base === undefined && perAgentKeys.length === 0) return null;
  return out;
}

/** 合成某 agent 的有效字段:base + perAgent[agent] 逐字段覆盖。 */
function effectiveFields(
  entry: ModelCatalogOverrideEntry,
  agent: RootAgentKind,
): ModelCatalogOverrideFields {
  return { ...entry.base, ...entry.perAgent?.[agent] };
}

/** addition 在某 agent 下是否能力自洽完整(与 registry 实体化同一门槛,不准猜)。 */
function additionModelFor(
  modelId: string,
  entry: ModelCatalogOverrideEntry,
  agent: RootAgentKind,
): CatalogModel | null {
  const f = effectiveFields(entry, agent);
  if (!f.name || f.contextWindow === undefined || f.efforts === undefined) return null;
  let defaultEffort: Effort | null;
  if (f.efforts.length === 0) {
    if (f.defaultEffort !== undefined && f.defaultEffort !== null) return null;
    defaultEffort = null;
  } else if (f.defaultEffort != null && f.efforts.includes(f.defaultEffort)) {
    defaultEffort = f.defaultEffort;
  } else return null;
  return {
    id: modelId,
    name: f.name,
    ...(f.group !== undefined ? { group: f.group } : {}),
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.sortOrder !== undefined ? { sortOrder: f.sortOrder } : {}),
    contextWindow: f.contextWindow,
    contextWindowVerified: true,
    ...(f.maxOutput !== undefined ? { maxOutput: f.maxOutput } : {}),
    efforts: f.efforts,
    defaultEffort,
    ...(f.supportsFastMode !== undefined ? { supportsFastMode: f.supportsFastMode } : {}),
    ...(f.status !== undefined
      ? { status: f.status === 'preview' ? ('alpha' as const) : f.status }
      : {}),
  };
}

/**
 * 清洗任意来源(磁盘/手改)的 overrides。单条 invalid 隔离进 `invalid`,
 * 其余照常;每段超硬上限的尾部条目丢弃(按键序,确定性)。
 */
export function sanitizeModelCatalogOverrides(raw: unknown): SanitizeResult {
  const invalid: string[] = [];
  const out: ModelCatalogOverrides = { version: 1, additions: {}, patches: {} };
  if (!isPlainObject(raw)) return { overrides: out, invalid };
  if (raw.version !== undefined && raw.version !== 1) {
    return { overrides: out, invalid: ['version'] };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'additions' && key !== 'patches') {
      invalid.push(`root:${key}`);
    }
  }
  for (const section of ['additions', 'patches'] as const) {
    const rawSection = raw[section];
    if (rawSection === undefined) continue;
    if (!isPlainObject(rawSection)) {
      invalid.push(section);
      continue;
    }
    let kept = 0;
    for (const key of Object.keys(rawSection).sort()) {
      const parsed = parseKey(key);
      const entry = parsed ? sanitizeEntry(rawSection[key]) : null;
      if (!parsed || !entry) {
        invalid.push(`${section}:${key}`);
        continue;
      }
      const agents = entryRootAgents(entry, parsed.providerId);
      if (agents.length === 0) {
        invalid.push(`${section}:${key}`);
        continue;
      }
      if (section === 'additions') {
        // addition 必须在其作用的每个 root 上都自洽完整,否则整条隔离。
        if (agents.some((agent) => additionModelFor(parsed.modelId, entry, agent) === null)) {
          invalid.push(`${section}:${key}`);
          continue;
        }
      }
      if (kept >= MAX_OVERRIDE_ENTRIES_PER_SECTION) {
        invalid.push(`${section}:${key}`);
        continue;
      }
      out[section][key] = entry;
      kept += 1;
    }
  }
  return { overrides: out, invalid };
}

/** entry 的消费 membership；缺省覆盖 provider 的全部 root + wire bridge。 */
function entryMembershipAgents(
  entry: ModelCatalogOverrideEntry,
  providerId: string,
): RootAgentKind[] {
  const policy = MODEL_PLANE_POLICIES.get(providerId);
  if (!policy) return [];
  return entry.agents ?? [...new Set([...policy.roots, ...policy.membershipGatedBridges])];
}

/** entry 实际落实体的 roots；派生端只作为 membership，不接受直接写实体。 */
function entryRootAgents(entry: ModelCatalogOverrideEntry, providerId: string): RootAgentKind[] {
  const policy = MODEL_PLANE_POLICIES.get(providerId);
  if (!policy) return [];
  const membership = entryMembershipAgents(entry, providerId);
  return policy.roots.filter((agent) => membership.includes(agent));
}

function overlayFields(model: CatalogModel, f: ModelCatalogOverrideFields): CatalogModel | string {
  if (f.efforts?.length === 0 && f.defaultEffort !== undefined && f.defaultEffort !== null) {
    return 'local patch sets a defaultEffort for a fixed-effort model';
  }
  let next: CatalogModel = {
    ...model,
    ...(f.name !== undefined ? { name: f.name } : {}),
    ...(f.group !== undefined ? { group: f.group } : {}),
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.sortOrder !== undefined ? { sortOrder: f.sortOrder } : {}),
    ...(f.contextWindow !== undefined
      ? { contextWindow: f.contextWindow, contextWindowVerified: true }
      : {}),
    ...(f.maxOutput !== undefined ? { maxOutput: f.maxOutput } : {}),
    ...(f.efforts !== undefined ? { efforts: f.efforts } : {}),
    ...(f.defaultEffort !== undefined ? { defaultEffort: f.defaultEffort } : {}),
    ...(f.supportsFastMode !== undefined ? { supportsFastMode: f.supportsFastMode } : {}),
    ...(f.status !== undefined
      ? { status: f.status === 'preview' ? ('alpha' as const) : f.status }
      : {}),
  };
  if (next.efforts.length === 0) next = { ...next, defaultEffort: null };
  else if (next.defaultEffort === null || !next.efforts.includes(next.defaultEffort)) {
    return 'local patch leaves defaultEffort outside effective efforts';
  }
  return next;
}

/**
 * 把本地 overrides 应用到某 (providerId, rootAgent) 的 root 清单。
 * 顺序:addition 整条替换/追加(压过 remote/discovery,含复活远端 retired 标记)
 * → patch 逐字段覆盖(dormant:无宿主不生效)。返回新数组,输入不变。
 */
export function applyLocalOverridesToRoot(
  providerId: string,
  agent: RootAgentKind,
  models: readonly CatalogModel[],
  overrides: ModelCatalogOverrides,
  warnings: ModelPlaneWarning[] = [],
): CatalogModel[] {
  let out = [...models];
  for (const [key, entry] of Object.entries(overrides.additions)) {
    const parsed = parseKey(key);
    if (!parsed || parsed.providerId !== providerId) continue;
    if (!entryRootAgents(entry, providerId).includes(agent)) continue;
    const model = additionModelFor(parsed.modelId, entry, agent);
    if (!model) continue; // sanitize 已保证自洽;防御留档。
    const index = out.findIndex((m) => m.id === parsed.modelId);
    if (index >= 0)
      out[index] = model; // 整条压过(含 retired 复活),不混字段。
    else out.push(model);
  }
  for (const [key, entry] of Object.entries(overrides.patches)) {
    const parsed = parseKey(key);
    if (!parsed || parsed.providerId !== providerId) continue;
    if (!entryRootAgents(entry, providerId).includes(agent)) continue;
    const index = out.findIndex((m) => m.id === parsed.modelId);
    if (index < 0) continue; // dormant:宿主出现当日自动生效。
    // patch 不复活远端 retired(status 字段仍会被 retired 标记流程压回;见
    // active-catalog 的 retired 应用顺序):这里只做逐字段覆盖。
    const patched = overlayFields(out[index], effectiveFields(entry, agent));
    if (typeof patched === 'string') {
      warnings.push({
        source: 'local',
        providerId,
        agent,
        modelId: parsed.modelId,
        reason: patched,
      });
      continue;
    }
    out[index] = patched;
  }
  return out;
}

/**
 * 对单个已存在 root 模型重放本地最终层。完整 addition 整条替换，patch 随后逐字段覆盖；
 * Pi 在切换到 Registry entry baseline 后用它恢复与最终 root 相同的 local > remote 优先级。
 */
export function applyLocalOverridesToRootModel(
  providerId: string,
  agent: RootAgentKind,
  model: CatalogModel,
  overrides: ModelCatalogOverrides,
  warnings: ModelPlaneWarning[] = [],
): CatalogModel {
  const key = `${providerId}:${model.id}`;
  let out = model;
  const addition = overrides.additions[key];
  if (addition && entryRootAgents(addition, providerId).includes(agent)) {
    out = additionModelFor(model.id, addition, agent) ?? out;
  }
  const patch = overrides.patches[key];
  if (!patch || !entryRootAgents(patch, providerId).includes(agent)) return out;
  const patched = overlayFields(out, effectiveFields(patch, agent));
  if (typeof patched !== 'string') return patched;
  warnings.push({
    source: 'local',
    providerId,
    agent,
    modelId: model.id,
    reason: patched,
  });
  return out;
}

/**
 * 对 Registry retired root 重放与 active-catalog 相同的最终层顺序。
 * 完整 addition 可显式复活；仅有 patch 时无论其 status 写什么都重新压回 tombstone。
 */
export function applyLocalOverridesToRetiredRootModel(
  providerId: string,
  agent: RootAgentKind,
  model: CatalogModel,
  overrides: ModelCatalogOverrides,
  warnings: ModelPlaneWarning[] = [],
): CatalogModel {
  const overlaid = applyLocalOverridesToRootModel(providerId, agent, model, overrides, warnings);
  return hasLocalAddition(overrides, providerId, model.id, agent)
    ? overlaid
    : { ...overlaid, status: 'retired' };
}

/**
 * root 投影到 bridge 后，应用目标消费端的本地 perAgent/base patch。顺序仍是
 * addition → patch；bridge 的 ID/effort/fast 硬约束由 active-catalog 最后收口。
 */
export function applyLocalConsumerOverrides(
  providerId: string,
  consumer: RootAgentKind,
  rootModelId: string,
  model: CatalogModel,
  overrides: ModelCatalogOverrides,
  warnings: ModelPlaneWarning[] = [],
): CatalogModel {
  let out = model;
  for (const section of ['additions', 'patches'] as const) {
    const entry = overrides[section][`${providerId}:${rootModelId}`];
    if (!entry || !entryMembershipAgents(entry, providerId).includes(consumer)) continue;
    const patched = overlayFields(out, effectiveFields(entry, consumer));
    if (typeof patched === 'string') {
      warnings.push({
        source: 'local',
        providerId,
        agent: consumer,
        modelId: rootModelId,
        reason: patched,
      });
      continue;
    }
    out = patched;
  }
  return out;
}

/**
 * 把本地 membership 叠到远端 bridge 排除集。完整 addition 总是拥有整条本地
 * membership；patch 只有显式写 agents 时才覆盖远端 membership，缺省继续继承远端。
 */
export function resolveLocalBridgeExclusions(
  providerId: string,
  bridgeAgent: RootAgentKind,
  remoteExcluded: ReadonlySet<string>,
  overrides: ModelCatalogOverrides,
): Set<string> {
  const out = new Set(remoteExcluded);
  for (const section of ['additions', 'patches'] as const) {
    for (const [key, entry] of Object.entries(overrides[section])) {
      const parsed = parseKey(key);
      if (!parsed || parsed.providerId !== providerId) continue;
      if (entryRootAgents(entry, providerId).length === 0) continue;
      if (section === 'patches' && entry.agents === undefined) continue;
      if (entryMembershipAgents(entry, providerId).includes(bridgeAgent)) {
        out.delete(parsed.modelId);
      } else {
        out.add(parsed.modelId);
      }
    }
  }
  return out;
}

/** 该 key 是否存在完整 local addition(active-catalog 用它豁免 retired 压标)。 */
export function hasLocalAddition(
  overrides: ModelCatalogOverrides,
  providerId: string,
  modelId: string,
  agent: RootAgentKind,
): boolean {
  const entry = overrides.additions[`${providerId}:${modelId}`];
  if (!entry) return false;
  return entryRootAgents(entry, providerId).includes(agent);
}
