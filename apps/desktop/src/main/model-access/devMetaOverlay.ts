/**
 * devMetaOverlay —— dev 模式下用本地目录文件的 `cindyModelMeta` 段覆盖服务端
 * 下发的 XD 网关模型元数据。
 * ---------------------------------------------------------------------------
 * 背景:XD 模型的产品元数据权威在服务端(model-access-server 内置基线 + OSS
 * `cfg/providers.json` 顶层 `cindyModelMeta` 远程覆盖表,GET /models 合并下发)。
 * 改元数据要「发 OSS → 等服务端热加载」,dev 自测太重。本模块让 dev 环境像
 * providers.json 的其它段一样直接吃本地文件:改仓内
 * `packages/model-providers/catalog/providers.json` 的 cindyModelMeta → 重启
 * dev 实例即可在 Cindy AI 模型列表看到效果。**packaged 一律不走本覆盖**
 * (调用点用 isDev() 门控,见 model-access/index.ts applyGatewayModels)。
 *
 * 合并语义与服务端 listGatewayChatModels 逐条对齐(服务端仓
 * services/modelAccess.ts):
 *   - **只覆盖服务端清单里已存在的 id**——清单成员资格仍由网关证明可用性,
 *     本地表多出的 id 不会凭空出现在列表里;
 *   - contextWindow / maxOutputTokens 网关上报权威:保留服务端条目的值,本地
 *     entry.contextWindow 仅在服务端条目没有时兜底(与服务端规则一致)。注意
 *     wire 上无法区分服务端条目的 contextWindow 是网关上报还是服务端元数据表
 *     兜底——若网关未报而服务端表补了值,本地改 contextWindow 不会生效(服务端
 *     值粘住),这是 dev 覆盖的固有限制,不是 bug;
 *   - 其余展示元数据(agents/name/group/description/efforts/defaultEffort/
 *     sortOrder/supportsFastMode/defaultEnabled/perAgent)整体以本地条目为准,
 *     替换服务端下发的对应字段(模拟「服务端远程表登记了该条目」的下发结果);
 *   - 条目为 null = 撤销登记:剥掉全部元数据只留网关权威字段,客户端回落
 *     确定性默认(见 active-catalog computeMerged 的 xd 重建);
 *   - 信封 / 条目非法:整份或单条跳过并 warn,保留服务端原值——dev 工具绝不
 *     让坏数据把列表弄坏,校验规则镜像服务端 modelMetadataSource parseEntry。
 */

import type {
  ModelAccessAgentOverride,
  ModelAccessGatewayModel,
} from '../../shared/modelAccess.js';

type Agent = 'claude-code' | 'codex';

const VALID_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'codex']);
/** 与服务端 modelMetadataSource / active-catalog 同一套 effort 口径。 */
const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

