/**
 * Claude subagent model access, shared by Desktop and the Node Host. Moved verbatim from
 * subagent-model-access.ts, which now builds the Desktop instance. The gateway key reader and the
 * provider service (both Electron-side on the Desktop) arrive as ports; every other import is
 * unchanged.
 */

import type {
  AgentCredentialMode,
  ClaudeSubagentModelAccessResult,
} from '@cindy/maker-core';

import {
  getActiveCatalog,
  getXdGatewayModelAccessSnapshot,
} from './active-catalog.js';
import { classifyClaudeSubagentModelAccess } from './subagent-model-access-policy.js';

/** The Desktop-only reads, resolved by each launcher. */
export interface ClaudeSubagentModelAccessPorts {
  readClaudeApiKey: () => string | null | undefined;
  getDesktopProviderService: () => { listProviders(options: { allowSideEffects: false; catalog: ReturnType<typeof getActiveCatalog> }): Promise<Parameters<typeof classifyClaudeSubagentModelAccess>[0]['providers']> };
}

/** One instance per launcher; the former module state lives in it. */
export function createClaudeSubagentModelAccess(ports: ClaudeSubagentModelAccessPorts) {
const { readClaudeApiKey, getDesktopProviderService } = ports;


/**
 * ClaudeCodeAgent 的 host 注入入口。每次 PreToolUse 都现场读取 key、权威 XD
 * 快照和 ProviderView，因此账号切换不会复用会话启动时冻结的权限结论。
 */
async function resolveDesktopClaudeSubagentModelAccess(context: {
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

return { resolveDesktopClaudeSubagentModelAccess };
}
