import { createClaudeSubagentModelAccess, type ClaudeSubagentModelAccessPorts } from '../../../desktop/src/main/maker-host/subagentModelAccessCore.js';

type ProviderViews = Awaited<ReturnType<ReturnType<ClaudeSubagentModelAccessPorts['getDesktopProviderService']>['listProviders']>>;

/**
 * The desktop's Claude subagent model access (subagent-model-access.ts) for the Claude constructor:
 * the same core, the Host's gateway key and its provider views without side effects (as the
 * desktop's listProviders({ allowSideEffects: false }); codex-runtime.ts maps it the same way). Only
 * an authoritative XD snapshot can deny a model (subagent-model-access-policy.ts); provider views
 * only tell an available model from an unknown one, and both let the call through.
 */
export function createHostClaudeSubagentModelAccess(options: {
  readGatewayKey: () => string | null | undefined;
  listProviderViews: () => Promise<ProviderViews>;
}) {
  const access = createClaudeSubagentModelAccess({
    readClaudeApiKey: () => options.readGatewayKey(),
    getDesktopProviderService: () => ({ listProviders: () => options.listProviderViews() }),
  });
  return access.resolveDesktopClaudeSubagentModelAccess;
}
