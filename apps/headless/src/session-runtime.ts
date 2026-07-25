import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeCodeAgent,
  CodexAgent,
  Maker,
  type AgentEvent,
  type AuthAdapter,
  type AuthAdapterOptions,
  type AuthState,
  type InteractionDecision,
  type InteractionRequest,
  type Logger,
  type McpProvider,
  type MakerMemoryManager,
  type SendOrigin,
  type UserMessage,
} from '@cindy/maker-core';
import type {
  HeadlessSessionEventStorage,
  HeadlessSessionEvent,
  HeadlessSessionMeta,
  HeadlessSessionStorageContract,
} from './session-types.js';
import { HeadlessTurnScheduler } from './turn-scheduler.js';
import { HeadlessTurnCompletionTracker } from './turn-completion.js';
import type { HeadlessProviderRouter } from './provider-router.js';
import { buildCodexProxySpawnArgs, codexProxyAuthEnv } from './codex-proxy.js';
import type { HeadlessMcpService } from './mcp-service.js';

export interface HeadlessSessionRuntime {
  send(session: HeadlessSessionMeta, content: string | UserMessage, origin?: SendOrigin): Promise<void>;
  /** Sends an internal autonomous-goal directive without exposing it as a normal chat message. */
  sendGoal?(session: HeadlessSessionMeta, directive: string, visibleContent?: string): Promise<void>;
  steer(session: HeadlessSessionMeta, content: string | UserMessage): Promise<void>;
  abort(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  resolveInteraction(sessionId: string, requestId: string, decision: InteractionDecision): Promise<boolean>;
  /** A configuration change may only replace an idle maker-core session. */
  reconfigure(sessionId: string): Promise<void>;
  setOrcaRole(sessionId: string, role: 'lead' | 'worker' | null): Promise<void>;
  setExtraDirs?(sessionId: string, dirs: string[]): Promise<void>;
  /** Palette discovery is host-local but safe to expose through Device Link. */
  listAgentCommands?(agentKind: HeadlessSessionMeta['agentKind']): unknown;
  listAgentSkills?(agentKind: HeadlessSessionMeta['agentKind'], options: { workingDir: string; forceReload?: boolean }): Promise<unknown>;
  scanAtResources?(agentKind: HeadlessSessionMeta['agentKind'], options: { workingDir: string; cap?: number; query?: string }): Promise<unknown>;
  /** Native history primitives used by the host's Mac-compatible history domain layer. */
  forkNativeSession?(agentKind: HeadlessSessionMeta['agentKind'], options: {
    sourceSdkSessionId: string; upToMessageId?: string; tailTurnsToDrop?: number; title?: string; workingDir?: string;
  }): Promise<{ newSdkSessionId: string; uuidMap: Map<string, string> }>;
  previewNativeRewind?(session: HeadlessSessionMeta, userUuid: string): Promise<{
    canRewind: boolean; filesChanged: string[]; insertions: number; deletions: number; error?: string;
  }>;
  commitNativeRewind?(session: HeadlessSessionMeta, userUuid: string, priorAssistantUuid: string, options?: { tailTurnsToDrop?: number }): Promise<{ sdkSessionId?: string }>;
  /** Lifecycle taps used by host services such as autonomous Goal execution. */
  subscribeAgentEvents?(listener: (sessionId: string, event: AgentEvent) => void): () => void;
  subscribeTurnStarts?(listener: (sessionId: string, origin: SendOrigin) => void): () => void;
  /** Runs after the visible user event is durable but before vendor dispatch. */
  subscribeUserMessages?(listener: (session: HeadlessSessionMeta, event: HeadlessSessionEvent, origin: SendOrigin) => void | Promise<void>): () => void;
  isSessionBusy(sessionId: string): boolean;
  isAnySessionBusy(): boolean;
  close(): Promise<void>;
}

type RuntimeStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage;

type PendingInteraction = {
  sessionId: string;
  resolve: (decision: InteractionDecision) => void;
};

/**
 * Native maker-core runtime for the Linux daemon.  It owns process-local agent
 * handles only; durable session metadata and replayable events remain in the
 * injected headless storage.
 */
export class NativeHeadlessSessionRuntime implements HeadlessSessionRuntime {
  private maker: Maker | null = null;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly observedSessions = new Set<string>();
  private readonly agentEventListeners = new Set<(sessionId: string, event: AgentEvent) => void>();
  private readonly turnStartListeners = new Set<(sessionId: string, origin: SendOrigin) => void>();
  private readonly userMessageListeners = new Set<(session: HeadlessSessionMeta, event: HeadlessSessionEvent, origin: SendOrigin) => void | Promise<void>>();
  private readonly sessionContexts = new Map<string, { workingDir: string }>();
  /**
   * `AgentSessionHandle.send()` only means the vendor accepted a turn.  It does
   * not wait for generation to finish, so the host scheduler must hold its
   * lease until the matching terminal event arrives.  Without this boundary a
   * second Device Link message can race into an already-running Codex/Claude
   * turn and look like it was accepted even though the agent rejects it.
   */
  private readonly turnCompletions = new HeadlessTurnCompletionTracker();
  private readonly scheduler: HeadlessTurnScheduler;

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly stateDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly logger: Logger = new HeadlessLogger(),
    maxConcurrentTurns = 4,
    private readonly providerRouter?: HeadlessProviderRouter,
    private readonly mcpProviders: McpProvider[] = [],
    private readonly makerMemory?: MakerMemoryManager,
    private readonly mcpService?: HeadlessMcpService,
  ) {
    this.scheduler = new HeadlessTurnScheduler(maxConcurrentTurns);
  }

