import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { isAntigravitySubscriptionModel } from './model-policy.js';
export { isAntigravitySubscriptionModel } from './model-policy.js';
import { BaseAgent, AgentStartupStoppedError, TASK_SYSTEM_PROMPT, type AgentDeps, type AgentSessionHandle, type StartSessionOptions, type SendOptions } from '../base-agent.js';
import type { AuthState, Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { Capabilities } from '../../types/capabilities.js';
import type { AgentEvent, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { AcpSubscriptionSession, type AcpDiscoveredModel } from './subscription-session.js';
import { record, type AcpRecord, type AcpResponse, type AcpTransport } from './client.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKGROUND_IDLE_MS = 2_000;
const CANCEL_GRACE_MS = 15_000;

/** Validate the selected executable's protocol without loading a user session or authenticating. */
export async function probeAntigravityRuntime(transport: AcpTransport, cwd: string): Promise<void> {
  const session = new AcpSubscriptionSession({
    transport,
    cwd,
    assertSubscriptionOnly: async () => {},
    onUpdate: () => {},
    requestPermission: async () => false,
  });
  try { await session.initialize(); }
  finally { await session.close(); }
}

interface AntigravityConnection {
  transport: AcpTransport;
  assertSubscriptionOnly(): Promise<void>;
  assertGenerationAllowed?(): Promise<void>;
  isCurrent?(): boolean;
  sessionScope?: string;
  useCachedAuthentication?: boolean;
  mcpServers?: AcpRecord[];
  dispose?(): void;
}
export interface AntigravityHost {
  connect(cwd: string, opts?: StartSessionOptions): Promise<AntigravityConnection>;
  /** Check the native subscription/credits policy before generation, independently of OAuth. */
  assertGenerationAllowed?(): Promise<void>;
  assertSessionAllowed?(): Promise<void>;
  authenticated?(): Promise<void>;
  disconnected?(): void;
  modelsChanged(models: AcpDiscoveredModel[], tier?: { id: string; name: string }): void;
}
export function antigravityNativeResumeId(id: string | undefined, scope: string): string | undefined {
  if (scope) return id?.startsWith(scope) ? id.slice(scope.length) || undefined : undefined;
  return id?.startsWith('antigravity-profile:') ? undefined : id;
}
const no = { supported: false, reason: 'not-implemented' } as const;
const yes = { supported: true } as const;
function nativeMode(permission: PermissionMode | undefined, plan: boolean): string {
  if (plan || permission === 'plan') return 'plan';
  if (permission === 'auto') return 'auto';
  if (permission === 'acceptEdits') return 'accept-edits';
  return 'default';
}
function assertPermission(permission: PermissionMode | undefined): void {
  if (permission && !['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(permission)) throw new Error('ANTIGRAVITY_PERMISSION_UNSUPPORTED');
}
function promptContent(message: UserMessage): AcpRecord[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return message.content.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'file' || block.type === 'mention') {
      if (!path.isAbsolute(block.path)) throw new Error('ANTIGRAVITY_ATTACHMENT_PATH_INVALID');
      return { type: 'resource_link', uri: pathToFileURL(block.path).href, name: block.type === 'mention' ? block.name : path.basename(block.path),
        ...(block.type === 'file' && block.mimeType ? { mimeType: block.mimeType } : {}) };
    }
    throw new Error('ANTIGRAVITY_IMAGE_INPUT_UNSUPPORTED');
  });
}
export class AntigravityAgent extends BaseAgent {
  readonly kind = 'antigravity' as const;
  readonly capabilities: Capabilities = {
    switchModel: yes, availableModels: [], hasFastMode: false, effort: no, effortLevels: [], reasoningDisplay: ['off'],
    permissionModes: [{ id: 'ask', displayName: 'Ask' }, { id: 'acceptEdits', displayName: 'Accept edits' }, { id: 'auto', displayName: 'Auto' }, { id: 'bypassPermissions', displayName: 'Full access' }], setPermissionModeMidSession: yes, planMode: yes,
    multimodal: { text: yes, image: no, file: yes }, fork: no, rewind: no, abort: yes,
    sameTurnSteer: no, extraDirs: no, memory: { supported: no },
  };
  private loginSession?: AcpSubscriptionSession;
  private locallyDisconnected = false;
  override cancelLogin(): void {
    this.connectionVersion += 1;
    if (!this.authState.authenticated) this.cachedProbe = undefined;
    void this.loginSession?.close().catch(() => {});
  }
  private authState: AuthState = { authenticated: false, authSource: 'oauth' };
  private cachedProbe?: Promise<void>;
  private connectionVersion = 0;
  private retryProbeAt = 0;
  private nativeModels: AcpDiscoveredModel[] = [];
  constructor(deps: AgentDeps, private host: AntigravityHost) { super(deps); }
  override async getAuthState(): Promise<AuthState> { await this.refreshCachedState(); return { ...this.authState }; }
  /** A profile change discards auth/model state and fences work from the prior connection. */
  resetConnection(): void {
    this.cancelLogin();
    this.loginSession = undefined;
    this.locallyDisconnected = false;
    this.cachedProbe = undefined;
    this.retryProbeAt = 0;
    this.authState = { authenticated: false, authSource: 'oauth' };
    this.updateModels([], { allowEmpty: true });
  }
  /** Discover cached native credentials without creating a login flow. */
  async refreshCachedState(): Promise<void> {
    if (this.locallyDisconnected || Date.now() < this.retryProbeAt) return;
    const version = this.connectionVersion;
    if (!this.cachedProbe) this.cachedProbe = (async () => {
      let connection: Awaited<ReturnType<AntigravityHost['connect']>> | undefined;
      let session: AcpSubscriptionSession | undefined;
      try {
        await this.host.assertSessionAllowed?.();
        connection = await this.host.connect(globalThis.process.cwd());
        session = new AcpSubscriptionSession({ ...connection, cwd: globalThis.process.cwd(), onUpdate() {}, requestPermission: async () => false });
        await session.initialize(); await session.open({ cachedAuthentication: true });
        await session.discoverModelOptions().catch(() => {});
        if (this.locallyDisconnected || version !== this.connectionVersion || connection.isCurrent?.() === false || !session.tier) return;
        this.publishModels(session);
        this.authState = { authenticated: true, authSource: 'oauth', subscriptionTier: { ...session.tier } };
      } catch { /* Discovery failure leaves the regular sign-in entry available. */ }
      finally { try { await session?.close(); } finally { connection?.dispose?.(); } }
    })().catch(() => {}).finally(() => {
      if (version === this.connectionVersion && !this.authState.authenticated) {
        this.cachedProbe = undefined;
        this.retryProbeAt = Date.now() + 30_000;
      }
    });
    await this.cachedProbe;
  }
  override async triggerLogin(): Promise<AuthState> {
    const version = ++this.connectionVersion;
    this.cachedProbe = undefined;
    const connection = await this.host.connect(globalThis.process.cwd());
    const session = new AcpSubscriptionSession({ ...connection, cwd: globalThis.process.cwd(), onUpdate() {}, requestPermission: async () => false });
    try {
      if (version !== this.connectionVersion || connection.isCurrent?.() === false) throw new Error('ANTIGRAVITY_CONNECTION_CHANGED');
      this.loginSession = session;
      await session.initialize(); await session.authenticate(); await session.open();
      await session.discoverModelOptions().catch(() => {});
      if (version !== this.connectionVersion || connection.isCurrent?.() === false) throw new Error('ANTIGRAVITY_CONNECTION_CHANGED');
      await this.host.authenticated?.();
      if (version !== this.connectionVersion || connection.isCurrent?.() === false) throw new Error('ANTIGRAVITY_CONNECTION_CHANGED');
      this.locallyDisconnected = false;
      this.authState = { authenticated: true, authSource: 'oauth', subscriptionTier: session.tier && { ...session.tier } };
      this.publishModels(session);
      this.cachedProbe = Promise.resolve(); return { ...this.authState };
    } finally {
      if (this.loginSession === session) this.loginSession = undefined;
      try { await session.close(); } finally { connection.dispose?.(); }
    }
  }
  override async logout(): Promise<void> {
    // Do not delete credentials shared with an independent official CLI installation.
    this.cancelLogin();
    this.cachedProbe = undefined;
    this.locallyDisconnected = true;
    this.authState = { authenticated: false, authSource: 'oauth' };
    this.updateModels([], { allowEmpty: true }); this.host.disconnected?.();
  }
  private updateModels(models: AcpDiscoveredModel[], { allowEmpty = false }: { allowEmpty?: boolean } = {}): void {
    const admitted = models.filter(m => isAntigravitySubscriptionModel(m.id));
    if (!allowEmpty && admitted.length === 0 && this.nativeModels.length > 0) return;
    this.nativeModels = admitted.map(model => {
      const previous = this.nativeModels.find(value => value.id === model.id);
      return { ...previous, ...model, defaultEffort: model.efforts?.length === 0 ? null : model.defaultEffort ?? previous?.defaultEffort ?? null,
        effortDisplayNames: { ...previous?.effortDisplayNames, ...model.effortDisplayNames } };
    });
    this.capabilities.availableModels = this.nativeModels.map(m => ({ id: m.id, displayName: m.name, contextWindow: 0, efforts: m.efforts ?? [], defaultEffort: m.defaultEffort ?? null,
      ...(m.effortDisplayNames ? { effortDisplayNames: m.effortDisplayNames } : {}) }));
    const efforts = [...new Set(this.capabilities.availableModels.flatMap(model => [...model.efforts]))];
    this.capabilities.effort = efforts.length ? yes : no;
    this.capabilities.effortLevels = efforts.map(id => ({ id, displayName: id === 'xhigh' ? 'Extra' : id[0].toUpperCase() + id.slice(1) }));
  }
  private publishModels(session: AcpSubscriptionSession): void {
    this.updateModels(session.models); this.host.modelsChanged(this.nativeModels, session.tier);
  }
  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    // No silent downgrade of profile, device, review or permission semantics.
    if (opts.providerId !== 'google-antigravity-subscription' || opts.remoteHostId || opts.deviceHosted || (opts.botRuntimeProfile && !opts.botRuntimeProfile.projectContext) || opts.reviewMode) {
      throw new AgentStartupStoppedError(new Error('ANTIGRAVITY_LOCAL_SESSION_ONLY'));
    }
    assertPermission(opts.permissionMode);
    if (opts.fastMode) throw new AgentStartupStoppedError(new Error('ANTIGRAVITY_FAST_MODE_UNSUPPORTED'));
    if (this.locallyDisconnected) throw new AgentStartupStoppedError(new Error('Google 订阅连接已断开，请先重新连接。'));
    await this.host.assertSessionAllowed?.();
    let permission = opts.permissionMode; let plan = opts.planMode === true;
    let connection = await this.host.connect(opts.workingDir, opts);
    const scope = connection.sessionScope ?? '';
    // The saved Cindy task stays in place. Only a native ID from the current
    // Google profile may reach session/load or session/resume.
    const resumeId = antigravityNativeResumeId(opts.resumeSessionId, scope);
    const assertCurrent = () => {
      if (connection.isCurrent?.() === false) throw new Error('ANTIGRAVITY_SESSION_ACCOUNT_CHANGED');
    };
    const queue = createAsyncQueue<AgentEvent>();
    let resolver: InteractionResolver = async () => ({ kind: 'permission', behavior: 'deny' });
    let usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
    let active = false; let closed = false; let promptDispatched = false; let currentText = '';
    let backgroundText = '';
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    let control: Promise<void> | undefined; let usable = true; let lastModel = opts.model; let lastEffort: Effort | undefined = opts.effort;
    let turnController: AbortController | undefined;
    let cancelTurn: (() => void) | undefined;
    const toolIsBackground = new Map<string, boolean>();
    const emit = (type: AgentEvent['type'], data: unknown, background = false) => {
      queue.push({ type, data, source: 'antigravity', ...(background ? { turnScope: 'background' as const } : {}) });
    };
    const flushBackgroundText = () => {
      if (backgroundTimer) clearTimeout(backgroundTimer);
      backgroundTimer = undefined;
      if (!backgroundText) return;
      const text = backgroundText;
      backgroundText = '';
      emit('text', { text, isFinal: true, isFullText: true }, true);
    };
    const createSession = (current: typeof connection) => new AcpSubscriptionSession({
      ...current, cwd: opts.workingDir, systemPrompt: [opts[TASK_SYSTEM_PROMPT], opts.botProfilePrompt, opts.userPrompt, opts.botProfileContextPrompt].filter(Boolean).join("\n\n"),
      onClose() {
        if (current !== connection || closed) return;
        closed = true; usable = false; turnController?.abort();
        // Only release the event stream after this process has stopped. Session's
        // normal stream-end lifecycle then rebuilds on the next user send; no replay.
        void session.close().then(() => {
          try { current.dispose?.(); } finally { flushBackgroundText(); queue.end(); }
        }).catch(() => {
          thisAgent.deps.logger.warn('ACP cleanup pending after connection closed', { code: 'ACP_PROCESS_EXIT_UNCONFIRMED' });
        });
      },
      onUpdate(update) {
        if (current !== connection || closed) return;
        const background = !promptDispatched;
        const type = update.sessionUpdate;
        if (type === 'config_option_update') {
          if (current.isCurrent?.() !== false && !thisAgent.locallyDisconnected) thisAgent.publishModels(session);
        } else if (type === 'usage_update') {
          // ACP used/size describes the active context, never account quota or
          // turn input+output totals. Missing fields remain unknown.
          if (typeof update.used === 'number' && Number.isFinite(update.used) && update.used >= 0 &&
              typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0) {
            usage = { ...usage, contextTokens: update.used, contextWindow: update.size };
            queue.push({ type: 'status', data: { contextTokens: usage.contextTokens, contextWindow: usage.contextWindow }, source: 'antigravity', turnScope: 'background' });
          }
        } else if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
          const content = record(update.content);
          if (content.type === 'text' && typeof content.text === 'string') {
            if (type === 'agent_message_chunk') {
              if (background) {
                backgroundText += content.text;
                if (backgroundTimer) clearTimeout(backgroundTimer);
                backgroundTimer = setTimeout(flushBackgroundText, BACKGROUND_IDLE_MS);
                backgroundTimer.unref?.();
              } else currentText += content.text;
            }
            emit(type === 'agent_message_chunk' ? 'text' : 'thinking', { text: content.text, isFinal: false }, background);
          }
        } else if (type === 'tool_call') {
          if (background) flushBackgroundText();
          else {
            if (currentText) emit('text', { text: currentText, isFinal: true, isFullText: true });
            currentText = '';
          }
          const toolUseId = String(update.toolCallId ?? '');
          const toolName = String(update.title ?? update.kind ?? 'Antigravity');
          toolIsBackground.set(toolUseId, background);
          emit('tool_use', { toolUseId, ...parseMessageToolUse({ role: 'tool_use', toolUseId, content: { toolName, input: record(update.rawInput) } }) }, background);
        } else if (type === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
          const toolUseId = String(update.toolCallId ?? '');
          const content = Array.isArray(update.content) ? update.content.map(record) : [];
          const fullText = content.map(block => record(block.content)).filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n');
          const isError = update.status === 'failed';
          const backgroundTool = toolIsBackground.get(toolUseId) ?? background;
          emit('tool_result_full', { toolUseId, fullText, isError }, backgroundTool);
          emit('tool_result', { toolUseIds: [toolUseId], summary: isError ? 'failed' : 'done' }, backgroundTool);
          toolIsBackground.delete(toolUseId);
        }
      },
      async requestPermission(input, signal) {
        const decision = await resolver({ kind: 'permission', requestId: `acp-${String(input.toolCallId)}`, toolUseId: String(input.toolCallId), toolName: String(input.title ?? input.kind ?? 'Antigravity'), input: record(input.rawInput), title: String(input.title ?? 'Antigravity') }, signal);
        return decision.kind === 'permission' && decision.behavior === 'allow';
      },
    });
    const thisAgent = this;
    let session = createSession(connection);
    let id: string;
    try {
      await session.initialize();
      if (!connection.useCachedAuthentication) await session.authenticate();
      id = await session.open({ cachedAuthentication: connection.useCachedAuthentication, resumeId, mcpServers: connection.mcpServers, mode: nativeMode(permission, plan) });
      if (session.currentModel !== opts.model || !session.models.some(model => model.id === opts.model)) await session.setModel(opts.model);
      if (opts.effort !== undefined && session.currentEffort !== opts.effort) await session.setEffort(opts.effort);
      lastEffort = session.currentEffort;
      assertCurrent();
      if (this.locallyDisconnected) throw new Error('Google 订阅连接已断开，请先重新连接。');
      this.authState = { authenticated: true, authSource: 'oauth', subscriptionTier: session.tier && { ...session.tier } };
      this.cachedProbe = Promise.resolve();
      this.publishModels(session);
    } catch (error) { await session.close(); connection.dispose?.(); throw new AgentStartupStoppedError(error); }
    const reconnect = async (next: PermissionMode | undefined): Promise<void> => {
      usable = false;
      await session.close(); connection.dispose?.();
      toolIsBackground.clear();
      if (closed) throw new Error('ANTIGRAVITY_SESSION_CLOSED');
      assertCurrent();
      const replacement = await this.host.connect(opts.workingDir, { ...opts, permissionMode: next, resumeSessionId: scope + id, planMode: plan });
      if (connection.isCurrent?.() === false || (replacement.sessionScope ?? '') !== scope || replacement.isCurrent?.() === false) {
        try { await replacement.transport.close(); } finally { replacement.dispose?.(); }
        throw new Error('ANTIGRAVITY_SESSION_ACCOUNT_CHANGED');
      }
      const resumed = createSession(replacement);
      // Retain ownership even when startup/cleanup fails, so retry/close must
      // confirm this exact process stopped before another one can be launched.
      connection = replacement; session = resumed;
      try {
        await resumed.initialize();
        if (!replacement.useCachedAuthentication) await resumed.authenticate();
        await resumed.open({ cachedAuthentication: replacement.useCachedAuthentication, resumeId: id, mcpServers: replacement.mcpServers, mode: nativeMode(next, plan) });
        if (resumed.currentModel !== lastModel) await resumed.setModel(lastModel);
        if (lastEffort !== undefined && resumed.currentEffort !== lastEffort) await resumed.setEffort(lastEffort);
        assertCurrent();
        if (closed) throw new Error('ANTIGRAVITY_SESSION_CLOSED');
      } catch (error) { await resumed.close(); replacement.dispose?.(); throw error; }
      usable = true;
    };
    const change = async (run: () => Promise<void>): Promise<void> => {
      if (active || closed || control) throw new Error('ANTIGRAVITY_SESSION_BUSY');
      assertCurrent();
      const pending = run(); control = pending;
      try { await pending; } finally { if (control === pending) control = undefined; }
    };
    return {
      id: scope + id, agentKind: 'antigravity', get model() { return session.currentModel ?? opts.model; },
      setInteractionResolver(next) { resolver = next; }, events: () => queue,
      isTurnRunning: () => active,
      getUsageSnapshot: () => ({ ...usage }),
      send: async (message: UserMessage, sendOpts?: SendOptions) => {
        if (this.locallyDisconnected) throw new Error('Google 订阅连接已断开，请先重新连接。');
        if (active || closed || control || sendOpts?.turnPermissionPolicy) throw new Error('ANTIGRAVITY_TURN_UNSUPPORTED');
        const content = promptContent(message);
        const controller = new AbortController();
        turnController = controller; active = true; currentText = '';
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let cancelledByCaller = false;
        const cancelled = () => {
          if (controller.signal.aborted) return;
          cancelledByCaller = true;
          controller.abort();
          try { session.cancel(); } catch { /* A closed transport cannot accept a late prompt. */ }
          if (!promptDispatched) return;
          const retiring = session;
          cancelTimer = setTimeout(() => {
            usable = false;
            void retiring.close().catch(() => {
              thisAgent.deps.logger.warn('ACP cleanup pending after cancel', { code: 'ACP_PROCESS_EXIT_UNCONFIRMED' });
            });
          }, CANCEL_GRACE_MS);
          cancelTimer.unref?.();
        };
        cancelTurn = cancelled;
        sendOpts?.signal?.addEventListener('abort', cancelled, { once: true });
        const release = () => {
          active = false;
          promptDispatched = false;
          if (cancelTimer) clearTimeout(cancelTimer);
          if (turnController === controller) { turnController = undefined; cancelTurn = undefined; }
          sendOpts?.signal?.removeEventListener('abort', cancelled);
        };
        const finish = (outcome: AcpResponse) => {
          if (settled) return;
          settled = true;
          const text = currentText;
          currentText = '';
          const result = 'result' in outcome ? outcome.result : {};
          const cancelled = cancelledByCaller || result.stopReason === 'cancelled';
          release();
          if (text) emit('text', { text, isFinal: true, isFullText: true });
          for (const [toolUseId, background] of toolIsBackground) {
            if (background) continue;
            if (cancelled || 'error' in outcome) {
              toolIsBackground.delete(toolUseId);
              emit('tool_result_full', { toolUseId, fullText: 'Interrupted before the tool finished.', isError: true });
              emit('tool_result', { toolUseIds: [toolUseId], summary: 'failed' });
            } else toolIsBackground.set(toolUseId, true);
          }
          if ('error' in outcome && !cancelledByCaller) {
            emit('error', { message: outcome.error.message, isTerminal: true });
            return;
          }
          const u = record(result.usage);
          if (typeof u.totalTokens === 'number' && Number.isFinite(u.totalTokens) && u.totalTokens >= 0) usage = { ...usage, tokenUsage: u.totalTokens };
          emit('done', {
            stopReason: cancelled ? 'cancelled' : result.stopReason,
            result: text,
            status: cancelled ? 'cancelled' : 'completed',
            ...(cancelled ? { cancelled: true } : {}),
            usage,
          });
        };
        try {
          sendOpts?.signal?.throwIfAborted(); controller.signal.throwIfAborted();
          // A failed permission change never adopts the uncommitted policy. Restore
          // the last confirmed policy before a later user send, without replaying a turn.
          if (!usable) await reconnect(permission);
          if (closed) throw new Error('ANTIGRAVITY_SESSION_CLOSED');
          if (connection.assertGenerationAllowed) await connection.assertGenerationAllowed();
          else if (this.host.assertGenerationAllowed) await this.host.assertGenerationAllowed();
          else throw new Error('ANTIGRAVITY_GENERATION_POLICY_UNAVAILABLE');
          controller.signal.throwIfAborted();
          if (!session.tier || !/^(Google AI |AI )?(Pro|Ultra)$/i.test(session.tier.name)) throw new Error('ANTIGRAVITY_PERSONAL_PLAN_UNVERIFIED');
          if (!isAntigravitySubscriptionModel(session.currentModel ?? '')) throw new Error('ANTIGRAVITY_SUBSCRIPTION_MODEL_REQUIRED');
          const dispatched = await session.dispatchPrompt(content, controller.signal, {
            sent() {
              flushBackgroundText();
              promptDispatched = true;
              emit('status', { isRunning: true, status: 'Thinking...' });
            },
            response: finish,
          });
          void dispatched.completion.catch(error => {
            finish({ error: error instanceof Error ? error : new Error('ACP 请求失败') });
          });
        } catch (error) { release(); throw error; }
      },
      steer: async () => { throw new Error('ANTIGRAVITY_STEER_NOT_IMPLEMENTED'); },
      abort: async () => {
        if (cancelTurn) cancelTurn();
        else if (!closed) session.cancel();
      },
      setModel: async (model, modelOpts) => change(async () => {
        if (!usable) await reconnect(permission);
        const offered = session.models.find(candidate => candidate.id === model)?.efforts;
        if (modelOpts?.effort !== undefined && offered && !offered.includes(modelOpts.effort)) throw new Error('ANTIGRAVITY_EFFORT_UNSUPPORTED');
        try {
          await session.setModel(model);
          if (modelOpts?.effort !== undefined) await session.setEffort(modelOpts.effort);
          lastModel = model; lastEffort = session.currentEffort;
        } catch (error) {
          // Keep the host's unchanged route and the native route together. If
          // rollback itself fails, a later send must restore the native session.
          try { await session.setModel(lastModel); if (lastEffort !== undefined) await session.setEffort(lastEffort); }
          catch { usable = false; }
          throw error;
        }
      }),
      setEffort: async effort => change(async () => {
        if (!usable) await reconnect(permission);
        await session.setEffort(effort); lastEffort = session.currentEffort;
      }),
      setPermissionMode: async next => change(async () => {
        assertPermission(next);
        if (permission === next && usable) return;
        await reconnect(next); permission = next;
      }),
      setPlanMode: async enabled => change(async () => {
        if (!usable) await reconnect(permission);
        await session.setMode(nativeMode(permission, enabled)); plan = enabled;
      }),
      getPlanMode: () => plan,
      close: async () => { closed = true; cancelTurn?.(); await control?.catch(() => {}); await session.close(); connection.dispose?.(); flushBackgroundText(); queue.end(); },
    };
  }
}
