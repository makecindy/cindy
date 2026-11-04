import { randomUUID } from 'node:crypto';
import {
  AgentStartupCleanupPendingError, AgentStartupStoppedError,
  BaseAgent, LOCAL_AGENT_CLIENT, TurnPermissionPolicyUnsupportedError,
  type AgentDeps, type AgentSessionHandle, type SendOptions, type StartSessionOptions,
} from '../base-agent.js';
import type { Capabilities, CapabilityStatus } from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import type { PermissionMode, UserMessage } from '../../types/common.js';
import type { AgentEvent, InteractionDecision, InteractionRequest, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { ZCodeRpcClient, type ZCodeRpcClientOptions } from './rpc-client.js';

export { ZCodeRpcClient, ZCodeRpcError } from './rpc-client.js';
export type { ZCodeRpcClientOptions, ZCodeRpcRequestOptions } from './rpc-client.js';

export interface ZCodeModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

export interface ZCodeSessionHooks {
  prepareClient?(client: ZCodeRpcClient): Promise<void>;
  /** Host must validate/persist the native history owner before this handle becomes observable. */
  onSessionReady?(nativeId: string): Promise<void>;
  resolveProviderRuntimeHeaders?(params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
}

export interface ZCodeAgentOptions extends ZCodeSessionHooks {
  args?: string[];
  env?: Record<string, string | undefined>;
  spawn?: ZCodeRpcClientOptions['spawn'];
  /** Each instance must freeze its native account/project identity for this session. */
  createSessionHooks?(options: StartSessionOptions): ZCodeSessionHooks | Promise<ZCodeSessionHooks>;
  resolveModelSelection(model: string): ZCodeModelSelection;
}

const supported: CapabilityStatus = { supported: true };
const unavailable: CapabilityStatus = { supported: false, reason: 'not-implemented' };
const nativeUnavailable = (capability: string): never => {
  throw new NotSupportedError(`ZCode ${capability}`, { supported: false, reason: 'not-implemented' });
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

const modelErrorMessages: Record<string, string> = {
  invalid_model_selection: 'ZCode could not use the selected model.',
  model_config_missing: 'ZCode model configuration is missing.',
  provider_not_found: 'The selected ZCode provider is unavailable.',
  provider_not_configured: 'The selected ZCode provider is not configured.',
  model_not_found: 'The selected ZCode model is unavailable.',
  invalid_model_request: 'ZCode rejected the model request configuration.',
  invalid_model_response: 'ZCode received an invalid model response.',
  model_request_failed: 'The ZCode model request failed.',
  model_request_auth_missing: 'ZCode native account credentials are unavailable.',
  model_request_cancelled: 'The ZCode model request was cancelled.',
  model_request_timeout: 'The ZCode model request timed out.',
  model_rate_limited: 'The ZCode model request reached an account limit.',
  model_context_exceeded: 'The ZCode model context limit was exceeded.',
};

function turnError(payload: Record<string, unknown>): Record<string, unknown> {
  const code = text(asRecord(payload.error).code);
  const message = Object.hasOwn(modelErrorMessages, code) ? modelErrorMessages[code] : undefined;
  // Native detail/stack/underlyingErrorMessage may embed account data; expose only known protocol codes.
  return { message: message ?? 'ZCode turn failed', reason: 'zcode_turn_failed', isTerminal: true,
    ...(message ? { sdkError: code } : {}) };
}

function modeFor(permission: PermissionMode): 'build' | 'edit' | 'yolo' {
  switch (permission) {
    case 'ask': case 'default': return 'build';
    case 'acceptEdits': return 'edit';
    case 'bypassPermissions': return 'yolo';
    default: return nativeUnavailable(`permission mode ${permission}`);
  }
}

function inputText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content.some((block) => block.type !== 'text')) return nativeUnavailable('attachments');
  return message.content.map((block) => block.type === 'text' ? block.text : '').join('\n');
}

function cancelledDecision(request: InteractionRequest): InteractionDecision {
  return request.kind === 'permission'
    ? { kind: 'permission', behavior: 'deny', reason: 'Request cancelled' }
    : { kind: 'ask_user_question', answers: {}, dismissed: true };
}

/**
 * Local ZCode harness; native prompts and tools remain ZCode-owned.
 * Legacy protocol checked against CLI 0.17.0 and zai-org/ZCode 3c5b2276:
 * packages/shared/src/zcode-protocol/index.ts. Authentication is injected by the host.
 * The separate v4 subscription protocol is deliberately not inferred from these envelopes.
 */
export class ZCodeAgent extends BaseAgent {
  readonly kind = 'zcode' as const;
  readonly capabilities: Capabilities;
  private readonly clients = new Set<ZCodeRpcClient>();
  private disposed = false;
  private accountGeneration = 0;

  constructor(deps: AgentDeps, private readonly options: ZCodeAgentOptions) {
    super(deps);
    this.capabilities = this.buildCapabilities({
      availableModels: [], switchModel: supported, hasFastMode: false,
      effort: unavailable, effortLevels: [], reasoningDisplay: ['off', 'full'],
      permissionModes: [
        { id: 'ask', displayName: 'Ask' }, { id: 'default', displayName: 'Default' },
        { id: 'acceptEdits', displayName: 'Accept edits' },
        { id: 'bypassPermissions', displayName: 'Full access' },
      ],
      setPermissionModeMidSession: supported, planMode: unavailable,
      turnPermissionPolicy: { supported: unavailable, unsupportedPermissionModes: ['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] },
      multimodal: { text: supported, image: unavailable, file: unavailable },
      fork: unavailable, rewind: unavailable, abort: supported, sameTurnSteer: unavailable,
      memory: { supported: unavailable }, extraDirs: unavailable, writableDirs: unavailable,
    });
  }

  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const runtime: { client?: ZCodeRpcClient } = {};
    try {
      return await this.startSessionPrepared(opts, (client) => {
        runtime.client = client;
        this.clients.add(client);
      });
    } catch (error) {
      const client = runtime.client;
      if (!client) {
        if (error instanceof AgentStartupCleanupPendingError || error instanceof AgentStartupStoppedError) throw error;
        throw new AgentStartupStoppedError(error);
      }
      try {
        await client.close();
        this.clients.delete(client);
      } catch {
        const whenStopped = client.whenStopped.then(() => { this.clients.delete(client); });
        throw new AgentStartupCleanupPendingError('ZCode startup failed and process cleanup remains unconfirmed', {
          cause: error, whenStopped,
        });
      }
      throw new AgentStartupStoppedError(error);
    }
  }

  private async startSessionPrepared(
    opts: StartSessionOptions, trackClient: (client: ZCodeRpcClient) => void,
  ): Promise<AgentSessionHandle> {
    if (this.disposed) throw new Error('ZCode agent has been disposed');
    const accountGeneration = this.accountGeneration;
    const assertCurrent = () => {
      if (this.disposed || accountGeneration !== this.accountGeneration) throw new Error('ZCode account changed during session startup');
    };
    if (opts.remoteHostId || opts.deviceHosted) return nativeUnavailable('remote execution');
    if (opts.reviewMode || opts[LOCAL_AGENT_CLIENT]) return nativeUnavailable('restricted host sessions');
    if (opts.botRuntimeProfile || opts.botProfilePrompt?.trim() || opts.botProfileContextPrompt?.trim()) {
      return nativeUnavailable('companion identity');
    }
    if (opts.userPrompt?.trim()) return nativeUnavailable('custom system instructions');
    if (opts.planMode || opts.permissionMode === 'plan') return nativeUnavailable('plan mode');
    if (opts.extraDirs?.length || opts.writableDirs?.length) return nativeUnavailable('additional directories');
    if (opts.fastMode) return nativeUnavailable('fast mode');
    if (opts.effort) return nativeUnavailable('reasoning effort override');
    if (opts.thinkingEnabled !== undefined) return nativeUnavailable('reasoning toggle');
    if (opts.contextWindowBudget !== undefined) return nativeUnavailable('context window override');
    let permissionMode: PermissionMode = opts.permissionMode ?? 'default';
    const nativeMode = modeFor(permissionMode);
    let model = opts.model;
    let selection = this.options.resolveModelSelection(model);
    const hooks = this.options.createSessionHooks
      ? await this.options.createSessionHooks(opts) : this.options;
    assertCurrent();
    const client = new ZCodeRpcClient({
      binaryPath: this.deps.binaryPath, args: this.options.args, spawn: this.options.spawn,
      cwd: opts.workingDir, env: { ...process.env, ...this.options.env },
    });
    trackClient(client);
    const queue = createAsyncQueue<AgentEvent>();
    const epoch = randomUUID();
    let id = '';
    let running = false;
    let stopping = false;
    let closed = false;
    let lastSeq = -1;
    let resolver: InteractionResolver | undefined;
    let turnText = '';
    let turnAttemptToken: number | undefined;
    let turnGeneration = 0;
    let terminal: Promise<void> = Promise.resolve();
    let resolveTerminal: (() => void) | undefined;
    let usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
    const requestTotals = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }>();
    const toolInputs = new Map<string, { name: string; input: unknown }>();
    const thinking = new Set<string>();

    const emit = (type: AgentEvent['type'], data: unknown) => {
      queue.push({ type, data, source: 'zcode', ...(turnAttemptToken === undefined ? {} : { turnAttemptToken }) });
    };
    const status = () => emit('status', { status: running ? 'running' : 'idle', isRunning: running, ...usage });
    const finish = (data: Record<string, unknown>) => {
      if (!running) return;
      running = false;
      stopping = false;
      for (const blockId of thinking) emit('thinking', { stage: 'end', blockId });
      thinking.clear();
      status();
      emit('done', data);
      resolveTerminal?.();
      resolveTerminal = undefined;
    };
    const projectSnapshot = (value: unknown) => {
      const snapshot = asRecord(value);
      const projection = asRecord(snapshot.projection);
      if (typeof projection.totalTokenCount === 'number') usage.tokenUsage = number(projection.totalTokenCount);
      if (typeof projection.contextUsed === 'number') usage.contextTokens = number(projection.contextUsed);
      if (typeof projection.contextWindow === 'number') usage.contextWindow = number(projection.contextWindow);
    };
    const refreshIdleUsage = () => {
      const generation = turnGeneration;
      void client.request('session/read', { sessionId: id, contentProfile: 'index', messageLimit: 1 }, { timeoutMs: 5_000 })
        .then((snapshot) => {
          if (closed || running || generation !== turnGeneration) return;
          projectSnapshot(snapshot);
          status();
        }).catch(() => {});
    };

    const interact = async (request: InteractionRequest, signal: AbortSignal): Promise<InteractionDecision> => {
      if (closed || stopping || signal.aborted || !resolver) return cancelledDecision(request);
      emit('interaction_request', request);
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => resolver!(request, signal)).catch(() => cancelledDecision(request)),
          new Promise<InteractionDecision>((resolve) => {
            onAbort = () => resolve(cancelledDecision(request));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        emit('interaction_dismissed', { requestId: request.requestId });
      }
    };

    client.setRequestHandler(async (method, params, signal) => {
      if (method === 'session/requestRuntimePreferences') return {
        nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      };
      if (method === 'interaction/requestProviderRuntimeHeaders') {
        if (!text(params.sessionId)) throw new Error('ZCode authentication session is missing');
        // This process belongs exclusively to one Cindy task. Native descendants may carry
        // their own session IDs; the host still validates every request's frozen account/project scope.
        if (!hooks.resolveProviderRuntimeHeaders) return { headersApplied: false, errorMessage: 'ZCode native account is unavailable' };
        signal.throwIfAborted();
        const response = await hooks.resolveProviderRuntimeHeaders(params, signal);
        // Stop/close can win while native account I/O is in flight. Never return its late token.
        signal.throwIfAborted();
        if (closed || stopping) throw new Error('ZCode authentication request cancelled');
        return response;
      }
      if (!id || !text(params.sessionId)) throw new Error('ZCode interaction session is missing');
      const requestId = text(params.requestId);
      if (!requestId) throw new Error('Invalid ZCode interaction');
      if (method === 'interaction/requestPermission') {
        const decision = await interact({
          kind: 'permission', requestId, toolUseId: text(params.toolCallId),
          toolName: text(params.toolName), input: asRecord(params.input), description: text(params.reason),
        }, signal);
        if (signal.aborted || stopping || closed || decision.kind !== 'permission' || decision.behavior !== 'allow') return {
          decision: 'deny', ...(decision.kind === 'permission' && decision.reason ? { reason: decision.reason } : {}),
        };
        // One approval never persists native project-wide rules. Cindy session approval is not project trust.
        return { decision: 'allow', ...(decision.updatedInput ? { modifiedInput: decision.updatedInput } : {}) };
      }
      if (method === 'interaction/requestUserInput') {
        if (params.toolName === 'ExitPlanMode') return { action: 'decline', reason: 'ZCode plan review is not available in Cindy' };
        const questions = Array.isArray(params.questions) ? params.questions.map(asRecord) : [];
        const decision = await interact({
          kind: 'ask_user_question', requestId, toolUseId: text(params.toolCallId),
          questions: questions.length ? questions.map((q) => ({
            question: text(q.question), header: text(q.header), multiSelect: q.multiSelect === true,
            options: Array.isArray(q.options) ? q.options.map((o) => ({
              label: text(asRecord(o).label), description: text(asRecord(o).description),
            })) : undefined,
          })) : [{ question: text(params.prompt) }],
        }, signal);
        if (signal.aborted || stopping || closed || decision.kind !== 'ask_user_question' || decision.dismissed) return { action: 'decline' };
        return { action: 'accept', content: { answers: decision.answers } };
      }
      throw new Error('Unsupported ZCode host request');
    });

    const receiveEvent = (event: Record<string, unknown>) => {
      if (closed || event.sessionId !== id) return;
      if (typeof event.seq === 'number') {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      if (!running) return;
      const payload = asRecord(event.payload);
      if (event.type === 'turn.started') { running = true; status(); return; }
      if (event.type === 'model.streaming') {
        const blockId = text(payload.partId) || text(payload.assistantMessageId) || 'zcode-reasoning';
        if (payload.kind === 'text_delta') {
          const delta = text(payload.delta);
          turnText += delta;
          emit('text', { text: delta, isFinal: false });
        } else if (payload.kind === 'reasoning_start' || payload.kind === 'reasoning_delta') {
          if (opts.displayReasoning === 'off') return;
          if (!thinking.has(blockId)) { thinking.add(blockId); emit('thinking', { stage: 'start', blockId, startedAt: Date.now() }); }
          if (payload.kind === 'reasoning_delta') emit('thinking', { stage: 'delta', blockId, text: text(payload.delta) });
        } else if (payload.kind === 'reasoning_end' && thinking.delete(blockId)) {
          emit('thinking', { stage: 'end', blockId });
        } else if (payload.kind === 'tool_call') {
          toolInputs.set(text(payload.toolCallId), { name: text(payload.toolName), input: payload.input });
        }
      } else if (event.type === 'tool.updated') {
        const toolUseId = text(payload.toolCallId);
        if (!toolUseId) return;
        if (payload.kind === 'scheduled') {
          const streamed = toolInputs.get(toolUseId);
          emit('tool_use', { toolUseId, toolName: text(payload.toolName) || streamed?.name,
            input: payload.input ?? streamed?.input ?? {} });
        } else if (payload.kind === 'result' || payload.kind === 'error') {
          const result = asRecord(payload.result);
          const content = result.content;
          const fullText = typeof content === 'string' ? content
            : Array.isArray(content) ? content.map((c) => text(asRecord(c).text)).filter(Boolean).join('\n')
            : payload.kind === 'error' ? 'ZCode tool failed' : JSON.stringify(content ?? result.output ?? '');
          const isError = payload.kind === 'error' || result.success === false || result.isError === true;
          emit('tool_result_full', { toolUseId, fullText, isError });
          emit('tool_result', { summary: fullText.slice(0, 500), toolUseIds: [toolUseId], isError });
          toolInputs.delete(toolUseId);
        }
      } else if (event.type === 'turn.completed') {
        if (!running) return;
        if (typeof payload.response === 'string' && payload.response !== turnText) emit('text', { text: payload.response, isFinal: true });
        const tokens = asRecord(payload.usage);
        const input = number(tokens.inputTokens), output = number(tokens.outputTokens);
        const cacheRead = number(tokens.cacheReadTokens), cacheCreate = number(tokens.cacheCreationTokens);
        const total = requestTotals.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
        // ZCode inputTokens includes cache reads/creation; Maker's request ledger keeps them separate.
        total.inputTokens += Math.max(0, input - cacheRead - cacheCreate);
        total.outputTokens += output;
        total.cacheReadTokens += cacheRead;
        total.cacheCreateTokens += cacheCreate;
        requestTotals.set(model, total);
        usage = { ...usage, tokenUsage: usage.tokenUsage + number(payload.tokenCount), outputTokens: output,
          requestUsage: { epoch, models: [...requestTotals].map(([model, totals]) => ({ model, ...totals })) } };
        const result = text(payload.resultType);
        const failed = result !== 'success' && result !== 'cancelled';
        if (failed) emit('error', { message: 'ZCode turn failed', reason: 'zcode_turn_failed', isTerminal: true });
        finish({ status: result === 'cancelled' ? 'cancelled' : failed ? 'error' : 'completed', ...usage });
        refreshIdleUsage();
      } else if (event.type === 'turn.failed') {
        emit('error', turnError(payload));
        finish({ status: 'error' });
        refreshIdleUsage();
      }
    };
    client.onNotification((method, params) => {
      if (method === 'session/event') receiveEvent(params);
      else if (method === 'interaction/providerRuntimeHeadersCancelled' && text(params.sessionId)) {
        client.cancelServerRequests({ method: 'interaction/requestProviderRuntimeHeaders',
          requestId: text(params.requestId), sessionId: text(params.sessionId) });
      }
      else if (method === 'state.updated' && params.sessionId === id) {
        projectSnapshot(asRecord(params.patch));
        status();
      }
    });
    client.onClose(() => {
      if (!closed && running) {
        emit('error', { message: 'ZCode process closed', reason: 'zcode_process_closed', isTerminal: true });
        finish({ status: 'error' });
      }
      closed = true;
      queue.end();
      // A broken pipe is not proof the credential-holding process exited. Keep ownership until close confirms it.
      queueMicrotask(() => {
        void client.close().then(() => this.clients.delete(client)).catch(() => {
          this.deps.logger.warn('ZCode process cleanup remains unconfirmed');
        });
      });
    });
    try {
      await hooks.prepareClient?.(client);
      assertCurrent();
      const workspace = { workspaceKey: opts.workingDir, workspacePath: opts.workingDir };
      // These tools require Cindy adapters that are not yet present; native read/write/exec remain intact.
      const toolDenylist = ['EnterPlanMode', 'ExitPlanMode', 'CreateWorkflow', 'AmendWorkflow'];
      const snapshot = asRecord(await client.request(opts.resumeSessionId ? 'session/resume' : 'session/create',
        opts.resumeSessionId
          ? { sessionId: opts.resumeSessionId, workspace, toolDenylist }
          : { workspace, model: selection, mode: nativeMode, titleGenerationEnabled: false, toolDenylist }));
      id = text(asRecord(snapshot.session).sessionId);
      if (!id) throw new Error('ZCode did not return a session identity');
      if (opts.resumeSessionId && id !== opts.resumeSessionId) throw new Error('ZCode restored a different session');
      await hooks.onSessionReady?.(id);
      assertCurrent();
      projectSnapshot(snapshot);
      if (opts.resumeSessionId) {
        await client.request('session/setMode', { sessionId: id, mode: nativeMode });
        await client.request('session/setModel', { sessionId: id, model: selection, persistAsWorkspaceLastUsed: false });
      }
      const subscription = asRecord(await client.request('session/subscribe', {
        sessionId: id, deliveryKind: 'desktop-continuous', includeSnapshot: false,
      }));
      assertCurrent();
      // The native history is already persisted in Cindy. Do not replay previous turns as a new reply.
      lastSeq = typeof subscription.eventSeq === 'number' ? subscription.eventSeq : -1;
      emit('session_id', id);
      status();
    } catch (error) {
      closed = true;
      queue.end();
      throw error;
    }

    const validateSendOptions = (options: SendOptions = {}) => {
      if (options.turnPermissionPolicy) throw new TurnPermissionPolicyUnsupportedError('zcode', permissionMode);
      if (options.toolsDisabled) nativeUnavailable('text-only restricted turn');
      if (options.planMode) nativeUnavailable('plan mode');
    };
    return {
      id, agentKind: this.kind, get model() { return model; },
      getUsageSnapshot: () => ({ ...usage }), events: () => queue,
      setInteractionResolver: (next) => { resolver = next; },
      isTurnRunning: () => running,
      validateSendOptions,
      async send(message, sendOptions = {}) {
        validateSendOptions(sendOptions);
        const content = inputText(message);
        if (closed) throw new Error('ZCode session is closed');
        if (running || stopping) throw new Error('ZCode session is busy');
        if (sendOptions.signal?.aborted) throw new Error('ZCode send cancelled');
        running = true;
        turnGeneration++;
        turnAttemptToken = sendOptions.turnAttemptToken;
        terminal = new Promise((resolve) => { resolveTerminal = resolve; });
        turnText = '';
        toolInputs.clear();
        status();
        try {
          // Native create/setModel is not the per-input intent. Preserve required
          // reasoning options explicitly when ZCode binds this turn's Active Model.
          const accepted = asRecord(await client.request('session/send', { sessionId: id, content,
            modelSelection: selection, inputId: sendOptions.messageUuid ?? randomUUID(),
          }, { signal: sendOptions.signal }));
          if (accepted.accepted !== true || accepted.sessionId !== id) throw new Error('ZCode did not accept this session message');
        } catch (error) {
          emit('error', { message: 'ZCode could not accept this message', reason: 'zcode_send_failed', isTerminal: true });
          finish({ status: 'error' });
          await client.close().catch(() => {});
          throw error;
        }
      },
      async steer() { nativeUnavailable('same-turn steering'); },
      async abort() {
        if (closed) return;
        stopping = true;
        client.cancelServerRequests();
        try {
          await client.request('session/stop', { sessionId: id }, { timeoutMs: 5_000 });
          if (running) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([terminal, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('ZCode stop was not confirmed')), 5_000);
              })]);
            } finally { clearTimeout(timer); }
          }
        } catch (error) {
          await client.close().catch(() => {});
          throw error;
        } finally { stopping = false; }
      },
      async close() {
        if (closed) { await client.close(); return; }
        finish({ status: 'cancelled' });
        closed = true;
        await client.close();
        queue.end();
      },
      async setPermissionMode(next) {
        const native = modeFor(next);
        if (closed || running) throw new Error('ZCode permission changes require an idle session');
        await client.request('session/setMode', { sessionId: id, mode: native });
        permissionMode = next;
      },
      setModel: async (next, overrides) => {
        if (overrides?.effort) return nativeUnavailable('reasoning effort override');
        if (overrides?.thinkingEnabled !== undefined) return nativeUnavailable('reasoning toggle');
        if (overrides?.contextWindowBudget != null) return nativeUnavailable('context window override');
        if (closed || running) throw new Error('ZCode model changes require an idle session');
        const nextSelection = this.options.resolveModelSelection(next);
        await client.request('session/setModel', { sessionId: id, model: nextSelection, persistAsWorkspaceLastUsed: false });
        selection = nextSelection;
        model = next;
      },
    };
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeAccountSessions();
  }

  /** Revoke current native sessions while allowing a later, explicitly connected account to start. */
  async closeAccountSessions(): Promise<void> {
    this.accountGeneration++;
    const clients = [...this.clients];
    const results = await Promise.allSettled(clients.map(async (client) => {
      await client.close();
      this.clients.delete(client);
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
