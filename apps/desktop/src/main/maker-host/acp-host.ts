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
  NATIVE_SUBSCRIPTION_ACCOUNT,
  isTerminalTurnEvent,
  type AcpAgentDeps,
  type AgentDeps,
  type AgentSessionHandle,
  type AuthAdapter,
  type Capabilities,
  type Logger,
  type StartSessionOptions,
} from '@cindy/maker-core';
import { observePluginEngineModelDetails, rememberPluginHarnessModels } from './pluginEngineModelCache.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.desktop.js';
import {
  getPluginHarnessRegistry,
  recordPluginHarnessActivity,
  type PluginHarness,
} from '../cindy-brain/pluginHarnesses.js';
import { getDesktopMcpToolApprovalPolicy } from './mcp-tool-approval-policy.js';
import type { NodeWorkerProcess } from '../cindy-brain/nodeRuntimeBroker.js';
import { createAcpProcessTransport } from './acp-transport.js';
import { withPluginEngineAccounts } from '../plugin-engine-accounts/agent.js';
import { parsePluginEngineProviderId } from '../plugin-engine-accounts/ids.js';
export { createAcpProcessTransport } from './acp-transport.js';
export {
  getCachedPluginHarnessModels,
  getReportedPluginEngineModelDetails,
  onPluginHarnessModelsChanged,
  onReportedPluginEngineModelDetailsChanged,
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
  turnChangeCapture?: AgentDeps['turnChangeCapture'];
  getMcpToolApprovalPolicy?: AgentDeps['getMcpToolApprovalPolicy'];
  /** The installed-plugin roster, the same text the built-in engines get (briefing ahead of the first message). */
  getGhostRosterPrompt?: AgentDeps['getGhostRosterPrompt'];
  /** The Skills a task can use, with the built-in Pi engine's discovery and enablement. */
  listSessionSkills?: AcpAgentDeps['listSessionSkills'];
  /** Starts the declared entry of a listed harness in raw-stdio mode. */
  spawnHarness(key: string, options?: { remoteWorkspace?: boolean; guestWorkspace?: boolean; accountDir?: string }): Promise<NodeWorkerProcess>;
  /** Called on real task/turn activity for a plugin engine (used for adaptive usage refresh). */
  onActivity?(key: string, accountDir?: string): void;
}

function withPluginHarnessActivityTracking(
  agent: AcpAgent,
  onActivity: (key: string, accountDir?: string) => void,
): AcpAgent {
  const wrapHandle = (handle: AgentSessionHandle, key: string, accountDir?: string): AgentSessionHandle =>
    new Proxy(handle, {
      get(target, property) {
        if (property === 'send') {
          return async (...args: Parameters<AgentSessionHandle['send']>) => {
            onActivity(key, accountDir);
            return target.send(...args);
          };
        }
        if (property === 'steer' && target.steer) {
          return async (...args: Parameters<NonNullable<AgentSessionHandle['steer']>>) => {
            onActivity(key, accountDir);
            return target.steer!(...args);
          };
        }
        if (property === 'events') {
          return async function* () {
            for await (const event of target.events()) {
              if (isTerminalTurnEvent(event)) onActivity(key, accountDir);
              yield event;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(agent, {
    get(target, property) {
      if (property === 'startSession') {
        return async (options: StartSessionOptions) => {
          const ref = parsePluginEngineProviderId(options.providerId);
          const managed = options[NATIVE_SUBSCRIPTION_ACCOUNT];
          const accountDir = managed && !managed.defaultProfile && managed.configDir
            ? managed.configDir
            : undefined;
          const handle = await target.startSession(options);
          if (!ref) return handle;
          onActivity(ref.engineKey, accountDir);
          return wrapHandle(handle, ref.engineKey, accountDir);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function buildAcpAgent(opts: BuildAcpAgentOpts): AcpAgent {
  const logger = opts.logger.child('acp');
  const agent = new AcpAgent({
    auth: pluginEngineAuthAdapter,
    runtimeConfig: {},
    binaryPath: '',
    logger,
    ...(opts.mcpProviders ? { mcpProviders: opts.mcpProviders } : {}),
    ...(opts.makerMemory ? { makerMemory: opts.makerMemory } : {}),
    ...(opts.turnChangeCapture ? { turnChangeCapture: opts.turnChangeCapture } : {}),
    ...(opts.getMcpToolApprovalPolicy ? { getMcpToolApprovalPolicy: opts.getMcpToolApprovalPolicy } : {}),
    ...(opts.getGhostRosterPrompt ? { getGhostRosterPrompt: opts.getGhostRosterPrompt } : {}),
    ...(opts.listSessionSkills ? { listSessionSkills: opts.listSessionSkills } : {}),
    preparePiExtraSpawnConfig: (providers, ctx) => getPiExtraSpawnConfig(providers, logger, ctx),
    clientInfo: { name: 'cindy', title: 'Cindy', version: opts.appVersion },
    endpoints: {
      connect: async (key, options) => createAcpProcessTransport(
        options?.remoteWorkspace || options?.guestWorkspace || options?.accountDir
          ? await opts.spawnHarness(key, {
              ...(options.remoteWorkspace ? { remoteWorkspace: true } : {}),
              ...(options.guestWorkspace ? { guestWorkspace: true } : {}),
              ...(options.accountDir ? { accountDir: options.accountDir } : {}),
            })
          : await opts.spawnHarness(key),
        logger,
      ),
    },
    verificationForTask: (key, sessionId) => key === '_root__cindy-antigravity-acp:agy'
      ? async (probe, signal) => (await import('./antigravityVerification.desktop.js')).verifyAntigravityAccount(sessionId, probe, signal)
      : undefined,
    onSessionCapabilities: rememberCapabilities,
    observeModelDetails: observePluginEngineModelDetails,
  });
  return opts.onActivity ? withPluginHarnessActivityTracking(agent, opts.onActivity) : agent;
}

export interface InstallPluginEnginesOpts {
  maker: { registerAgent(kind: 'acp', agent: AcpAgent): boolean };
  logger: Logger;
  appVersion: string;
  mcpProviders?: AgentDeps['mcpProviders'];
  makerMemory?: AgentDeps['makerMemory'];
  turnChangeCapture?: AgentDeps['turnChangeCapture'];
  getGhostRosterPrompt?: AgentDeps['getGhostRosterPrompt'];
  listSessionSkills?: AcpAgentDeps['listSessionSkills'];
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
      ...(opts.turnChangeCapture ? { turnChangeCapture: opts.turnChangeCapture } : {}),
      ...(opts.getGhostRosterPrompt ? { getGhostRosterPrompt: opts.getGhostRosterPrompt } : {}),
      ...(opts.listSessionSkills ? { listSessionSkills: opts.listSessionSkills } : {}),
      getMcpToolApprovalPolicy: getDesktopMcpToolApprovalPolicy,
      spawnHarness: (key, options) => (options ? registry.spawn(key, options) : registry.spawn(key)),
      onActivity: (key, accountDir) => recordPluginHarnessActivity(key, accountDir),
    });
    // Engines whose plugin keeps accounts apart run on accounts like built-in providers
    // (subscription-account-pools.md 插件引擎的账号); all others start exactly as before.
    registered = opts.maker.registerAgent('acp', withPluginEngineAccounts(agent));
    if (registered) opts.logger.info('plugin engine registered', { harnesses: list.length });
  };
  sync(registry.list());
  return registry.onChange(sync);
}