/** 覆盖日志回调(生产接统一 logger;测试可缺省)。 */
export interface OverlayLog {
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 去掉可由 dev 元数据覆盖的展示、归属和能力字段，保留 token 上限和全部
 * Gateway 价格。这样本地 overlay 或 null 撤销登记都不会把同快照里的价格静默丢掉。
 */
function gatewayFields(m: ModelAccessGatewayModel): ModelAccessGatewayModel {
  const fields = { ...m };
  delete fields.agents;
  delete fields.name;
  delete fields.group;
  delete fields.description;
  delete fields.icon;
  delete fields.efforts;
  delete fields.defaultEffort;
  delete fields.sortOrder;
  delete fields.supportsFastMode;
  delete fields.defaultEnabled;
  delete fields.perAgent;
  return fields;
}

/** 校验并拷贝 override 形态的能力字段(基线与 perAgent 共用);非法返回原因。 */
function readOverrideFields(
  o: Record<string, unknown>,
  out: ModelAccessAgentOverride,
): string | null {
  if (o.contextWindow !== undefined) {
    if (typeof o.contextWindow !== 'number' || !Number.isFinite(o.contextWindow) || o.contextWindow <= 0) {
      return 'contextWindow 必须是正数';
    }
    out.contextWindow = o.contextWindow;
  }
  if (o.efforts !== undefined) {
    if (!Array.isArray(o.efforts) || o.efforts.some((e) => typeof e !== 'string' || !VALID_EFFORTS.has(e))) {
      return `efforts 只允许 ${[...VALID_EFFORTS].join('/')}`;
    }
    out.efforts = o.efforts as string[];
  }
  if (o.defaultEffort !== undefined) {
    if (
      o.defaultEffort !== null &&
      (typeof o.defaultEffort !== 'string' || !VALID_EFFORTS.has(o.defaultEffort))
    ) {
      return 'defaultEffort 非法';
    }
    out.defaultEffort = o.defaultEffort as string | null;
  }
  if (o.supportsFastMode !== undefined) {
    if (typeof o.supportsFastMode !== 'boolean') return 'supportsFastMode 必须是布尔';
    out.supportsFastMode = o.supportsFastMode;
  }
  if (o.defaultEnabled !== undefined) {
    if (typeof o.defaultEnabled !== 'boolean') return 'defaultEnabled 必须是布尔';
    out.defaultEnabled = o.defaultEnabled;
  }
  return null;
}

/** 元数据条目(不含 id)——ModelAccessGatewayModel 去掉网关权威字段的形态。 */
type MetaEntry = Omit<ModelAccessGatewayModel, 'id' | 'maxOutputTokens'>;

/** 解析单个本地元数据条目;非法返回原因字符串(镜像服务端 parseEntry 规则)。 */
function parseEntry(raw: unknown): { meta: MetaEntry } | { reason: string } {
  if (!isPlainObject(raw)) return { reason: '条目必须是对象或 null' };
  if (
    !Array.isArray(raw.agents) ||
    raw.agents.length === 0 ||
    raw.agents.some((a) => typeof a !== 'string' || !VALID_AGENTS.has(a))
  ) {
    return { reason: 'agents 必须是非空数组,取值 claude-code/codex' };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) return { reason: 'name 必须是非空字符串' };

  const meta: MetaEntry = { agents: raw.agents as Agent[], name: raw.name };
  for (const k of ['group', 'description', 'icon'] as const) {
    if (raw[k] !== undefined) {
      if (typeof raw[k] !== 'string') return { reason: `${k} 必须是字符串` };
      meta[k] = raw[k] as string;
    }
  }
  if (raw.sortOrder !== undefined) {
    if (typeof raw.sortOrder !== 'number' || !Number.isFinite(raw.sortOrder)) {
      return { reason: 'sortOrder 必须是数字' };
    }
    meta.sortOrder = raw.sortOrder;
  }
  const baseErr = readOverrideFields(raw, meta);
  if (baseErr) return { reason: baseErr };

  if (raw.perAgent !== undefined) {
    if (!isPlainObject(raw.perAgent)) return { reason: 'perAgent 必须是对象' };
    const perAgent: Partial<Record<Agent, ModelAccessAgentOverride>> = {};
    for (const [agent, ov] of Object.entries(raw.perAgent)) {
      if (!VALID_AGENTS.has(agent)) return { reason: `perAgent 键非法: ${agent}` };
      if (!isPlainObject(ov)) return { reason: `perAgent.${agent} 必须是对象` };
      const parsed: ModelAccessAgentOverride = {};
      const err = readOverrideFields(ov, parsed);
      if (err) return { reason: `perAgent.${agent}: ${err}` };
      perAgent[agent as Agent] = parsed;
    }
    meta.perAgent = perAgent;
  }
  return { meta };
}

/** 以本地条目重建服务端下发条目(网关权威字段保留,元数据字段整体替换)。 */
function rebuildModel(m: ModelAccessGatewayModel, meta: MetaEntry): ModelAccessGatewayModel {
  return {
    ...gatewayFields(m),
    // 网关上报的 token 上限权威;本地 contextWindow 仅在服务端条目缺失时兜底(同服务端规则)。
    ...(m.contextWindow === undefined && meta.contextWindow !== undefined
      ? { contextWindow: meta.contextWindow }
      : {}),
    agents: meta.agents,
    name: meta.name,
    ...(meta.group ? { group: meta.group } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.icon ? { icon: meta.icon } : {}),
    ...(meta.efforts ? { efforts: meta.efforts } : {}),
    ...(meta.defaultEffort !== undefined ? { defaultEffort: meta.defaultEffort } : {}),
    ...(meta.sortOrder !== undefined ? { sortOrder: meta.sortOrder } : {}),
    ...(meta.supportsFastMode !== undefined ? { supportsFastMode: meta.supportsFastMode } : {}),
    ...(meta.defaultEnabled !== undefined ? { defaultEnabled: meta.defaultEnabled } : {}),
    ...(meta.perAgent ? { perAgent: meta.perAgent } : {}),
  };
}

/**
 * 用本地 cindyModelMeta 信封覆盖服务端下发的网关模型清单(纯函数)。
 * 信封非法 → 原样返回;条目非法 → 跳过该条保留服务端原值(warn)。
 */
export function overlayCindyModelMeta(
  models: ModelAccessGatewayModel[],
  envelope: unknown,
  log?: OverlayLog,
): ModelAccessGatewayModel[] {
  if (!isPlainObject(envelope) || envelope.version !== 1 || !isPlainObject(envelope.models)) {
    if (envelope !== undefined) {
      log?.warn('local cindyModelMeta envelope invalid; dev overlay skipped');
    }
    return models;
  }
  const table = envelope.models;
  let overridden = 0;
  let revoked = 0;
  const out = models.map((m) => {
    if (!Object.hasOwn(table, m.id)) return m; // hasOwn:防模型 id 撞原型链属性(toString 等)
    const raw = table[m.id];
    if (raw === null) {
      // 撤销登记:剥掉全部元数据,只留网关权威字段(客户端回落确定性默认)。
      revoked += 1;
      return gatewayFields(m);
    }
    const parsed = parseEntry(raw);
    if ('reason' in parsed) {
      log?.warn('local cindyModelMeta entry invalid; keeping server value', {
        id: m.id,
        reason: parsed.reason,
      });
      return m;
    }
    overridden += 1;
    return rebuildModel(m, parsed.meta);
  });
  if (overridden > 0 || revoked > 0) {
    log?.info('dev cindyModelMeta overlay applied', { overridden, revoked, total: models.length });
  }
  return out;
}
