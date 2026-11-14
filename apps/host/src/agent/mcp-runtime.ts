import type { AgentDeps } from '@cindy/maker-core';
import { createCodexHttpBridgeRuntime } from '../../../desktop/src/main/mcp-integrations/codexHttpBridge.js';
import { createCodexEnvironment } from '../../../desktop/src/main/mcp-integrations/codexEnvironment.js';
import { createPiEnvironment } from '../../../desktop/src/main/mcp-integrations/piEnvironment.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY, readDisabledBuiltinPluginIds } from '../../../desktop/src/main/mcp-integrations/codexBuiltinToolPolicy.js';
import { createPluginRegistry } from '../../../desktop/src/main/maker-host/plugins/index.js';
import { createMakerLogger } from '../../../desktop/src/main/maker-host/logger-adapter.js';

/** Real HTTP MCP transport and thread identity for native CLI processes. */
export function createHostMcpRuntime(ports: { appServerIds(): string[]; getRemoteMcpBridgeToken(): string | null }) {
  const http = createCodexHttpBridgeRuntime(ports);
  const codex = createCodexEnvironment({ ...http, ...ports });
  const pi = createPiEnvironment(http);
  const logger = createMakerLogger('maker/mcp');
  const codexDeps: Pick<AgentDeps, 'prepareCodexExtraSpawnConfig' | 'registerCodexMcpThreadContext' |
    'unregisterCodexMcpThreadContext' | 'prepareCodexMcpToolCancellation' | 'withCodexMcpDiscoveryContext'> = {
    prepareCodexExtraSpawnConfig: providers => codex.getCodexExtraSpawnConfig({ mcpProviders: providers, logger }),
    registerCodexMcpThreadContext: ({ threadId, ...context }) => {
      const disabled = readDisabledBuiltinPluginIds(context.vendorOptions)
        ?? createPluginRegistry().getDisabledRuntimePluginIds(context.workingDir);
      codex.registerCodexMcpThreadContext(threadId, { ...context, agentKind: 'codex',
        vendorOptions: { ...context.vendorOptions, [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: disabled } });
    },
    unregisterCodexMcpThreadContext: codex.unregisterCodexMcpThreadContext,
    prepareCodexMcpToolCancellation: codex.prepareCodexMcpToolCancellation,
    withCodexMcpDiscoveryContext: (context, run) => codex.withCodexMcpDiscoveryContext({ ...context, agentKind: 'codex' }, run),
  };
  // PiAgent calls (providers, ctx); the shared environment also takes the logger.
  const piDeps: Pick<AgentDeps, 'preparePiExtraSpawnConfig'> = {
    preparePiExtraSpawnConfig: (providers, ctx) => pi.getPiExtraSpawnConfig(providers, logger, ctx),
  };
  return {
    codexDeps,
    piDeps,
    prepareCodexMcp: codex.getCodexExtraSpawnConfig,
    /** Server names of the applied Codex MCP bridge (desktop capability routing reads the same). */
    getActiveCodexBridgeServerNames: codex.getActiveCodexBridgeServerNames,
    /** Auth boundaries drop the Pi bridge built with the previous credentials (desktop: maker-host/index.ts). */
    invalidatePiEnvironment: pi.invalidatePiEnvironment,
    async close() {
      const settled = await Promise.allSettled([codex.shutdownCodexEnvironment(), pi.shutdownPiEnvironment()]);
      const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'MCP bridges did not stop cleanly');
    },
  };
}
