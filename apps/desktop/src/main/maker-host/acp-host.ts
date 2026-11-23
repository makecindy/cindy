/**
 * Desktop wiring for plugin-provided ACP engines (docs/plans/acp-plugin-bridge.md).
 *
 * - The `'acp'` engine is registered with Maker only once a plugin actually
 *   provides a harness, so Cindy without such plugins runs exactly as before.
 * - Each task starts its own endpoint process: the plugin's declared Node entry,
 *   launched by the plugin runtime in raw-stdio mode. Cindy never runs a
 *   command written by the plugin.
 * - Cindy tools reach the agent through the same MCP bridge as the built-in Pi.
 */

import {
  AcpAgent,
  type AgentDeps,
  type AuthAdapter,
  type Capabilities,
  type Logger,
} from '@cindy/maker-core';
import { rememberPluginHarnessModels } from './pluginEngineModelCache.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.desktop.js';
import { getPluginHarnessRegistry, type PluginHarness } from '../cindy-brain/pluginHarnesses.js';
import { getDesktopMcpToolApprovalPolicy } from './mcp-tool-approval-policy.js';
import type { NodeWorkerProcess } from '../cindy-brain/nodeRuntimeBroker.js';
import { createAcpProcessTransport } from './acp-transport.js';
export { createAcpProcessTransport } from './acp-transport.js';
export {
  getCachedPluginHarnessModels,
  onPluginHarnessModelsChanged,
  type CachedPluginEngineModel,
} from './pluginEngineModelCache.js';

/** Plugin engines manage their own sign-in; Cindy holds no credentials for them. */
const pluginEngineAuthAdapter: AuthAdapter = {
  getState: async () => ({ authenticated: true }),
  triggerLogin: async () => ({ authenticated: true }),
  logout: async () => {},
  getAuthEnv: async () => ({}),
};

function rememberCapabilities(key: string, capabilities: Capabilities): void {
  rememberPluginHarnessModels(key, capabilities.availableModels);
}

export interface BuildAcpAgentOpts {
  logger: Logger;
  appVersion: string;
  mcpProviders?: AgentDeps['mcpProviders'];
  makerMemory?: AgentDeps['makerMemory'];
  getMcpToolApprovalPolicy?: AgentDeps['getMcpToolApprovalPolicy'];
  /** Starts the declared entry of a listed harness in raw-stdio mode. */
  spawnHarness(key: string, options?: { remoteWorkspace?: boolean; guestWorkspace?: boolean }): Promise<NodeWorkerProcess>;
}

export function buildAcpAgent(opts: BuildAcpAgentOpts): AcpAgent {
  const logger = opts.logger.child('acp');
  return new AcpAgent({
    auth: pluginEngineAuthAdapter,
    runtimeConfig: {},
    binaryPath: '',
    logger,
    ...(opts.mcpProviders ? { mcpProviders: opts.mcpProviders } : {}),
    ...(opts.makerMemory ? { makerMemory: opts.makerMemory } : {}),
    ...(opts.getMcpToolApprovalPolicy ? { getMcpToolApprovalPolicy: opts.getMcpToolApprovalPolicy } : {}),
    preparePiExtraSpawnConfig: (providers, ctx) => getPiExtraSpawnConfig(providers, logger, ctx),
    clientInfo: { name: 'cindy', title: 'Cindy', version: opts.appVersion },
    endpoints: {
      connect: async (key, options) => createAcpProcessTransport(
        options?.remoteWorkspace || options?.guestWorkspace
          ? await opts.spawnHarness(key, {
              ...(options.remoteWorkspace ? { remoteWorkspace: true } : {}),
              ...(options.guestWorkspace ? { guestWorkspace: true } : {}),
            })
          : await opts.spawnHarness(key),
        logger,
      ),
    },
    onSessionCapabilities: rememberCapabilities,
  });
}

export interface InstallPluginEnginesOpts {
  maker: { registerAgent(kind: 'acp', agent: AcpAgent): boolean };
  logger: Logger;
  appVersion: string;
  mcpProviders?: AgentDeps['mcpProviders'];
  makerMemory?: AgentDeps['makerMemory'];
}

/**
 * Registers the 'acp' engine the first time any enabled, approved plugin
 * provides a harness. Without such plugins nothing is registered and Maker
 * runs exactly as before. Returns a disposer for the registry subscription.
 */
export function installPluginEngines(opts: InstallPluginEnginesOpts): () => void {
  const registry = getPluginHarnessRegistry();
  let registered = false;
  const sync = (list: readonly PluginHarness[]): void => {
    if (registered || list.length === 0) return;
    const agent = buildAcpAgent({
      logger: opts.logger,
      appVersion: opts.appVersion,
      ...(opts.mcpProviders ? { mcpProviders: opts.mcpProviders } : {}),
      ...(opts.makerMemory ? { makerMemory: opts.makerMemory } : {}),
      getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
      spawnHarness: (key, options) => (options ? registry.spawn(key, options) : registry.spawn(key)),
    });
    registered = opts.maker.registerAgent('acp', agent);
    if (registered) opts.logger.info('plugin engine registered', { harnesses: list.length });
  };
  sync(registry.list());
  return registry.onChange(sync);
}