  /** Must run before accepting control requests so Claude always uses loopback routing. */
  async initialize(claudeEndpoint?: string, codexEndpoint?: string): Promise<void> {
    if (this.maker) return;
    const claudeBinary = resolveAgentBinary('claude-code', this.env);
    const codexBinary = resolveAgentBinary('codex', this.env);
    const codexHome = path.join(this.stateDir, 'codex-home');
    // Codex 0.145+ requires CODEX_HOME to exist before `app-server` starts.
    // It is private daemon state rather than a user-supplied login directory.
    if (codexBinary) ensureCodexHomeDirectory(codexHome);
    const agents = {
      ...(claudeBinary ? {
        'claude-code': new ClaudeCodeAgent({
          auth: new ClaudeHeadlessAuthAdapter(this.env, this.providerRouter),
          runtimeConfig: { userDataPath: this.stateDir, makerMemoryEnabled: Boolean(this.makerMemory), ...(claudeEndpoint ? { endpoint: claudeEndpoint } : {}) },
          binaryPath: claudeBinary,
          logger: this.logger,
          mcpProviders: this.mcpProviders,
          makerMemory: this.makerMemory,
        }),
      } : {}),
      ...(codexBinary ? {
        codex: new CodexAgent({
          auth: new CodexHeadlessAuthAdapter(codexHome, this.providerRouter),
          runtimeConfig: { userDataPath: this.stateDir, makerMemoryEnabled: Boolean(this.makerMemory) },
          binaryPath: codexBinary,
          logger: this.logger,
          mcpProviders: this.mcpProviders,
          makerMemory: this.makerMemory,
          ...(codexEndpoint ? {
            prepareCodexExtraSpawnConfig: async (_providers, context) => {
              // A Cindy gateway-key session has no OpenAI subscription token.
              // It must use the loopback proxy's placeholder env key, whereas
              // oauth-bearer retains Codex's native OpenAI authentication.
              const authMode = context.credentialMode === 'oauth-bearer'
                ? 'oauth-bearer'
                : 'provider-oauth';
              const mcp = this.mcpService?.prepareCodexExtraSpawnConfig() ?? { extraArgs: [], extraEnv: {} };
              return {
                extraArgs: [...buildCodexProxySpawnArgs(codexEndpoint, authMode), ...mcp.extraArgs],
                extraEnv: { ...(authMode === 'provider-oauth' ? codexProxyAuthEnv() : {}), ...mcp.extraEnv },
                codexProxyActive: true,
              };
            },
            registerCodexMcpThreadContext: ({ threadId, sessionId }) => {
              this.providerRouter?.registerCodexThread(sessionId, threadId);
              this.mcpService?.registerCodexThread(sessionId, threadId, this.sessionContexts.get(sessionId)?.workingDir ?? '');
            },
            unregisterCodexMcpThreadContext: (threadId) => {
              this.providerRouter?.forgetCodexThread(threadId);
              this.mcpService?.unregisterCodexThread(threadId);
            },
          } : {}),
        }),
      } : {}),
    };
    this.makerMemory?.setAgents(agents);
    if (this.makerMemory?.isEnabled()) await this.makerMemory.enable();
    this.maker = new Maker({ agents, storage: this.storage, logger: this.logger, makerMemory: this.makerMemory });
  }

