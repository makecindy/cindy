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
 *     从 bot-model-chain + approvals store 组装 allowedRoutes 并签名。
 *   - durable runner 在 spawn 前第二道检查(见 cindy-subagent-runner-source)。
 *
 * 快照签名(P1-8 / P0-B):Host 只在可信边界(Desktop 主进程)做**授权判断**并用
 * Ed25519 私钥签名;扩展/runner 只凭**公钥**验签,密钥文件从不下发给同权限的
 * Agent/Runner(P0-B:0600 ≠ 进程隔离)。Agent 即使有 shell / 文件读写,也只能
 * 读到公钥,无法伪造 Host 授权;签名、session 绑定、24h 时效三重校验。
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';

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
  /** Host Ed25519 签名(对 canonicalExecutionPolicy 编码后的签名,hex);缺失即拒绝。 */
  signature?: string;
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
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  const signatureRaw = record.signature;
  if (signatureRaw !== undefined && (typeof signatureRaw !== 'string' || !/^[0-9a-f]{128}$/.test(signatureRaw))) {
    return null;
  }
  return {
    version: MODEL_EXECUTION_POLICY_VERSION,
    sessionId: record.sessionId.trim(),
    ...(nonEmptyString(record.projectRoot) ? { projectRoot: record.projectRoot.trim() } : {}),
    mode,
    allowedRoutes,
    approvals,
    issuedAt,
    ...(typeof signatureRaw === 'string' ? { signature: signatureRaw } : {}),
  };
}

/**
 * 快照 canonical 编码:HMAC 的被签内容。字段顺序固定,数组顺序保留,
 * 可选字段缺失时省略 —— Host 签名与扩展/runner 校验必须逐字一致。
 */
export function canonicalExecutionPolicy(snapshot: ModelExecutionPolicySnapshot): string {
  return JSON.stringify({
    version: snapshot.version,
    sessionId: snapshot.sessionId,
    projectRoot: snapshot.projectRoot ?? null,
    mode: snapshot.mode,
    allowedRoutes: snapshot.allowedRoutes.map((route) => ({
      provider: route.provider,
      model: route.model,
      ...(route.sourceProviderId ? { sourceProviderId: route.sourceProviderId } : {}),
      tier: route.tier,
    })),
    approvals: snapshot.approvals.map((approval) => ({
      id: approval.id,
      provider: approval.provider,
      model: approval.model,
      ...(approval.sourceProviderId ? { sourceProviderId: approval.sourceProviderId } : {}),
      scope: approval.scope,
      ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
      ...(approval.projectRoot ? { projectRoot: approval.projectRoot } : {}),
      grantedBy: approval.grantedBy,
      grantedAt: approval.grantedAt,
      expiresAt: approval.expiresAt,
      ...(approval.maxCostUsd !== undefined ? { maxCostUsd: approval.maxCostUsd } : {}),
    })),
    issuedAt: snapshot.issuedAt,
  });
}

export interface ExecutionPolicyKeyPair {
  /** SPKI DER base64,仅公钥,可安全分发给 verifier。 */
  publicKey: string;
  /** PKCS8 DER base64,只能在可信 Host 边界保存与使用。 */
  secretKey: string;
}

