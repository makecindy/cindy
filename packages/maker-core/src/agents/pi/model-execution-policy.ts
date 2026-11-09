/**
 * model-execution-policy —— 子代理模型执行授权的 Host 侧唯一事实源。
 *
 * 背景(2026-11-07 取证):yjhl 会话的 Lead 在 `subagent` 工具里自由指定了
 * `openrouter-a3fe858b + deepseek/deepseek-v4-flash`,一笔 1,364,351 token 的付费
 * 调用直接打出。`bot-model-chain` 只管 Bot 主路由,不管子代理;子代理的
 * `(provider, model)` 选择由 pi 扩展在进程内完成,Host 只提供「可用路由表」
 * (modelRoutes = availability,不是 authorization)。本模块把授权收敛到一处:
 *
 *   - 模型出现在 modelRoutes 里 ≠ 被授权执行。授权 = 显式 allow-list +
 *     (付费时)Host 发起、用户批准、带时限的 approval。
 *   - 默认拒绝。快照缺失 / 解析失败 / 字段异常一律 deny,不退回 pi 默认解析。
 *   - 「免费」「便宜」不构成授权;「用其他模型协作」这类模糊文本从不被读取。
 *   - Agent 无权创建 approval:approval 只能由 Host 的用户设置入口写入
 *     (见 subagent-model-approvals-store),本模块只读裁决。
 *
 * 消费方:
 *   - pi 扩展的 resolveTaskModelRoutes(派发前第一道检查,见 cindy-subagent-source):
 *     逐字镜像本文件的判定逻辑(扩展不能 import 本模块,保持同步的约束见
 *     cindy-subagent-source.ts 文件头)。
 *   - Host 侧(pi/index.ts)在写运行期快照时生成 snapshot;desktop host 负责
 *     从 bot-model-chain + approvals store 组装 allowedRoutes。
 *   - durable runner 在 spawn 前第二道检查(见 cindy-subagent-runner-source)。
 */

export const MODEL_EXECUTION_POLICY_VERSION = 1;

export type ModelExecutionMode = 'local-only' | 'development' | 'approved-paid';

export type ModelRouteTier = 'local' | 'free' | 'paid';

export interface AllowedModelRoute {
  /** pi 内部 provider id(路由解析后真正执行的 provider)。 */
  provider: string;
  /** 模型 id(与 modelRoutes 的 key 一致,大小写敏感原文)。 */
  model: string;
  /** 供应商来源 id(跨设备共享等场景的权威归属;缺省 = provider)。 */
  sourceProviderId?: string;
  tier: ModelRouteTier;
}

/**
 * Host 发起、用户批准的临时授权。scope 限定到 session 或 project(目录树),
 * 过期 / 金额上限均为硬约束;Agent 不能写入本结构。
 */
export interface ModelExecutionApproval {
  id: string;
  provider: string;
  model: string;
  sourceProviderId?: string;
  scope: 'session' | 'project';
  sessionId?: string;
  projectRoot?: string;
  grantedBy: 'user';
  grantedAt: number;
  expiresAt: number;
  maxCostUsd?: number;
}

export interface ModelExecutionPolicySnapshot {
  version: typeof MODEL_EXECUTION_POLICY_VERSION;
  sessionId: string;
  projectRoot?: string;
  mode: ModelExecutionMode;
  /** 恒为真地包含父路由(继承模型是协作默认,不需要额外审批)。 */
  allowedRoutes: AllowedModelRoute[];
  approvals: ModelExecutionApproval[];
  /** 快照生成时间(审计用)。 */
  issuedAt: number;
}

export type ModelExecutionDecision =
  | { allowed: true; approvalId?: string; reason: string }
  | { allowed: false; approvalId?: undefined; reason: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 归一化一条 route;任何字段不合规都返回 null(整条丢弃,调用方 fail-closed)。 */
export function normalizeAllowedRoute(raw: unknown): AllowedModelRoute | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!nonEmptyString(record.provider) || !nonEmptyString(record.model)) return null;
  const tier = record.tier;
  if (tier !== 'local' && tier !== 'free' && tier !== 'paid') return null;
  return {
    provider: record.provider.trim(),
    model: record.model.trim(),
    ...(nonEmptyString(record.sourceProviderId) ? { sourceProviderId: record.sourceProviderId.trim() } : {}),
    tier,
  };
}

/** 归一化一条 approval;字段不合规返回 null。 */
export function normalizeApproval(raw: unknown): ModelExecutionApproval | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!nonEmptyString(record.id) || !nonEmptyString(record.provider) || !nonEmptyString(record.model)) {
    return null;
  }
  if (record.grantedBy !== 'user') return null;
  const scope = record.scope;
  if (scope !== 'session' && scope !== 'project') return null;
  if (scope === 'session' && !nonEmptyString(record.sessionId)) return null;
  if (scope === 'project' && !nonEmptyString(record.projectRoot)) return null;
  const grantedAt = record.grantedAt;
  const expiresAt = record.expiresAt;
  if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= grantedAt) return null;
  const maxCostUsd = record.maxCostUsd;
  if (maxCostUsd !== undefined && (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
    return null;
  }
  return {
    id: record.id.trim(),
    provider: record.provider.trim(),
    model: record.model.trim(),
    ...(nonEmptyString(record.sourceProviderId) ? { sourceProviderId: record.sourceProviderId.trim() } : {}),
    scope,
    ...(nonEmptyString(record.sessionId) ? { sessionId: record.sessionId.trim() } : {}),
    ...(nonEmptyString(record.projectRoot) ? { projectRoot: record.projectRoot.trim() } : {}),
    grantedBy: 'user',
    grantedAt,
    expiresAt,
    ...(typeof maxCostUsd === 'number' ? { maxCostUsd } : {}),
  };
}

