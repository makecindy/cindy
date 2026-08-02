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

import { MODEL_PLANE_POLICIES, type RootAgentKind } from './modelPlanePolicy.js';

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
const OVERRIDE_STATUSES: ReadonlySet<string> = new Set(['active', 'alpha', 'deprecated']);

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
  status?: 'active' | 'alpha' | 'deprecated';
}

export interface ModelCatalogOverrideEntry {
  /** 作用的 root agent;缺省 = 该 provider policy 的全部 roots。 */
  agents?: RootAgentKind[];
  base?: ModelCatalogOverrideFields;
  perAgent?: Partial<Record<RootAgentKind, ModelCatalogOverrideFields>>;
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
  return { providerId, modelId };
}

function sanitizeFields(raw: unknown): ModelCatalogOverrideFields | null {
  if (!isPlainObject(raw)) return null;
  const out: ModelCatalogOverrideFields = {};
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case 'name':
      case 'group':
      case 'description':
        if (typeof v !== 'string' || v.length === 0 || v.length > 2_000) return null;
        out[k] = v;
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
        if (!Array.isArray(v) || v.some((e) => typeof e !== 'string' || !VALID_EFFORTS.has(e)))
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
        const sanitized = sanitizeFields(fields);
        if (!sanitized) return null;
        perAgent[agent] = sanitized;
      }
      out.perAgent = perAgent;
    } else {
      return null;
    }
  }
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
  if (f.efforts.length === 0) defaultEffort = null;
  else if (f.defaultEffort != null && f.efforts.includes(f.defaultEffort)) {
    defaultEffort = f.defaultEffort;
  } else return null;
  return {
    id: modelId,
    name: f.name,
    ...(f.group !== undefined ? { group: f.group } : {}),
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.sortOrder !== undefined ? { sortOrder: f.sortOrder } : {}),
    contextWindow: f.contextWindow,
    ...(f.maxOutput !== undefined ? { maxOutput: f.maxOutput } : {}),
    efforts: f.efforts,
    defaultEffort,
    ...(f.supportsFastMode !== undefined ? { supportsFastMode: f.supportsFastMode } : {}),
    ...(f.status !== undefined ? { status: f.status } : {}),
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
      if (section === 'additions') {
        // addition 必须在其作用的每个 root 上都自洽完整,否则整条隔离。
        const agents = entryAgents(entry, parsed.providerId);
        if (
          agents.length === 0 ||
          agents.some((agent) => additionModelFor(parsed.modelId, entry, agent) === null)
        ) {
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

/** entry 作用的 root agents = (声明的 agents ?? policy roots) ∩ policy roots。 */
function entryAgents(entry: ModelCatalogOverrideEntry, providerId: string): RootAgentKind[] {
  const policy = MODEL_PLANE_POLICIES.get(providerId);
  if (!policy) return [];
  const declared = entry.agents ?? policy.roots;
  return declared.filter((agent) => policy.roots.includes(agent));
}

function overlayFields(model: CatalogModel, f: ModelCatalogOverrideFields): CatalogModel {
  return {
    ...model,
    ...(f.name !== undefined ? { name: f.name } : {}),
    ...(f.group !== undefined ? { group: f.group } : {}),
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.sortOrder !== undefined ? { sortOrder: f.sortOrder } : {}),
    ...(f.contextWindow !== undefined ? { contextWindow: f.contextWindow } : {}),
    ...(f.maxOutput !== undefined ? { maxOutput: f.maxOutput } : {}),
    ...(f.efforts !== undefined ? { efforts: f.efforts } : {}),
    ...(f.defaultEffort !== undefined ? { defaultEffort: f.defaultEffort } : {}),
    ...(f.supportsFastMode !== undefined ? { supportsFastMode: f.supportsFastMode } : {}),
    ...(f.status !== undefined ? { status: f.status } : {}),
  };
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
): CatalogModel[] {
  let out = [...models];
  for (const [key, entry] of Object.entries(overrides.additions)) {
    const parsed = parseKey(key);
    if (!parsed || parsed.providerId !== providerId) continue;
    if (!entryAgents(entry, providerId).includes(agent)) continue;
    const model = additionModelFor(parsed.modelId, entry, agent);
    if (!model) continue; // sanitize 已保证自洽;防御留档。
    const index = out.findIndex((m) => m.id === parsed.modelId);
    if (index >= 0) out[index] = model; // 整条压过(含 retired 复活),不混字段。
    else out.push(model);
  }
  for (const [key, entry] of Object.entries(overrides.patches)) {
    const parsed = parseKey(key);
    if (!parsed || parsed.providerId !== providerId) continue;
    if (!entryAgents(entry, providerId).includes(agent)) continue;
    const index = out.findIndex((m) => m.id === parsed.modelId);
    if (index < 0) continue; // dormant:宿主出现当日自动生效。
    // patch 不复活远端 retired(status 字段仍会被 retired 标记流程压回;见
    // active-catalog 的 retired 应用顺序):这里只做逐字段覆盖。
    out[index] = overlayFields(out[index], effectiveFields(entry, agent));
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
  return entryAgents(entry, providerId).includes(agent);
}