  /** Preserve a remote queue item's identity when it becomes a real turn. */
  async sendWithClientId(meta: HeadlessSessionMeta, content: string | UserMessage, clientId: string, displayContent: unknown = content): Promise<void> {
    await this.send(meta, content, { kind: 'user' }, clientId, displayContent);
  }

  async send(
    meta: HeadlessSessionMeta,
    content: string | UserMessage,
    origin: SendOrigin = { kind: 'user' },
    clientId?: string,
    displayContent: unknown = content,
  ): Promise<void> {
    for (const listener of this.turnStartListeners) listener(meta.id, origin);
    const event = await this.storage.appendEvent(meta.id, 'user_message', {
      content: displayContent,
      ...(clientId?.trim() ? { clientId } : {}),
    });
    for (const listener of this.userMessageListeners) await listener(meta, event, origin);
    this.enqueueSend(meta, content, origin);
  }

  async sendGoal(meta: HeadlessSessionMeta, directive: string, visibleContent?: string): Promise<void> {
    const origin: SendOrigin = { kind: 'goal' };
    for (const listener of this.turnStartListeners) listener(meta.id, origin);
    if (visibleContent) await this.storage.appendEvent(meta.id, 'user_message', { content: visibleContent, goal: true });
    else await this.storage.appendEvent(meta.id, 'goal_turn', {});
    this.enqueueSend(meta, directive, origin);
  }

  private enqueueSend(meta: HeadlessSessionMeta, content: string | UserMessage, origin: SendOrigin): void {
    this.scheduler.enqueue(meta.id, async () => {
      try {
        // A history edit deliberately clears the native vendor id.  The next
        // visible user message starts a fresh native session with a durable,
        // hidden handoff prefix so display history and model context agree.
        const currentMeta = await this.storage.get(meta.id) ?? meta;
        const handoff = currentMeta.pendingHandoff;
        const session = await this.ensureSession(currentMeta);
        const completion = this.turnCompletions.waitFor(meta.id);
        const result = await session.send(handoff ? prependHandoff(content, handoff) : content, { origin });
        // Cancellation before the SDK dispatches intentionally has no terminal
        // event.  It still must release the scheduler lease.
        if (!result.accepted) {
          this.turnCompletions.complete(meta.id);
          return;
        }
        if (handoff) await this.storage.update(meta.id, { pendingHandoff: undefined });
        await completion;
      } catch (error) {
        this.turnCompletions.complete(meta.id);
        await this.storage.appendEvent(meta.id, 'agent_event', {
          type: 'error',
          data: { message: error instanceof Error ? error.message : String(error), isTerminal: true },
          source: meta.agentKind,
        });
      }
    });
  }

  async abort(sessionId: string): Promise<void> {
    const cancelled = this.scheduler.cancelQueued(sessionId);
    const session = this.requireMaker().getSession(sessionId);
    if (session) await session.abort();
    if (!session && cancelled === 0) throw new Error(`Session ${sessionId} is not currently attached to this daemon`);
  }

  async steer(meta: HeadlessSessionMeta, content: string | UserMessage): Promise<void> {
    const session = this.requireMaker().getSession(meta.id);
    if (!session) throw new Error(`Session ${meta.id} is not currently attached to this daemon`);
    if (!this.isSessionBusy(meta.id)) throw new Error(`Session ${meta.id} has no running turn to steer`);
    await this.storage.appendEvent(meta.id, 'user_message', { content, steer: true });
    await session.steer(content);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.scheduler.cancelQueued(sessionId);
    const session = this.requireMaker().getSession(sessionId);
    if (!session) return;
    if (this.isSessionBusy(sessionId)) throw new Error('Session has a running turn; stop it before closing');
    await this.requireMaker().closeSession(sessionId);
    this.observedSessions.delete(sessionId);
    this.providerRouter?.forgetSession(sessionId);
    this.mcpService?.forgetSession(sessionId);
  }