export function createExecutionPolicyKeyPair(): ExecutionPolicyKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    secretKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** Host 侧签名(唯一持私钥处);调用方必须先 `parseModelExecutionPolicy` 校验结构。 */
export function signExecutionPolicySnapshot(snapshot: ModelExecutionPolicySnapshot, secretKeyB64: string): string {
  const secretKey = createPrivateKey({ key: Buffer.from(secretKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return ed25519Sign(null, Buffer.from(canonicalExecutionPolicy(snapshot), 'utf8'), secretKey).toString('hex');
}

/**
 * 完整校验:结构 + Ed25519 签名 + session 绑定 + 时效。任一失败返回 null;
 * 调用方据此 fail-closed。publicKeyB64 为 Host 公钥(SPKI DER base64)。
 */
export function parseAndVerifyExecutionPolicy(
  raw: unknown,
  publicKeyB64: string | null | undefined,
  expectedSessionId: string | null | undefined,
  now = Date.now(),
): ModelExecutionPolicySnapshot | null {
  const snapshot = parseModelExecutionPolicy(raw);
  if (!snapshot) return null;
  if (!publicKeyB64) return null;
  if (typeof snapshot.signature !== 'string') return null;
  if (!expectedSessionId || snapshot.sessionId !== expectedSessionId) return null;
  if (now - snapshot.issuedAt > EXECUTION_POLICY_MAX_AGE_MS) return null;
  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
  const ok = ed25519Verify(
    null,
    Buffer.from(canonicalExecutionPolicy(snapshot), 'utf8'),
    publicKey,
    Buffer.from(snapshot.signature, 'hex'),
  );
  if (!ok) return null;
  return snapshot;
}

/** 快照最大时效:运行期快照随 setModel 周期性重签,24h 后视为不可信。 */
export const EXECUTION_POLICY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** approval 的记账 scopeKey —— Host 费用累计与扩展/runner 的上限检查共用。 */
export function approvalSpendKey(approval: ModelExecutionApproval, snapshot: ModelExecutionPolicySnapshot): string {
  if (approval.scope === 'session') return `session:${approval.sessionId ?? snapshot.sessionId}`;
  const root = (approval.projectRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return `project:${root}`;
}

function routeMatches(
  route: { provider: string; model: string; sourceProviderId?: string },
  requested: { provider: string; model: string; sourceProviderId?: string },
): boolean {
  if (route.provider !== requested.provider || route.model !== requested.model) return false;
  // source 归属必须精确相等:缺省归属即 provider 自身。任一侧的网关改写只有在
  // 两侧都声明一致来源时才作数 —— 不再以「策略侧未声明来源」为由越过归属。
  const routeSource = route.sourceProviderId ?? route.provider;
  const requestedSource = requested.sourceProviderId ?? requested.provider;
  return routeSource === requestedSource;
}

/**
 * 执行授权裁决。纯函数,Host 与(镜像的)扩展检查共用同一语义。
 *
 * 判定顺序:
 *  1. 快照无效 → deny(fail-closed)。
 *  2. 请求路由命中 allowedRoutes:
 *     - local → 任何 mode 放行。
 *     - free → development / approved-paid 放行;local-only 拒绝。
 *     - paid → approved-paid 放行;其余不立即拒绝,继续走 approval 检查
 *       (development 下的付费路由可用一次已签发 approval 合法执行)。
 *  3. 未命中(或 paid 未获 mode 放行)→ 查 approvals:同 (provider, model, source
 *     精确归属)、scope 匹配本 session/project、未过期、maxCostUsd 未耗尽
 *     (调用方用 spendUsdByApproval 传入已记账金额;未提供则跳过该项)→
 *     放行并带回 approvalId。
 *     ⚠️ P0-A 例外:mode 为 local-only 时**跳过整段 approval 检查** —— 任何
 *     非本地路由在 local-only 下无条件拒绝,临时 approval 不能覆盖;要跑非本地
 *     模型必须由用户显式把 mode 切出 local-only(模式切换只经用户设置入口)。
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
  spendUsdByApproval?: (approval: ModelExecutionApproval) => number | undefined,
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
      // paid 仅被 allow-list 列入但 mode 不允许时不立即拒绝:继续走
      // approval 检查 —— 用户的临时审批可以让 development 下的付费路由合法
      // 执行;没有审批才在最后拒绝。
      break;
    }
    return { allowed: true, reason: 'explicitly allow-listed paid route under approved-paid mode' };
  }
  // P0-A:local-only 硬隔离 —— approvals 不进入判定,任何非本地路由直接拒。
  // (free 路由在上面的 allowedRoutes 循环里已按同规则拒绝,此处覆盖未命中/paid 情形。)
  if (snapshot.mode === 'local-only') {
    return {
      allowed: false,
      reason: `route "${provider}/${model}" is not executable in local-only mode; temporary approvals cannot override local-only`,
    };
  }
  let exhaustedByCap = false;
  for (const approval of snapshot.approvals) {
    if (!routeMatches(approval, requestedNorm)) continue;
    if (approval.scope === 'session' && approval.sessionId !== snapshot.sessionId) continue;
    if (approval.scope === 'project'
      && (!snapshot.projectRoot || !approval.projectRoot || !isWithinProject(snapshot.projectRoot, approval.projectRoot))) {
      continue;
    }
    if (now < approval.grantedAt || now > approval.expiresAt) continue;
    if (approval.maxCostUsd !== undefined && spendUsdByApproval) {
      const spent = spendUsdByApproval(approval);
      if (spent !== undefined && !Number.isFinite(spent)) continue;
      if (spent !== undefined && spent >= approval.maxCostUsd) {
        exhaustedByCap = true;
        continue;
      }
    }
    return {
      allowed: true,
      approvalId: approval.id,
      reason: `time-boxed approval ${approval.id} covers this route`,
    };
  }
  if (exhaustedByCap) {
    return {
      allowed: false,
      reason: `route "${provider}/${model}" approval spend cap reached; request a new capped approval from the user`,
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
