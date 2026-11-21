/**
 * The `'acp'` engine: runs Cindy tasks on ACP agents provided by plugins.
 *
 * One AcpAgent serves every plugin harness. A task names its harness through
 * `StartSessionOptions.providerId = 'acp-plugin:<ghostId>:<harnessId>'`; the
 * host resolves that id to a freshly started endpoint process. The agent owns
 * its own model, login and tools; Cindy adds its MCP tools through the same
 * bridge Pi uses (same tool scope as Pi, see docs/plans/acp-plugin-bridge.md).
 *
 * A task whose files and commands are on another computer of the same account
 * (`StartSessionOptions.deviceHosted`) starts the endpoint in remote-workspace
 * mode: the plugin switches the agent's own file and command tools off for that
 * process, and every tool reaches the task's computer through the task tunnel.
 */

import { NotSupportedError, type Capabilities } from '../../types/capabilities.js';
import {
  AgentStartupCleanupPendingError,
  AgentStartupStoppedError,
  BaseAgent,
  isolatedBotProfile,
  type AgentDeps,
  type AgentSessionHandle,
  type PiExtraSpawnConfig,
  type StartSessionOptions,
} from '../base-agent.js';
import { buildAcpCapabilities } from './capabilities.js';
import type { AcpLineTransport } from './line-transport.js';
import type { AcpMcpServer } from './protocol.js';
import {
  DEVICE_HOSTED_EXEC_MCP_SERVER,
  deviceHostedMcpUrl,
  deviceHostedPluginEngineMcpServers,
  deviceHostedPluginEngineNote,
} from '../shared/device-hosted.js';
import { openAcpSession, type AcpClientInfo, type AcpSession } from './session.js';

export const ACP_PLUGIN_PROVIDER_PREFIX = 'acp-plugin:';

/** Never executed: AcpAgent only talks to transports the host opens for plugin entries. */
const ACP_PLUGIN_BINARY_PLACEHOLDER = 'plugin-provided';

/** `acp-plugin:<ghostId>:<harnessId>` → registry key `<ghostId>:<harnessId>`. */
export function acpHarnessKeyFromProviderId(providerId: string | null | undefined): string | null {
  if (!providerId || !providerId.startsWith(ACP_PLUGIN_PROVIDER_PREFIX)) return null;
  const key = providerId.slice(ACP_PLUGIN_PROVIDER_PREFIX.length);
  const separator = key.lastIndexOf(':');
  return separator > 0 && separator < key.length - 1 ? key : null;
}

export function acpProviderIdForHarness(key: string): string {
  return `${ACP_PLUGIN_PROVIDER_PREFIX}${key}`;
}

export interface AcpEndpointConnectOptions {
  /**
   * The task's files and commands are on another computer. The host starts the entry in the
   * mode where the agent's own file and command tools are off, and refuses an engine whose
   * plugin does not offer that mode.
   */
  remoteWorkspace?: boolean;
}

/** Host side: starts the endpoint process for one task and adapts it to a line transport. */
export interface AcpEndpointLauncher {
  /** Known failures carry startup exit proof or the failed process's cleanup receipt. */
  connect(harnessKey: string, options?: AcpEndpointConnectOptions): Promise<AcpLineTransport>;
}

export interface AcpAgentDeps extends AgentDeps {
  endpoints: AcpEndpointLauncher;
  clientInfo: AcpClientInfo;
  /** Remembers what the agent offered so pickers can show it before the next start. */
  onSessionCapabilities?: (harnessKey: string, capabilities: Capabilities) => void;
}

const NO_INIT = buildAcpCapabilities(
  {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { resume: false, close: false, list: false },
    },
    authMethods: [],
  },
  [],
);

/** Records whether the host confirmed the endpoint exited, for Maker's startup-cleanup contract. */
function trackClose(transport: AcpLineTransport): {
  transport: AcpLineTransport;
  stopped: () => boolean;
  whenStopped: Promise<void>;
} {
  let stopped = false;
  let resolveStopped!: () => void;
  const whenStopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const markStopped = () => {
    stopped = true;
    resolveStopped();
  };
  // Stays subscribed after the connection detaches, so a late exit still resolves it.
  const detach = transport.onClose((info) => {
    if (info.reason !== 'protocol-error') markStopped();
  });
  void whenStopped.then(detach);
  return {
    stopped: () => stopped,
    whenStopped,
    transport: {
      write: (line) => transport.write(line),
      onLine: (listener) => transport.onLine(listener),
      onClose: (listener) => transport.onClose(listener),
      close: async () => {
        if (stopped) return;
        try {
          await transport.close();
        } catch (error) {
          if (!stopped) throw error;
        }
        markStopped();
      },
    },
  };
}

/** A task hosted for another computer: every MCP server is that computer's, reached through the task tunnel. */
export function acpMcpServersForHostedTask(hosted: NonNullable<StartSessionOptions['deviceHosted']>): AcpMcpServer[] {
  return deviceHostedPluginEngineMcpServers(hosted).map((name) => ({
    type: 'http',
    name,
    url: deviceHostedMcpUrl(hosted, name),
    headers: [{ name: 'Authorization', value: `Bearer ${hosted.tunnelToken}` }],
  }));
}

/** Shares the task-scoped Cindy bridge through ACP. External MCP credentials stay in the host. */
export function acpMcpServersFromBridge(extra: PiExtraSpawnConfig | null): AcpMcpServer[] {
  const bridge = extra?.mcpBridge;
  if (!bridge) return [];
  return bridge.servers.filter((server) => !server.remote).map((server) => ({
    type: 'http',
    name: server.name,
    url: server.url,
    headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }],
  }));
}