  async resolveInteraction(sessionId: string, requestId: string, decision: InteractionDecision): Promise<boolean> {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    this.pendingInteractions.delete(requestId);
    pending.resolve(decision);
    await this.storage.appendEvent(sessionId, 'interaction_resolved', { requestId, decision });
    return true;
  }

  isSessionBusy(sessionId: string): boolean {
    return this.scheduler.snapshot().activeSessionIds.includes(sessionId);
  }

  isAnySessionBusy(): boolean {
    return this.scheduler.snapshot().activeTurns > 0;
  }

  async reconfigure(sessionId: string): Promise<void> {
    if (this.isSessionBusy(sessionId)) {
      throw new Error('Session has a running turn; wait for it to finish or stop it before changing its agent, provider, or model');
    }
    const maker = this.requireMaker();
    const session = maker.getSession(sessionId);
    if (session) await maker.closeSession(sessionId);
  }

  async setOrcaRole(sessionId: string, role: 'lead' | 'worker' | null): Promise<void> {
    const session = this.requireMaker().getSession(sessionId);
    if (session) await session.setVendorOptions({ orcaRole: role });
  }

  async setExtraDirs(sessionId: string, dirs: string[]): Promise<void> {
    const session = this.requireMaker().getSession(sessionId);
    if (session) await session.setExtraDirs(dirs);
  }

  subscribeAgentEvents(listener: (sessionId: string, event: AgentEvent) => void): () => void {
    this.agentEventListeners.add(listener);
    return () => this.agentEventListeners.delete(listener);
  }

  subscribeTurnStarts(listener: (sessionId: string, origin: SendOrigin) => void): () => void {
    this.turnStartListeners.add(listener);
    return () => this.turnStartListeners.delete(listener);
  }

  subscribeUserMessages(listener: (session: HeadlessSessionMeta, event: HeadlessSessionEvent, origin: SendOrigin) => void | Promise<void>): () => void {
    this.userMessageListeners.add(listener);
    return () => this.userMessageListeners.delete(listener);
  }

  listAgentCommands(agentKind: HeadlessSessionMeta['agentKind']): unknown {
    return this.requireMaker().listAgentCommands(agentKind);
  }

  listAgentSkills(
    agentKind: HeadlessSessionMeta['agentKind'],
    options: { workingDir: string; forceReload?: boolean },
  ): Promise<unknown> {
    return this.requireMaker().listAgentSkills(agentKind, options);
  }

  scanAtResources(
    agentKind: HeadlessSessionMeta['agentKind'],
    options: { workingDir: string; cap?: number; query?: string },
  ): Promise<unknown> {
    return this.requireMaker().scanAtResources(agentKind, options);
  }

  async forkNativeSession(
    agentKind: HeadlessSessionMeta['agentKind'],
    options: { sourceSdkSessionId: string; upToMessageId?: string; tailTurnsToDrop?: number; title?: string; workingDir?: string },
  ): Promise<{ newSdkSessionId: string; uuidMap: Map<string, string> }> {
    return this.requireMaker().forkSdkSession(agentKind, options);
  }

  async previewNativeRewind(sessionMeta: HeadlessSessionMeta, userUuid: string): Promise<{
    canRewind: boolean; filesChanged: string[]; insertions: number; deletions: number; error?: string;
  }> {
    const session = await this.ensureSession(sessionMeta);
    return session.previewRewindFiles(userUuid);
  }

  async commitNativeRewind(
    sessionMeta: HeadlessSessionMeta,
    userUuid: string,
    priorAssistantUuid: string,
    options?: { tailTurnsToDrop?: number },
  ): Promise<{ sdkSessionId?: string }> {
    const session = await this.ensureSession(sessionMeta);
    return session.commitRewindFiles(userUuid, priorAssistantUuid, options);
  }

  async close(): Promise<void> {
    this.scheduler.cancelAllQueued();
    for (const interaction of this.pendingInteractions.values()) {
      interaction.resolve({ kind: 'permission', behavior: 'deny', reason: 'daemon_stopped' });
    }
    this.pendingInteractions.clear();
    for (const sessionId of this.observedSessions) this.turnCompletions.complete(sessionId);
    await Promise.all([...this.observedSessions].map((sessionId) =>
      this.maker?.closeSession(sessionId).catch(() => undefined),
    ));
  }

