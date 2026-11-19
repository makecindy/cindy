/**
 * The `'acp'` engine: runs Cindy tasks on ACP agents provided by plugins.
 *
 * One AcpAgent serves every plugin harness. A task names its harness through
 * `StartSessionOptions.providerId = 'acp-plugin:<ghostId>:<harnessId>'`; the
 * host resolves that id to a freshly started endpoint process. The agent owns
 * its own model, login and tools; Cindy adds its MCP tools through the same
 * bridge Pi uses (same tool scope as Pi, see docs/plans/acp-plugin-bridge.md).
 */

import { NotSupportedError, type Capabilities } from '../../types/capabilities.js';
import {
  AgentStartupCleanupPendingError,
  AgentStartupStoppedError,
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
  type PiExtraSpawnConfig,
  type StartSessionOptions,
} from '../base-agent.js';
import { buildAcpCapabilities } from './capabilities.js';
import type { AcpLineTransport } from './line-transport.js';
import type { AcpMcpServer } from './protocol.js';
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

/** Host side: starts the endpoint process for one task and adapts it to a line transport. */
export interface AcpEndpointLauncher {
  /** Known failures carry startup exit proof or the failed process's cleanup receipt. */
  connect(harnessKey: string): Promise<AcpLineTransport>;
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
    // Maker already refuses plugin engines on another computer; SSH and hosted guests are refused here.
    if (opts.remoteHostId || opts.deviceHosted) {
      throw new AgentStartupStoppedError(new NotSupportedError('remoteSession', {
        supported: false,
        reason: 'not-implemented',
        message: 'Plugin engines run on this computer only',
      }));
    }
    if (opts.reviewMode) {
      throw new AgentStartupStoppedError(new NotSupportedError('reviewMode', { supported: false, reason: 'not-implemented' }));
    }
    const harnessKey = acpHarnessKeyFromProviderId(opts.providerId);
    if (!harnessKey) {
      throw new AgentStartupStoppedError(new Error('A plugin engine task needs its harness id (acp-plugin:<plugin>:<harness>)'));
    }

    const logger = this.deps.logger.child(`acp:${harnessKey}`);
    let extra: PiExtraSpawnConfig | null = null;
    if (this.deps.preparePiExtraSpawnConfig) {
      try {
        extra = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
          // Same Cindy tool scope as the built-in Pi engine (product decision 2026-11-18).
          agentKind: 'pi',
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
          workingDir: opts.workingDir,
          ...(opts.makerMemoryScopeKey ? { memoryScopeKey: opts.makerMemoryScopeKey } : {}),
          memoryEnabled: opts.makerMemoryEnabled === true,
          ...(opts.vendorOptions ? { vendorOptions: opts.vendorOptions } : {}),
          // The external agent's own sub-agents may call tools; Cindy cannot attest who called.
          mcpCallerKind: 'unknown',
          mcpCallerAttested: false,
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

    const open = async (): Promise<AcpSession> => {
      const tracked = trackClose(await this.acpDeps.endpoints.connect(harnessKey));
      try {
        return await openAcpSession({
          transport: tracked.transport,
          cwd: opts.workingDir,
          clientInfo: this.acpDeps.clientInfo,
          mcpServers: acpMcpServersFromBridge(extra),
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
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