export class AcpAgent extends BaseAgent {
  readonly kind = 'acp' as const;
  /** Per-session capabilities come from the handshake (`AgentSessionHandle.negotiatedCapabilities`). */
  readonly capabilities: Capabilities = NO_INIT;
  private readonly acpDeps: AcpAgentDeps;

  constructor(deps: AcpAgentDeps) {
    // Plugin engines have no Cindy-managed binary: each task starts the plugin's own
    // declared entry. BaseAgent requires a value, so name the source instead.
    super({ ...deps, binaryPath: deps.binaryPath || ACP_PLUGIN_BINARY_PLACEHOLDER });
    this.acpDeps = deps;
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    // SSH workspaces are not offered. A task of another account must not run here either: the
    // agent runs as this computer's user with its own login and history, and Cindy can neither
    // isolate it per guest nor prove that its own tools are off.
    if (opts.remoteHostId || opts.deviceHosted?.guest) {
      throw new AgentStartupStoppedError(new NotSupportedError('remoteSession', {
        supported: false,
        reason: 'not-implemented',
        message: opts.remoteHostId
          ? 'Plugin engines do not run in SSH workspaces'
          : 'Plugin engines are not available to shared users',
      }));
    }
    const hosted = opts.deviceHosted;
    if (opts.reviewMode) {
      throw new AgentStartupStoppedError(new NotSupportedError('reviewMode', { supported: false, reason: 'not-implemented' }));
    }
    const harnessKey = acpHarnessKeyFromProviderId(opts.providerId);
    if (!harnessKey) {
      throw new AgentStartupStoppedError(new Error('A plugin engine task needs its harness id (acp-plugin:<plugin>:<harness>)'));
    }

    const logger = this.deps.logger.child(`acp:${harnessKey}`);
    const botMcpPolicy = isolatedBotProfile(opts.botRuntimeProfile)?.mcpPolicy;
    let extra: PiExtraSpawnConfig | null = null;
    // Hosted for another computer: Cindy tools are that computer's and arrive through the tunnel,
    // so this computer's own tool bridge (and its installed plugins, memory, sessions) stays out.
    if (!hosted && this.deps.preparePiExtraSpawnConfig) {
      try {
        extra = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
          // Same Cindy tool scope as the built-in Pi engine (product decision 2026-11-18).
          agentKind: 'pi',
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
          workingDir: opts.workingDir,
          ...(opts.makerMemoryScopeKey ? { memoryScopeKey: opts.makerMemoryScopeKey } : {}),
          memoryEnabled: opts.makerMemoryEnabled === true,
          ...(botMcpPolicy ? { botMcpPolicy } : {}),
          ...(opts.vendorOptions ? { vendorOptions: opts.vendorOptions } : {}),
          // The external agent's own sub-agents may call tools; Cindy cannot attest who called. A host
          // that trusts the engine as a whole (collaboration Workers) treats every call as the task's own.
          mcpCallerKind: opts.pluginEngineTrustedCaller === true ? 'root' : 'unknown',
          mcpCallerAttested: opts.pluginEngineTrustedCaller === true,
        });
      } catch (error) {
        logger.error('acp: Cindy tool bridge unavailable; starting without Cindy tools', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const disposeBridge = (): void => {
      try {
        extra?.disposeSessionCtx?.();
      } catch (error) {
        logger.warn('acp: tool bridge dispose failed', { message: String(error) });
      }
    };

    // Only a host-provided companion profile supplies the identity for this chat.
    const companionBriefing = opts.botRuntimeProfile ? [
      opts.botProfilePrompt ?? '',
      opts.botProfileContextPrompt ?? '',
      opts.makerMemoryEnabled && opts.makerMemoryIndexSnapshot?.trim()
        ? opts.makerMemoryIndexSnapshot
        : '',
      opts.botUserProfilePrompt ?? '',
    ].filter((part) => part.trim()).join('\n\n') : '';
    // The workspace note comes first: without it the agent has no way to know where the project is.
    const briefing = [
      hosted ? deviceHostedPluginEngineNote(hosted, opts.workingDir) : '',
      companionBriefing,
      opts.pluginEngineBriefing ?? '',
    ].filter((part) => part.trim()).join('\n\n');
    const open = async (): Promise<AcpSession> => {
      const tracked = trackClose(hosted
        ? await this.acpDeps.endpoints.connect(harnessKey, { remoteWorkspace: true })
        : await this.acpDeps.endpoints.connect(harnessKey));
      try {
        return await openAcpSession({
          transport: tracked.transport,
          cwd: opts.workingDir,
          clientInfo: this.acpDeps.clientInfo,
          mcpServers: hosted ? acpMcpServersForHostedTask(hosted) : acpMcpServersFromBridge(extra),
          // Without the replacement file and command tools the agent could do nothing on the project.
          ...(hosted ? { requiredMcpServers: [DEVICE_HOSTED_EXEC_MCP_SERVER] } : {}),
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
          ...(briefing ? { briefing } : {}),
          logger,
          onEnded: disposeBridge,
        });
      } catch (error) {
        if (tracked.stopped()) throw new AgentStartupStoppedError(error);
        // The next send must obtain exit proof before it can start another endpoint.
        throw new AgentStartupCleanupPendingError(error instanceof Error ? error.message : String(error), {
          cause: error,
          whenStopped: tracked.whenStopped,
          retryCleanup: () => tracked.transport.close(),
        });
      }
    };

    try {
      const session = await open();
      this.acpDeps.onSessionCapabilities?.(harnessKey, session.capabilities);
      session.onCapabilitiesChange((capabilities) => this.acpDeps.onSessionCapabilities?.(harnessKey, capabilities));
      return session;
    } catch (error) {
      disposeBridge();
      throw error;
    }
  }
}