  private async ensureSession(meta: HeadlessSessionMeta) {
    const maker = this.requireMaker();
    if (meta.sdkSessionId) this.providerRouter?.registerClaudeSdkSession(meta.id, meta.sdkSessionId);
    this.sessionContexts.set(meta.id, { workingDir: meta.workDir || process.env.HOME || '/' });
    const existing = maker.getSession(meta.id);
    const session = existing ?? await maker.createSession({
      id: meta.id,
      agentKind: meta.agentKind,
      workingDir: meta.workDir || process.env.HOME || '/',
      workspaceKind: meta.workspaceKind,
      title: meta.title,
      model: meta.model,
      providerId: meta.providerId,
      effort: meta.effort,
      permissionMode: meta.permissionMode,
      fastMode: meta.fastMode,
      resumeSessionId: meta.sdkSessionId,
      parentSessionId: meta.parentSessionId,
      vendorOptions: meta.orcaRole ? { orcaRole: meta.orcaRole } : undefined,
      extraDirs: meta.extraDirs,
    });
    if (!this.observedSessions.has(meta.id)) this.observeSession(meta.id, session);
    return session;
  }

  private observeSession(sessionId: string, session: ReturnType<Maker['getSession']> extends infer T ? Exclude<T, undefined> : never): void {
    this.observedSessions.add(sessionId);
    session.onEvent((event) => {
      if (event.type === 'session_id' && typeof event.data === 'string') {
        this.providerRouter?.registerClaudeSdkSession(sessionId, event.data);
      }
      void this.storage.appendEvent(sessionId, 'agent_event', serializeAgentEvent(event)).catch((error) => {
        this.logger.error('failed to persist headless agent event', { sessionId, error: error instanceof Error ? error.message : String(error) });
      });
      for (const listener of this.agentEventListeners) listener(sessionId, event);
      if (event.type === 'done' || isTerminalAgentError(event)) this.turnCompletions.complete(sessionId);
    });
    session.onStatusChange((status) => {
      if (status === 'closed') {
        this.providerRouter?.forgetSession(sessionId);
        this.mcpService?.forgetSession(sessionId);
      }
      if (status === 'closed' || status === 'error') this.turnCompletions.complete(sessionId);
      void this.storage.appendEvent(sessionId, 'session_status', { status }).catch(() => undefined);
    });
    session.setInteractionListener((request) => this.waitForInteraction(sessionId, request));
  }

  private async waitForInteraction(sessionId: string, request: InteractionRequest): Promise<InteractionDecision> {
    await this.storage.appendEvent(sessionId, 'interaction_request', request);
    return new Promise<InteractionDecision>((resolve) => {
      this.pendingInteractions.set(request.requestId, { sessionId, resolve });
    });
  }

  private requireMaker(): Maker {
    if (!this.maker) throw new Error('Headless runtime is not initialized');
    return this.maker;
  }

}

function isTerminalAgentError(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  return (event.data as { isTerminal?: unknown } | null)?.isTerminal === true;
}

function serializeAgentEvent(event: AgentEvent): AgentEvent {
  // Session already applies maker-shared error redaction before listeners run;
  // preserve the normalized event shape for both CLI and Device Link adapters.
  return event;
}

function prependHandoff(content: string | UserMessage, handoff: string): string | UserMessage {
  if (typeof content === 'string') return `${handoff}\n\n${content}`;
  // maker-core's UserMessage is intentionally structurally broad. Preserve
  // attachments/blocks and only prepend when a text payload is representable;
  // otherwise the deterministic handoff still reaches the agent as a text
  // first block without altering the stored display message.
  if (typeof content.content === 'string') return { ...content, content: `${handoff}\n\n${content.content}` };
  if (Array.isArray(content.content)) return {
    ...content,
    content: [{ type: 'text', text: handoff }, ...content.content],
  } as UserMessage;
  return content;
}

/** Resolve only an executable explicitly supplied by the host or installed with Cindy. */
export function resolveAgentBinary(kind: 'claude-code' | 'codex', env: NodeJS.ProcessEnv = process.env): string | null {
  const envKey = kind === 'claude-code' ? 'CINDY_CLAUDE_BINARY' : 'CINDY_CODEX_BINARY';
  const executable = kind === 'claude-code' ? 'claude' : 'codex';
  const configured = env[envKey]?.trim();
  if (configured) return isExecutable(configured) ? configured : null;

  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const bundled = path.join(repoRoot, 'apps', `${kind}-bin`, `${process.platform}-${process.arch}`, executable);
  if (isExecutable(bundled)) return bundled;

  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, executable);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    return path.isAbsolute(file) && statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Creates the private CODEX_HOME required by the upstream app-server. */
