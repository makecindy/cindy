import type {
  AgentCredentialMode,
  ClaudeSubagentModelAccessResult,
} from '@cindy/maker-core';

import { readClaudeApiKey } from './auth-adapters.js';
import {
  getActiveCatalog,
  getXdGatewayModelAccessSnapshot,
} from './active-catalog.js';
import { getDesktopProviderService } from './createDesktopProviderService.js';
import {
  applyExecutionPolicyToClaudeAccess,
  classifyClaudeSubagentModelAccess,
} from './subagent-model-access-policy.js';
import { decideModelExecution, approvalSpendKey } from '@cindy/maker-core';
import { resolveDesktopClaudeSubagentModelExecutionPolicy } from './subagent-model-execution-policy-host.js';
import { readSubagentModelSpend } from './subagent-model-spend.js';

/**
 * ClaudeCodeAgent 的 host 注入入口。每次 PreToolUse 都现场读取 key、权威 XD
 * 快照和 ProviderView，因此账号切换不会复用会话启动时冻结的权限结论。
 */
export async function resolveDesktopClaudeSubagentModelAccess(context: {
  providerId?: string | null;
  parentModel: string;
  credentialMode?: AgentCredentialMode;
  model: string;
  sessionId?: string;
  projectRoot?: string;
}): Promise<ClaudeSubagentModelAccessResult> {
  let availability: ClaudeSubagentModelAccessResult;
  let gatewayKeyAvailable = false;
  try {
    const providers = await getDesktopProviderService().listProviders({
      allowSideEffects: false,
      catalog: getActiveCatalog(),
    });
    gatewayKeyAvailable = Boolean(readClaudeApiKey());
    availability = classifyClaudeSubagentModelAccess({
      providerId: context.providerId,
      credentialMode: context.credentialMode,
      model: context.model,
      gatewayKeyAvailable,
      xdSnapshot: getXdGatewayModelAccessSnapshot(),
      providers,
    });
  } catch {
    availability = { status: 'unknown' };
    try { gatewayKeyAvailable = Boolean(readClaudeApiKey()); } catch { /* gatewayKeyAvailable stays false */ }
  }
  // Phase A:在可用性之上叠加 Host 执行授权(decideModelExecution + 签名快照)。
  // 固定模型(与父模型归一化相等)不受影响;跨模型必须有 allow-list 或有效
  // approval,否则硬拒 —— 不再以「目录里有」代替「被授权」 (2026-11-07 根因)。
  try {
    const providerId = context.providerId?.trim() || null;
    const wasXd = providerId === 'xd'
      || (!providerId && context.credentialMode === 'gateway-key')
      || (!providerId && gatewayKeyAvailable);
    const effectiveProvider = providerId ?? (wasXd ? 'xd' : 'claude-code');
    if (!context.sessionId) {
      return applyExecutionPolicyToClaudeAccess({
        availability,
        policyAllowed: false,
        policyReason: 'model execution policy snapshot is missing or invalid; refusing to dispatch',
        model: context.model,
        parentModel: context.parentModel,
      });
    }
    const snapshot = await resolveDesktopClaudeSubagentModelExecutionPolicy({
      sessionId: context.sessionId,
      ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
      model: context.parentModel,
      provider: effectiveProvider,
      sourceProviderId: effectiveProvider,
    });
    if (!snapshot) {
      return applyExecutionPolicyToClaudeAccess({
        availability,
        policyAllowed: false,
        policyReason: 'model execution policy snapshot is missing or invalid; refusing to dispatch',
        model: context.model,
        parentModel: context.parentModel,
      });
    }
    let decision = decideModelExecution(
      snapshot,
      { provider: effectiveProvider, model: context.model },
      Date.now(),
      (approval) => readSubagentModelSpend(approvalSpendKey(approval, snapshot)),
    );
    if (!decision.allowed && wasXd) {
      // 网关按模型名路由,底层 provider 由网关决定,Agent 不能选。若同模型在
      // 另一来源的 allow-list 路由下可执行,则网关执行不跨越 allow-list。
      for (const route of snapshot.allowedRoutes) {
        if (route.model.trim().toLowerCase() !== context.model.trim().toLowerCase()) continue;
        const alt = decideModelExecution(
          snapshot,
          { provider: route.provider, model: route.model },
          Date.now(),
          (approval) => readSubagentModelSpend(approvalSpendKey(approval, snapshot)),
        );
        if (alt.allowed) { decision = alt; break; }
      }
    }
    return applyExecutionPolicyToClaudeAccess({
      availability,
      policyAllowed: decision.allowed,
      ...(decision.allowed ? {} : { policyReason: decision.reason }),
      model: context.model,
      parentModel: context.parentModel,
    });
  } catch {
    return applyExecutionPolicyToClaudeAccess({
      availability,
      policyAllowed: false,
      policyReason: 'model execution policy snapshot is missing or invalid; refusing to dispatch',
      model: context.model,
      parentModel: context.parentModel,
    });
  }
}