/**
 * 快照解析:任何结构性错误都返回 null —— 调用方必须 fail-closed(拒绝派发),
 * 不能把坏快照当成"无策略"放行。
 */
export function parseModelExecutionPolicy(raw: unknown): ModelExecutionPolicySnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== MODEL_EXECUTION_POLICY_VERSION) return null;
  if (!nonEmptyString(record.sessionId)) return null;
  const mode = record.mode;
  if (mode !== 'local-only' && mode !== 'development' && mode !== 'approved-paid') return null;
  if (!Array.isArray(record.allowedRoutes) || !Array.isArray(record.approvals)) return null;
  const allowedRoutes: AllowedModelRoute[] = [];
  for (const entry of record.allowedRoutes) {
    const route = normalizeAllowedRoute(entry);
    if (!route) return null;
    allowedRoutes.push(route);
  }
  const approvals: ModelExecutionApproval[] = [];
  for (const entry of record.approvals) {
    const approval = normalizeApproval(entry);
    if (!approval) return null;
    approvals.push(approval);
  }
  const issuedAt = record.issuedAt;
  return {
    version: MODEL_EXECUTION_POLICY_VERSION,
    sessionId: record.sessionId.trim(),
    ...(nonEmptyString(record.projectRoot) ? { projectRoot: record.projectRoot.trim() } : {}),
    mode,
    allowedRoutes,
    approvals,
    issuedAt: typeof issuedAt === 'number' && Number.isFinite(issuedAt) ? issuedAt : 0,
  };
}

function routeMatches(
  route: { provider: string; model: string; sourceProviderId?: string },
  requested: { provider: string; model: string; sourceProviderId?: string },
): boolean {
  if (route.provider !== requested.provider || route.model !== requested.model) return false;
  // allow-list 条目不带 source 时覆盖该 provider 下任何来源(子代理继承父路由时
  // 来源可能被网关改写);双方都带来源时必须一致(别名/跨设备同名不作数)。
  if (route.sourceProviderId && requested.sourceProviderId) return route.sourceProviderId === requested.sourceProviderId;
  return true;
}

/**
 * 执行授权裁决。纯函数,Host 与(镜像的)扩展检查共用同一语义。
 *
 * 判定顺序:
 *  1. 快照无效 → deny(fail-closed)。
 *  2. 请求路由命中 allowedRoutes:
 *     - local → 任何 mode 放行。
 *     - free → development / approved-paid 放行;local-only 拒绝。
 *     - paid → approved-paid 放行;其余拒绝("免费不是授权,付费更需要审批")。
 *  3. 未命中 → 查 approvals:同 (provider, model[, source]),
 *     scope 匹配本 session/project、未过期、未超 maxCostUsd(由 Host 在记账时复核,
 *     此处只校验时限与 scope) → 放行并带回 approvalId。
 *  4. 其余 → deny。
 *
 * 注:模糊的用户文本(如"用其他模型协作")不进入本函数;授权只能来自
 * allowedRoutes(用户在设置中显式列入 model chain /  allow-list)或 approvals
 * (Host 设置入口写入的带时限批准)。
 */
export function decideModelExecution(
  snapshot: ModelExecutionPolicySnapshot | null,
  requested: { provider: string; model: string; sourceProviderId?: string },
  now = Date.now(),
): ModelExecutionDecision {
  if (!snapshot) {
    return { allowed: false, reason: 'model execution policy snapshot is missing or invalid; refusing to dispatch' };
  }
  const provider = requested.provider?.trim() ?? '';
  const model = requested.model?.trim() ?? '';
  if (!provider || !model) {
    return { allowed: false, reason: 'requested provider/model is empty; refusing to dispatch' };
  }
  const requestedNorm = { provider, model, sourceProviderId: requested.sourceProviderId?.trim() || undefined };
  for (const route of snapshot.allowedRoutes) {
    if (!routeMatches(route, requestedNorm)) continue;
    if (route.tier === 'local') {
      return { allowed: true, reason: 'local route is allowed in every mode' };
    }
    if (route.tier === 'free') {
      if (snapshot.mode === 'local-only') {
        return {
          allowed: false,
          reason: `cloud route "${provider}/${model}" requires development mode; free is not authorization (session mode is local-only)`,
        };
      }
      return { allowed: true, reason: 'explicitly allow-listed free route' };
    }
    if (snapshot.mode !== 'approved-paid') {
      return {
        allowed: false,
        reason: `paid route "${provider}/${model}" is not approved for this session; a time-boxed user approval is required`,
      };
    }
    return { allowed: true, reason: 'explicitly allow-listed paid route under approved-paid mode' };
  }
  for (const approval of snapshot.approvals) {
    if (!routeMatches(approval, requestedNorm)) continue;
    if (approval.scope === 'session' && approval.sessionId !== snapshot.sessionId) continue;
    if (approval.scope === 'project'
      && (!snapshot.projectRoot || !approval.projectRoot || !isWithinProject(snapshot.projectRoot, approval.projectRoot))) {
      continue;
    }
    if (now < approval.grantedAt || now > approval.expiresAt) continue;
    return {
      allowed: true,
      approvalId: approval.id,
      reason: `time-boxed approval ${approval.id} covers this route`,
    };
  }
  return {
    allowed: false,
    reason: `route "${provider}/${model}" is not in this session's model execution allow-list`,
  };
}

/** projectRoot 是否位于 approval.projectRoot 子树内(或相等)。路径比较用 POSIX/Win 归一化后的前缀,不做模糊匹配。 */
export function isWithinProject(projectRoot: string, approvalRoot: string): boolean {
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const project = normalize(projectRoot);
  const approval = normalize(approvalRoot);
  if (!project || !approval) return false;
  return project === approval || project.startsWith(approval + '/');
}