export function ensureCodexHomeDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

/** Claude uses a systemd-loaded credential; no API key is ever written by this host. */
export class ClaudeHeadlessAuthAdapter implements AuthAdapter {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly providerRouter?: HeadlessProviderRouter,
  ) {}

  async getState(): Promise<AuthState> {
    return (this.providerRouter ? await this.providerRouter.hasClaudeCredential() : Boolean(this.readApiKey()))
      ? { authenticated: true, authSource: 'api-key' }
      : { authenticated: false, errorReason: 'missing_systemd_credential' };
  }

  async triggerLogin(): Promise<AuthState> {
    return { authenticated: false, errorReason: 'configure_anthropic_api_key_credential' };
  }

  async logout(): Promise<void> {
    throw new Error('Headless API credentials are managed outside Cindy; remove the systemd credential to log out');
  }

  async getAuthEnv(): Promise<Record<string, string>> {
    if (this.providerRouter) return this.providerRouter.proxyAuthEnv();
    const key = this.readApiKey();
    return key ? { ANTHROPIC_API_KEY: key } : {};
  }

  private readApiKey(): string | null {
    const direct = this.env.CINDY_ANTHROPIC_API_KEY?.trim();
    if (direct) return direct;
    return readSystemdCredential(this.env, 'anthropic_api_key');
  }
}

/** Codex is an execution runtime; Cindy account gateway credentials take priority when present. */
export class CodexHeadlessAuthAdapter implements AuthAdapter {
  constructor(
    private readonly codexHome: string,
    private readonly providerRouter?: HeadlessProviderRouter,
  ) {}

  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    const oauth = existsSync(path.join(this.codexHome, 'auth.json'));
    if (await this.providerRouter?.hasCodexProviderCredential()) {
      return { authenticated: true, authSource: 'api-key' };
    }
    return oauth
      ? { authenticated: true, authSource: 'oauth' }
      : { authenticated: false, errorReason: 'run_cindy_provider_login_openai' };
  }

  async triggerLogin(): Promise<AuthState> {
    return { authenticated: false, errorReason: 'run_cindy_provider_login_openai' };
  }

  async logout(): Promise<void> {
    throw new Error('Cindy account credentials are managed by cindy logout');
  }

  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    return {
      CODEX_HOME: this.codexHome,
      ...(await this.providerRouter?.hasCodexProviderCredential() || options?.credentialMode === 'provider-oauth' ? codexProxyAuthEnv() : {}),
    };
  }
}

function readSystemdCredential(env: NodeJS.ProcessEnv, name: string): string | null {
  const directory = env.CREDENTIALS_DIRECTORY?.trim();
  if (!directory || !/^[a-z0-9_]+$/.test(name)) return null;
  try {
    const value = readFileSync(path.join(directory, name), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Minimal daemon logger that keeps runtime diagnostics out of the control protocol. */
export class HeadlessLogger implements Logger {
  trace(message: string, context?: Record<string, unknown>): void { this.write('trace', message, context); }
  debug(message: string, context?: Record<string, unknown>): void { this.write('debug', message, context); }
  info(message: string, context?: Record<string, unknown>): void { this.write('info', message, context); }
  warn(message: string, context?: Record<string, unknown>): void { this.write('warn', message, context); }
  error(message: string, context?: Record<string, unknown>): void { this.write('error', message, context); }
  fatal(message: string, context?: Record<string, unknown>): void { this.write('fatal', message, context); }
  child(scope: string): Logger { return new HeadlessLogger(scope); }

  constructor(private readonly scope = 'headless') {}

  private write(level: string, message: string, context?: Record<string, unknown>): void {
    const safeContext = context ? redactLogContext(context) : undefined;
    process.stderr.write(`${JSON.stringify({ level, scope: this.scope, message, ...(safeContext ? { context: safeContext } : {}) })}\n`);
  }
}

function redactLogContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [
    key,
    /(key|token|secret|authorization|credential)/i.test(key) ? '[REDACTED]' : value,
  ]));
}
