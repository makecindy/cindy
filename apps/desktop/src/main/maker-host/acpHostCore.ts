/**
 * Platform-neutral ACP plugin engine wiring shared by Desktop and Node Host
 * (docs/plans/acp-plugin-bridge.md).
 *
 * - The `'acp'` engine is registered with Maker only once a plugin actually
 *   provides a harness, so Cindy without such plugins runs exactly as before.
 * - Each task starts its own endpoint process: the plugin's declared Node entry,
 *   launched by the plugin runtime in raw-stdio mode. Cindy never runs a
 *   command written by the plugin.
 * - Cindy tools reach the agent through the caller's Pi MCP bridge port.
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
import { observePluginEngineContextWindow, observePluginEngineModelDetails, rememberPluginHarnessModels } from './pluginEngineModelCache.js';
import {
  getPluginHarnessRegistry,
  recordPluginHarnessActivity,
  trackPluginEngineSession,
  type PluginHarness,
} from '../cindy-brain/pluginHarnesses.js';
import { getDesktopMcpToolApprovalPolicy } from './mcp-tool-approval-policy.js';
import type { NodeWorkerProcess } from '../cindy-brain/nodeRuntimeBroker.js';
import { createAcpProcessTransport } from './acp-transport.js';
import { withPluginEngineAccounts } from '../plugin-engine-accounts/agent.js';
import { parsePluginEngineProviderId } from '../plugin-engine-accounts/ids.js';

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

export interface BuildAcpAgentCoreOpts {
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
  /** Prepares runtime MCP bridge and extra spawn env for the ACP session (Desktop or Node Host). */
  preparePiExtraSpawnConfig: NonNullable<AgentDeps['preparePiExtraSpawnConfig']>;
  /** Starts the declared entry of a listed harness in raw-stdio mode. */
  spawnHarness(key: string, options?: { remoteWorkspace?: boolean; guestWorkspace?: boolean; accountDir?: string }): Promise<NodeWorkerProcess>;
  /** Optional in-task account verification recovery hook (Desktop only). */
  verificationForTask?: AcpAgentDeps['verificationForTask'];
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

export function buildAcpAgentCore(opts: BuildAcpAgentCoreOpts): AcpAgent {
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
    preparePiExtraSpawnConfig: opts.preparePiExtraSpawnConfig,
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
    ...(opts.verificationForTask ? { verificationForTask: opts.verificationForTask } : {}),
    onSessionCapabilities: rememberCapabilities,
    observeModelDetails: observePluginEngineModelDetails,
    observeContextWindow: observePluginEngineContextWindow,
  });
  const tracked = withPluginEngineTurnTracking(agent);
  return opts.onActivity ? withPluginHarnessActivityTracking(tracked, opts.onActivity) : tracked;
}

/**
 * 把每个引擎任务会话登记到插件实例名下,直到它关闭。后台自动更新据此在有回合运行时延后,
 * 不再停掉插件进程打断正在跑的任务。
 */
function withPluginEngineTurnTracking(agent: AcpAgent): AcpAgent {
  return new Proxy(agent, {
    get(target, property) {
      if (property === 'startSession') {
        return async (options: StartSessionOptions) => {
          const ref = parsePluginEngineProviderId(options.providerId);
          if (!ref) return target.startSession(options);
          let handle: AgentSessionHandle | null = null;
          let opening = true;
          let preparingSends = 0;
          const untrack = trackPluginEngineSession(ref.ghostId, {
            isTurnRunning: () => opening || preparingSends > 0 || handle?.isTurnRunning?.() === true,
          });
          try {
            handle = await target.startSession(options);
          } catch (error) {
            untrack();
            throw error;
          } finally {
            opening = false;
          }
          const sessionHandle = handle;
          return new Proxy(handle, {
            get(session, sessionProperty) {
              if (sessionProperty === 'send') {
                return async (...args: Parameters<AgentSessionHandle['send']>) => {
                  preparingSends++;
                  try {
                    return await sessionHandle.send(...args);
                  } finally {
                    preparingSends--;
                  }
                };
              }
              if (sessionProperty === 'close') {
                return async () => {
                  try {
                    return await session.close();
                  } finally {
                    untrack();
                  }
                };
              }
              const value = Reflect.get(session, sessionProperty, session);
              return typeof value === 'function' ? value.bind(session) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export interface InstallPluginEnginesCoreOpts {
  maker: { registerAgent(kind: 'acp', agent: AcpAgent): boolean };
  logger: Logger;
  appVersion: string;
  mcpProviders?: AgentDeps['mcpProviders'];
  makerMemory?: AgentDeps['makerMemory'];
  turnChangeCapture?: AgentDeps['turnChangeCapture'];
  getGhostRosterPrompt?: AgentDeps['getGhostRosterPrompt'];
  listSessionSkills?: AcpAgentDeps['listSessionSkills'];
  getMcpToolApprovalPolicy?: AgentDeps['getMcpToolApprovalPolicy'];
  preparePiExtraSpawnConfig: NonNullable<AgentDeps['preparePiExtraSpawnConfig']>;
  verificationForTask?: AcpAgentDeps['verificationForTask'];
  wrapAgent?: (agent: AcpAgent) => AcpAgent;
  onActivity?: (key: string, accountDir?: string) => void;
}

/**
 * Registers the 'acp' engine the first time any enabled, approved plugin
 * provides a harness. Without such plugins nothing is registered and Maker
 * runs exactly as before. Returns a disposer for the registry subscription.
 */
export function installPluginEnginesCore(opts: InstallPluginEnginesCoreOpts): () => void {
  const registry = getPluginHarnessRegistry();
  let registered = false;
  const sync = (list: readonly PluginHarness[]): void => {
    if (registered || list.length === 0) return;
    const agent = buildAcpAgentCore({
      logger: opts.logger,
      appVersion: opts.appVersion,
      ...(opts.mcpProviders ? { mcpProviders: opts.mcpProviders } : {}),
      ...(opts.makerMemory ? { makerMemory: opts.makerMemory } : {}),
      ...(opts.turnChangeCapture ? { turnChangeCapture: opts.turnChangeCapture } : {}),
      ...(opts.getGhostRosterPrompt ? { getGhostRosterPrompt: opts.getGhostRosterPrompt } : {}),
      ...(opts.listSessionSkills ? { listSessionSkills: opts.listSessionSkills } : {}),
      getMcpToolApprovalPolicy: opts.getMcpToolApprovalPolicy ?? getDesktopMcpToolApprovalPolicy,
      preparePiExtraSpawnConfig: opts.preparePiExtraSpawnConfig,
      ...(opts.verificationForTask ? { verificationForTask: opts.verificationForTask } : {}),
      spawnHarness: (key, options) => (options ? registry.spawn(key, options) : registry.spawn(key)),
      onActivity: opts.onActivity ?? ((key, accountDir) => recordPluginHarnessActivity(key, accountDir)),
    });
    // Engines whose plugin keeps accounts apart run on accounts like built-in providers
    // (subscription-account-pools.md 插件引擎的账号); all others start exactly as before.
    const wrapped = opts.wrapAgent ? opts.wrapAgent(agent) : withPluginEngineAccounts(agent);
    registered = opts.maker.registerAgent('acp', wrapped);
    if (registered) opts.logger.info('plugin engine registered', { harnesses: list.length });
  };
  sync(registry.list());
  return registry.onChange(sync);
}
