import { randomBytes } from 'node:crypto';
import { createCodexEnvironment } from '@cindy/app-runtime/codexEnvironment';
import { createCodexRemoteMcp } from '@cindy/app-runtime/codexRemoteMcp';
import { createCcRemoteMcp } from '@cindy/app-runtime/ccRemoteMcp';
import { createCcManagerClient } from '@cindy/app-runtime/ccManagerClient';
import { createSshClaudeHost } from '@cindy/app-runtime/sshClaudeHost';
import type { CodexHttpBridge } from '@cindy/mcps/host/codexHttpBridge';
import type { CodexAgent, CodexExtraSpawnConfig, CodexMcpThreadContextArgs, Logger, McpProvider } from '@cindy/maker-core';
import type { TerminalSecrets } from '../contracts.js';
import type { TerminalSshService } from '../ssh.js';
import type { TerminalOrcaStore } from './orca-store.js';

/** The same persistent bridge, daemon configuration and query recovery as
 * Desktop. One instance belongs to one account, never to a single task. */
export class TerminalSshRuntime {
  readonly environment: ReturnType<typeof createCodexEnvironment>;
  readonly codexMcp: ReturnType<typeof createCodexRemoteMcp>;
  readonly claude: ReturnType<typeof createSshClaudeHost>;
  private token: string | null = null;
  private tokenReady?: Promise<void>;
  private closed = false;
  private lastBridge: CodexHttpBridge | null = null;
  private readonly forcedFresh = new Set<string>();
  private readonly staleCc = new Set<string>();
  private readonly codexAgents = new Set<CodexAgent>();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly options: {
    profileDir: string; ssh: TerminalSshService; secrets: TerminalSecrets; logger: Logger;
    orcaStore: Pick<TerminalOrcaStore, 'getSessionOrcaRole' | 'getWorkerLink'>;
    providers(): McpProvider[]; appServerIds(): readonly string[];
    memoryEnabled(): boolean; collabEnabled(): boolean;
    hasLiveTurn(hostId: string): boolean;
    drainPersistQueue(): Promise<void>; assertCurrent(): void;
  }) {
    const getRemoteMcpBridgeToken = () => { this.guard(); return this.token; };
    this.environment = createCodexEnvironment({ getRemoteMcpBridgeToken, appServerIds: options.appServerIds });
    this.codexMcp = createCodexRemoteMcp({ userDataDirectory: () => options.profileDir, logger: options.logger,
      getRemoteMcpBridgeToken, appServerIds: options.appServerIds });
    const ccMcp = createCcRemoteMcp({ userDataDirectory: () => options.profileDir, getRemoteMcpBridgeToken,
      appServerIds: options.appServerIds,
      getSessionOrcaRole: id => options.orcaStore.getSessionOrcaRole(id),
      getWorkerLink: input => options.orcaStore.getWorkerLink(input) });
    const ccManager = createCcManagerClient({ logger: options.logger, drainPersistQueue: options.drainPersistQueue });
    this.claude = createSshClaudeHost({ ...ccMcp, ...ccManager, ...options.ssh.managers,
      getRemoteSshPool: () => options.ssh.pool, desktopMakerLogger: options.logger,
      getRemoteAgentProxyEnv: options.ssh.agentProxy.getRemoteAgentProxyEnv,
      ensureCodexMcpBridgeStartedForRemote: () => this.ensureBridge(),
      ensureRemoteMcpForward: this.codexMcp.ensureRemoteMcpForward,
      pluginRegistry: { isEnabled: () => options.collabEnabled() },
      forcedFreshCcBridgeSessions: this.forcedFresh, staleInvalidatedCcSessions: this.staleCc });
    this.codexMcp.setRemoteMcpForwardRearmedHook(hostId => {
      if (this.closed) return;
      const work = this.prepare('codex', hostId).catch(() => {
        options.logger.warn('SSH MCP forwarding will retry before the next turn', { hostId });
      });
      this.pending.add(work); void work.finally(() => this.pending.delete(work));
    });
  }
  private guard() { if (this.closed) throw new Error('SSH_RUNTIME_CLOSED'); this.options.assertCurrent(); }
  private ensureToken() {
    this.guard();
    return this.tokenReady ??= (async () => {
      const key = 'remote-mcp-bridge-token';
      let token = await this.options.secrets.get(key); this.guard();
      if (!token) { token = randomBytes(32).toString('hex'); await this.options.secrets.set(key, token); this.guard(); }
      this.token = token;
    })().catch(error => { this.tokenReady = undefined; throw error; });
  }
  async ensureBridge() {
    await this.ensureToken(); this.guard();
    const config = await this.environment.getCodexExtraSpawnConfig({ mcpProviders: this.options.providers(), logger: this.options.logger });
    this.guard();
    if (!config.bridge) return null;
    if (this.lastBridge !== config.bridge) { this.forcedFresh.clear(); this.lastBridge = config.bridge; }
    return { port: config.bridge.port, serverNames: config.bridgeServerNames, bridgeInstanceId: config.bridge.instanceId, bridge: config.bridge };
  }
  async prepare(kind: 'claude-code' | 'codex' | 'pi', hostId: string) {
    this.guard();
    const host = await this.options.ssh.ensureAgentReady(hostId, kind); this.guard();
    if (kind === 'codex') {
      const result = await this.codexMcp.ensureRemoteCodexMcpBridge(host, {
        ensureBridgeStarted: () => this.ensureBridge(), hasLiveTurnOnHost: this.options.hasLiveTurn,
        isCollabEnabled: this.options.collabEnabled, isMakerMemoryEnabled: this.options.memoryEnabled });
      this.guard();
      if (result.daemonRebootstrapped) await Promise.all([...this.codexAgents].map(agent => agent.disposeRemoteHostAfterRestart(hostId)));
      return result;
    }
    if (kind === 'claude-code') await this.ensureBridge();
  }
  codexSpawn(hostId: string): CodexExtraSpawnConfig {
    this.guard();
    return { extraArgs: [], extraEnv: {}, codexProxyActive: false, codexBrowserUseAvailable: true,
      buildSessionMcpConfig: (instance, session) => this.codexMcp.buildRemoteCodexSessionMcpConfig(hostId, instance, {
        bridgeInstanceId: this.environment.getActiveCodexBridgeInstanceId(), serverNames: this.environment.getActiveCodexBridgeServerNames() ?? [],
        collabEnabled: this.options.collabEnabled(), makerMemoryEnabled: this.options.memoryEnabled(), vendorOptions: session?.vendorOptions }) };
  }
  trackCodex(agent: CodexAgent) {
    this.codexAgents.add(agent);
    const dispose = agent.dispose.bind(agent);
    agent.dispose = async () => { try { await dispose(); } finally { this.codexAgents.delete(agent); } };
    return agent;
  }
  registerCodexMcpThreadContext = (ctx: CodexMcpThreadContextArgs) => {
    this.guard(); this.environment.registerCodexMcpThreadContext(ctx.threadId, { ...ctx, agentKind: 'codex' });
  };
  unregisterCodexMcpThreadContext = (threadId: string, instance?: string) => this.environment.unregisterCodexMcpThreadContext(threadId, instance);
  withCodexMcpDiscoveryContext = <T>(ctx: Pick<CodexMcpThreadContextArgs, 'sessionId' | 'sessionInstanceId' | 'workingDir' | 'vendorOptions' | 'remoteHostId'>, run: () => Promise<T>) => {
    this.guard(); return this.environment.withCodexMcpDiscoveryContext({ ...ctx, agentKind: 'codex' }, run);
  };
  async close() {
    if (this.closed) return;
    this.closed = true; this.token = null;
    await Promise.allSettled([...this.pending, ...(this.tokenReady ? [this.tokenReady] : [])]);
    await this.environment.shutdownCodexEnvironment();
    this.forcedFresh.clear(); this.staleCc.clear();
  }
}
