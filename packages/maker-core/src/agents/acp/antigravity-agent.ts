import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { isAntigravitySubscriptionModel } from './model-policy.js';
export { isAntigravitySubscriptionModel } from './model-policy.js';
import { BaseAgent, AgentStartupStoppedError, TASK_SYSTEM_PROMPT, type AgentDeps, type AgentSessionHandle, type StartSessionOptions, type SendOptions } from '../base-agent.js';
import type { AuthState, Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { Capabilities } from '../../types/capabilities.js';
import type { AgentEvent, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { AcpSubscriptionSession, type AcpDiscoveredModel } from './subscription-session.js';
import { record, type AcpRecord, type AcpTransport } from './client.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AntigravityHost {
  connect(cwd: string, opts?: StartSessionOptions): Promise<{ transport: AcpTransport; assertSubscriptionOnly(): Promise<void>; mcpServers?: AcpRecord[]; dispose?(): void }>;
  /** Check the native subscription/credits policy before generation, independently of OAuth. */
  assertGenerationAllowed(): Promise<void>;
  assertSessionAllowed?(): Promise<void>;
  authenticated?(): Promise<void>;
  disconnected?(): void;
  modelsChanged(models: AcpDiscoveredModel[], tier?: { id: string; name: string }): void;
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
  override cancelLogin(): void { void this.loginSession?.close(); }
  private authState: AuthState = { authenticated: false, authSource: 'oauth' };
  private cachedProbe?: Promise<void>;
  private nativeModels: AcpDiscoveredModel[] = [];
  constructor(deps: AgentDeps, private host: AntigravityHost) { super(deps); }
  override async getAuthState(): Promise<AuthState> { await this.refreshCachedState(); return { ...this.authState }; }
  /** Discover cached native credentials without creating a login flow. */
  async refreshCachedState(): Promise<void> {
    if (this.locallyDisconnected) return;
    if (!this.cachedProbe) this.cachedProbe = (async () => {
      let connection: Awaited<ReturnType<AntigravityHost['connect']>> | undefined;
      let session: AcpSubscriptionSession | undefined;
      try {
        await this.host.assertSessionAllowed?.();
        connection = await this.host.connect(globalThis.process.cwd());
        session = new AcpSubscriptionSession({ ...connection, cwd: globalThis.process.cwd(), onUpdate() {}, requestPermission: async () => false });
        await session.initialize(); await session.open({ cachedAuthentication: true }); await session.discoverModelOptions();
        if (this.locallyDisconnected || !session.tier) return;
        this.publishModels(session);
        this.authState = { authenticated: true, authSource: 'oauth', subscriptionTier: { ...session.tier } };
      } catch { /* Discovery failure leaves the regular sign-in entry available. */ }
      finally { try { await session?.close(); } finally { connection?.dispose?.(); } }
    })().catch(() => {});
    await this.cachedProbe;
  }
  override async triggerLogin(): Promise<AuthState> {
    const connection = await this.host.connect(globalThis.process.cwd());
    const session = new AcpSubscriptionSession({ ...connection, cwd: globalThis.process.cwd(), onUpdate() {}, requestPermission: async () => false });
    this.loginSession = session;
    try {
      await session.initialize(); await session.authenticate(); await session.open();
      await session.discoverModelOptions();
      await this.host.authenticated?.();
      this.locallyDisconnected = false;
      this.authState = { authenticated: true, authSource: 'oauth', subscriptionTier: session.tier && { ...session.tier } };
      this.publishModels(session);
      this.cachedProbe = Promise.resolve(); return { ...this.authState };
    } finally { this.loginSession = undefined; await session.close(); connection.dispose?.(); }
  }
  override async logout(): Promise<void> {
    // Do not delete credentials shared with an independent official CLI installation.
    this.locallyDisconnected = true;
    this.authState = { authenticated: false, authSource: 'oauth' };
    this.updateModels([]); this.host.disconnected?.();
  }
  private updateModels(models: AcpDiscoveredModel[]): void {
    this.nativeModels = models.filter(m => isAntigravitySubscriptionModel(m.id)).map(model => {
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
    const queue = createAsyncQueue<AgentEvent>();
    let resolver: InteractionResolver = async () => ({ kind: 'permission', behavior: 'deny' });
    let usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
    let active = false; let closed = false; let currentText = '';
    let control: Promise<void> | undefined; let usable = true; let lastModel = opts.model; let lastEffort: Effort | undefined = opts.effort;
    let turnController: AbortController | undefined;
    const toolNames = new Map<string, string>();
    const emit = (type: AgentEvent['type'], data: unknown) => { queue.push({ type, data, source: 'antigravity' }); };
    const createSession = (current: typeof connection) => new AcpSubscriptionSession({
      ...current, cwd: opts.workingDir, systemPrompt: [opts[TASK_SYSTEM_PROMPT], opts.botProfilePrompt, opts.userPrompt, opts.botProfileContextPrompt].filter(Boolean).join("\n\n"),
      onClose() {
        if (current !== connection || closed) return;
        closed = true; usable = false; turnController?.abort();
        // Only release the event stream after this process has stopped. Session's
        // normal stream-end lifecycle then rebuilds on the next user send; no replay.
        void session.close().then(() => {
          try { current.dispose?.(); } finally { queue.end(); }
        }).catch(() => {
          thisAgent.deps.logger.warn('ACP cleanup pending after connection closed', { code: 'ACP_PROCESS_EXIT_UNCONFIRMED' });
        });
      },
      onUpdate(update) {
        const type = update.sessionUpdate;
        if (type === 'config_option_update') {
          thisAgent.publishModels(session);
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
            if (type === 'agent_message_chunk') currentText += content.text;
            emit(type === 'agent_message_chunk' ? 'text' : 'thinking', { text: content.text, isFinal: false });
          }
        } else if (type === 'tool_call') {
          if (currentText) emit('text', { text: currentText, isFinal: true, isFullText: true });
          currentText = '';
          const toolUseId = String(update.toolCallId ?? '');
          const toolName = String(update.title ?? update.kind ?? 'Antigravity');
          toolNames.set(toolUseId, toolName);
          emit('tool_use', { toolUseId, ...parseMessageToolUse({ role: 'tool_use', toolUseId, content: { toolName, input: record(update.rawInput) } }) });
        } else if (type === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
          const toolUseId = String(update.toolCallId ?? '');
          const content = Array.isArray(update.content) ? update.content.map(record) : [];
          const fullText = content.map(block => record(block.content)).filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n');
          const isError = update.status === 'failed';
          emit('tool_result_full', { toolUseId, fullText, isError });
          emit('tool_result', { toolUseIds: [toolUseId], summary: isError ? 'failed' : 'done' });
          toolNames.delete(toolUseId);
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
      await session.initialize(); await session.authenticate();
      id = await session.open({ resumeId: opts.resumeSessionId, mcpServers: connection.mcpServers, mode: nativeMode(permission, plan) });
      await session.setModel(opts.model);
      if (opts.effort !== undefined) await session.setEffort(opts.effort);
      lastEffort = session.currentEffort;
      if (this.locallyDisconnected) throw new Error('Google 订阅连接已断开，请先重新连接。');
      this.authState = { authenticated: true, authSource: 'oauth', subscriptionTier: session.tier && { ...session.tier } };
      this.cachedProbe = Promise.resolve();
      this.publishModels(session);
    } catch (error) { await session.close(); connection.dispose?.(); throw new AgentStartupStoppedError(error); }
    const reconnect = async (next: PermissionMode | undefined): Promise<void> => {
      usable = false;
      await session.close(); connection.dispose?.();
      if (closed) throw new Error('ANTIGRAVITY_SESSION_CLOSED');
      const replacement = await this.host.connect(opts.workingDir, { ...opts, permissionMode: next, resumeSessionId: id, planMode: plan });
      const resumed = createSession(replacement);
      // Retain ownership even when startup/cleanup fails, so retry/close must
      // confirm this exact process stopped before another one can be launched.
      connection = replacement; session = resumed;
      try {
        await resumed.initialize(); await resumed.authenticate();
        await resumed.open({ resumeId: id, mcpServers: replacement.mcpServers, mode: nativeMode(next, plan) });
        await resumed.setModel(lastModel);
        if (lastEffort !== undefined) await resumed.setEffort(lastEffort);
        if (closed) throw new Error('ANTIGRAVITY_SESSION_CLOSED');
      } catch (error) { await resumed.close(); replacement.dispose?.(); throw error; }
      usable = true;
    };
    const change = async (run: () => Promise<void>): Promise<void> => {
      if (active || closed || control) throw new Error('ANTIGRAVITY_SESSION_BUSY');
      const pending = run(); control = pending;
      try { await pending; } finally { if (control === pending) control = undefined; }
    };
    return {
      id, agentKind: 'antigravity', get model() { return session.currentModel ?? opts.model; },
      setInteractionResolver(next) { resolver = next; }, events: () => queue,
      getUsageSnapshot: () => ({ ...usage }),
      send: async (message: UserMessage, sendOpts?: SendOptions) => {
        if (this.locallyDisconnected) throw new Error('Google 订阅连接已断开，请先重新连接。');
        if (active || closed || control || sendOpts?.turnPermissionPolicy) throw new Error('ANTIGRAVITY_TURN_UNSUPPORTED');
        const content = promptContent(message);
        const controller = new AbortController();
        turnController = controller; active = true; currentText = '';
        const cancelled = () => { controller.abort(); try { session.cancel(); } catch { /* A closed transport cannot accept a late prompt. */ } };
        sendOpts?.signal?.addEventListener('abort', cancelled, { once: true });
        const release = () => { active = false; if (turnController === controller) turnController = undefined; sendOpts?.signal?.removeEventListener('abort', cancelled); };
        try {
          sendOpts?.signal?.throwIfAborted(); controller.signal.throwIfAborted();
          // A failed permission change never adopts the uncommitted policy. Restore
          // the last confirmed policy before a later user send, without replaying a turn.
          if (!usable) await reconnect(permission);
          if (closed) throw new Error('ANTIGRAVITY_SESSION_CLOSED');
          await this.host.assertGenerationAllowed();
          controller.signal.throwIfAborted();
          if (!session.tier || !/^(Google AI |AI )?(Pro|Ultra)$/i.test(session.tier.name)) throw new Error('ANTIGRAVITY_PERSONAL_PLAN_UNVERIFIED');
          if (!isAntigravitySubscriptionModel(session.currentModel ?? '')) throw new Error('ANTIGRAVITY_SUBSCRIPTION_MODEL_REQUIRED');
          const dispatched = await session.dispatchPrompt(content, controller.signal);
          void dispatched.completion.then(result => {
            const u = record(result.usage);
            if (typeof u.totalTokens === 'number' && Number.isFinite(u.totalTokens) && u.totalTokens >= 0) usage = { ...usage, tokenUsage: u.totalTokens };
            release();
            if (currentText) emit('text', { text: currentText, isFinal: true, isFullText: true });
            emit('done', { stopReason: result.stopReason, result: currentText, status: result.stopReason === 'cancelled' ? 'cancelled' : 'completed', usage });
          }).catch(error => { release(); emit('error', { message: error instanceof Error ? error.message : 'ACP 请求失败', isTerminal: true }); });
        } catch (error) { release(); throw error; }
      },
      steer: async () => { throw new Error('ANTIGRAVITY_STEER_NOT_IMPLEMENTED'); },
      abort: async () => { turnController?.abort(); session.cancel(); },
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
      close: async () => { closed = true; turnController?.abort(); await control?.catch(() => {}); await session.close(); connection.dispose?.(); queue.end(); },
    };
  }
}
