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
import { classifyClaudeSubagentModelAccess } from './subagent-model-access-policy.js';

/**
 * ClaudeCodeAgent 的 host 注入入口。每次 PreToolUse 都现场读取 key、权威 XD
 * 快照和 ProviderView，因此账号切换不会复用会话启动时冻结的权限结论。
 */
export async function resolveDesktopClaudeSubagentModelAccess(context: {
  providerId?: string | null;
  parentModel: string;
  credentialMode?: AgentCredentialMode;
  model: string;
}): Promise<ClaudeSubagentModelAccessResult> {
  try {
    const providers = await getDesktopProviderService().listProviders({
      allowSideEffects: false,
      catalog: getActiveCatalog(),
    });
    return classifyClaudeSubagentModelAccess({
      providerId: context.providerId,
      credentialMode: context.credentialMode,
      model: context.model,
      gatewayKeyAvailable: Boolean(readClaudeApiKey()),
      xdSnapshot: getXdGatewayModelAccessSnapshot(),
      providers,
    });
  } catch {
    return { status: 'unknown' };
  }
}
