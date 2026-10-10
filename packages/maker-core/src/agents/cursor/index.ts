/** Cursor's own persistent agent, connected over the official ACP stdio protocol. */
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import {
  BaseAgent, PINNED_SKILL_INVOCATION, AgentNotAuthenticatedError, AgentStartupStoppedError,
  AgentStartupCleanupPendingError, TurnPermissionPolicyUnsupportedError,
  type AgentDeps, type AgentSessionHandle, type StartSessionOptions,
  type SendOptions, type PiExtraSpawnConfig,
} from '../base-agent.js';
import { LIBRARY_READ_ROOT } from '../shared/library-native-read.js';
import { cursorAnswers } from './questions.js';
import { AcpClient, AcpRpcError } from '../acp/client.js';
import { spawnAcpTransport, type AcpTransport } from '../acp/transport.js';
import type { Capabilities, ModelDescriptor } from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import type { Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { AgentEvent, InteractionDecision, InteractionRequest, InteractionResolver } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { resolveMemoryScopeKey } from '../../memory/scope-resolver.js';
import { CursorTranslator, cursorToolInput, cursorToolName } from './translator.js';
import { cursorReviewAction } from './permissions.js';
import type { ReviewableAction } from '../shared/auto-review.js';
import {
  appendAutoReviewUserIntent, normalizeAutoReviewUserIntent, createAutoReviewActionContext,
  resolveAutoReviewDecision, withAutoReviewContext, createAutoReviewUnavailableNotice,
  createAutoReviewConfirmUndeliveredNotice, annotatePermissionRequestForUnavailableReview,
  isSystemPermissionDenialReason, composeAutoReviewIntentWithApprovedPlan,
  composeAutoReviewIntentWithClarification, type AutoReviewUserIntent,
} from '../shared/auto-review-decision.js';
import { CURSOR_DEFAULT_MODEL, readCursorModels, readCursorModelControls, record, type AcpRecord, type CursorConfigOption } from './models.js';

export { CURSOR_DEFAULT_MODEL, cursorDefaultModel } from './models.js';
const yes = { supported: true } as const;
const no = { supported: false, reason: 'not-implemented' } as const;
const NATIVE_PERMISSION_DESCRIPTION = 'Cursor follows its native configured permission policy. Cindy shows only the approval requests Cursor sends; workspace edits may run without a prompt.';
const CONTROL_TIMEOUT = 30_000;
const CANCEL_TIMEOUT = 10_000;

export interface CursorAgentDeps extends AgentDeps {
  /** Test/embedding seam; production uses the exact host-resolved executable. */
  createCursorTransport?: (options: { binaryPath: string; cwd: string; env: NodeJS.ProcessEnv }) => AcpTransport;
}

export class CursorAgent extends BaseAgent {
  readonly kind = 'cursor' as const;
  readonly capabilities: Capabilities = {
    switchModel: yes, availableModels: [], hasFastMode: false,
    effort: no, effortLevels: [], reasoningDisplay: ['off', 'full'],
    permissionModes: [
      { id: 'ask', displayName: 'Default permissions', description: NATIVE_PERMISSION_DESCRIPTION },
      { id: 'default', displayName: 'Default permissions', description: NATIVE_PERMISSION_DESCRIPTION },
      { id: 'auto', displayName: 'Auto-review', description: `Cindy automatically reviews the approval requests Cursor sends. ${NATIVE_PERMISSION_DESCRIPTION}` },
      { id: 'bypassPermissions', displayName: 'Full access', description: `Cindy allows the approval requests Cursor sends without confirmation. ${NATIVE_PERMISSION_DESCRIPTION}` },
    ],
    setPermissionModeMidSession: yes,
    // ACP approvals cover native permission requests, not every tool invocation.
    // Do not claim enforcement of Cindy's per-tool read-only policy.
    turnPermissionPolicy: { supported: no, unsupportedPermissionModes: ['ask', 'default', 'auto', 'bypassPermissions', 'acceptEdits', 'plan'] },
    planMode: no,
    multimodal: { text: yes, image: no, file: yes },
    fork: no, rewind: no, abort: yes, sameTurnSteer: no,
    memory: { supported: no }, extraDirs: no, writableDirs: no,
  };
  private sessions = new Set<AgentSessionHandle>();
  private startups = new Map<AbortController, Promise<void>>();
  private failedStartupCleanups = new Map<string, {
    close: () => Promise<void>;
    pendingError: AgentStartupCleanupPendingError;
    confirmStopped: () => void;
    promise?: Promise<void>;
  }>();
  private discoveryDirectories = new Map<AgentSessionHandle, string>();
  private disposed = false;

  constructor(protected override deps: CursorAgentDeps) { super(deps); }

  async discoverModels(workingDir?: string): Promise<ModelDescriptor[]> {
    const temporary = workingDir ? undefined : await mkdtemp(path.join(tmpdir(), 'cindy-cursor-models-'));
    let handle: AgentSessionHandle | undefined;
    let cleanupConfirmed = true;
    try {
      handle = await this.startSession({ workingDir: workingDir ?? temporary!, model: CURSOR_DEFAULT_MODEL,
        permissionMode: 'ask', makerMemoryEnabled: false, vendorOptions: { cursorDiscoveryOnly: true } });
      if (temporary) this.discoveryDirectories.set(handle, temporary);
      return this.capabilities.availableModels.map(model => ({ ...model }));
    } catch (error) {
      if (error instanceof AgentStartupCleanupPendingError) {
        cleanupConfirmed = false;
        // Preserve the probe cwd while a native process may still own it.
        void error.whenStopped.then(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); }).catch(() => {});
      }
      throw error;
    } finally {
      await handle?.close();
      if (!handle && temporary && cleanupConfirmed) await rm(temporary, { recursive: true, force: true });
    }
  }

  private async retryFailedStartupCleanup(key: string): Promise<void> {
    const entry = this.failedStartupCleanups.get(key);
    if (!entry) return;
    const cleanup = entry.promise ?? entry.close();
    entry.promise = cleanup;
    try { await cleanup; }
    catch {
      if (entry.promise === cleanup) entry.promise = undefined;
      throw entry.pendingError;
    }
    if (this.failedStartupCleanups.get(key) === entry) {
      this.failedStartupCleanups.delete(key);
      entry.confirmStopped();
    }
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    for (const startup of this.startups.keys()) startup.abort();
    // Startup can enter quarantine after abort; wait before taking the cleanup snapshot.
    await Promise.allSettled([...this.startups.values()]);
    const results = await Promise.allSettled([
      ...[...this.failedStartupCleanups.keys()].map(key => this.retryFailedStartupCleanup(key)),
      ...[...this.sessions].map(session => session.close()),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Cursor process cleanup is not confirmed');
  }

  override async refreshLocalModels(): Promise<boolean> { await this.discoverModels(); return true; }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const startup = new AbortController();
    let finish!: () => void;
    this.startups.set(startup, new Promise<void>(resolve => { finish = resolve; }));
    const cleanupKey = opts.sessionId ?? opts.resumeSessionId ?? opts.workingDir;
    try {
      if (this.disposed) throw new AgentStartupStoppedError(new Error('Cursor agent has been disposed'));
      // Keep the previous native writer outside the new startup's stopped-error boundary.
      await this.retryFailedStartupCleanup(cleanupKey);
      return await this.startSessionNow(opts, startup, cleanupKey);
    } finally {
      this.startups.delete(startup);
      finish();
    }
  }

  private async startSessionNow(opts: StartSessionOptions, startup: AbortController, cleanupKey: string): Promise<AgentSessionHandle> {
    const assertCurrent = () => { if (this.disposed || startup.signal.aborted) throw new Error('Cursor agent has been disposed'); };
    let client: AcpClient | undefined;
    let bridge: PiExtraSpawnConfig | null = null;
    const queue = createAsyncQueue<AgentEvent>();
    let sessionId = '';
    let model = opts.model || CURSOR_DEFAULT_MODEL;
    let loading = true;
    let closed = false;
    let active: Promise<unknown> | undefined;
    let running = false;
    let cancelled = false;
    let resolver: InteractionResolver | undefined;
    let mode: PermissionMode = opts.permissionMode ?? 'ask';
    let planMode = false;
    let sessionState: AcpRecord = {};
    let parameterizedModels: unknown;
    let turnOptions: SendOptions | undefined;
    let promptCapabilities: AcpRecord = {};
    let firstPrompt = !opts.resumeSessionId;
    let context = '';
    let closePromise: Promise<void> | undefined;
    let fenced = false;
    let preparingController: AbortController | undefined;
    let defaultModel: string | undefined;
    let unregisterProcess: (() => void) | undefined;
    let configuring = false;
    let permissionGeneration = 0;
    let userIntent: AutoReviewUserIntent = '';
    const actionContext = createAutoReviewActionContext();
    const pending = new Map<string, { cancel(): void; modeChanged?(): void }>();
    const emit = (event: AgentEvent) => {
      if (!closed) queue.push({ ...event, source: 'cursor', turnAttemptToken: turnOptions?.turnAttemptToken });
    };
    const translator = new CursorTranslator(emit);
    const emitReviewNotice = (message: string) => emit({ type: 'error', data: { message, isTerminal: false } });
    const reviewUnavailable = createAutoReviewUnavailableNotice(emitReviewNotice);
    const confirmUndelivered = createAutoReviewConfirmUndeliveredNotice(emitReviewNotice);
    const reviewAutoAction = async (action: ReviewableAction) => {
      if (closed || fenced || cancelled || !running) {
        return { verdict: 'block' as const, reason: 'Cursor has no active authorized turn.' };
      }
      const intent = userIntent;
      const generation = permissionGeneration;
      const request = { sessionId: opts.sessionId, agentKind: 'cursor' as const, providerId: opts.providerId,
        model, userIntent: intent, precedingBlockedActions: actionContext.precedingBlockedActions,
        action, workspaceRoots: [opts.workingDir], writableRoots: [opts.workingDir], platform: process.platform };
      const decision = await withAutoReviewContext(request, this.deps.reviewAutoPermissionAction,
        prepared => resolveAutoReviewDecision(prepared, this.deps.reviewAutoPermissionAction));
      if (closed || fenced || cancelled || !running || intent !== userIntent
        || generation !== permissionGeneration || model !== request.model) {
        return { verdict: 'block' as const, reason: 'Cursor authorization changed; retry against the current request.' };
      }
      actionContext.record(action, decision);
      return decision;
    };
    const clearInteractions = () => {
      for (const interaction of pending.values()) interaction.cancel();
      pending.clear();
    };
    const interact = async (request: InteractionRequest, action?: ReviewableAction): Promise<InteractionDecision | undefined> => {
      if (closed || fenced || cancelled) return undefined;
      return new Promise(resolve => {
        let settled = false;
        let offered = false;
        let attempt = 0;
        const finish = (decision?: InteractionDecision) => {
          if (settled) return;
          settled = true;
          attempt++;
          pending.delete(request.requestId);
          if (offered) emit({ type: 'interaction_dismissed', data: { requestId: request.requestId, reason: decision ? 'resolved' : 'cancelled' } });
          resolve(decision);
        };
        const decide = async () => {
          const token = ++attempt;
          if (offered) {
            offered = false;
            emit({ type: 'interaction_dismissed', data: { requestId: request.requestId, reason: 'permission_mode_changed' } });
          }
          if (settled || closed || fenced || cancelled) { finish(); return; }
          let displayRequest = request;
          let unavailable = false;
          if (request.kind === 'permission' && action) {
            if (mode === 'bypassPermissions') { finish({ kind: 'permission', behavior: 'allow' }); return; }
            if (mode === 'auto') {
              const decision = await reviewAutoAction(action);
              if (settled || token !== attempt) return;
              if (closed || fenced || cancelled) { finish(); return; }
              if (decision.verdict !== 'ask') {
                finish({ kind: 'permission', behavior: decision.verdict === 'allow' ? 'allow' : 'deny', reason: decision.reason });
                return;
              }
              unavailable = decision.unavailable === true;
              if (unavailable) { reviewUnavailable.notify(); displayRequest = annotatePermissionRequestForUnavailableReview(request); }
            }
          }
          if (!resolver) { if (unavailable) confirmUndelivered.notify(); finish(); return; }
          offered = true;
          emit({ type: 'interaction_request', data: displayRequest });
          Promise.resolve().then(() => resolver!(displayRequest)).then(decision => {
            if (settled || token !== attempt) return;
            if (unavailable && decision.kind === 'permission' && decision.behavior === 'deny'
              && isSystemPermissionDenialReason(decision.reason)) confirmUndelivered.notify();
            finish(decision);
          }, () => { if (!settled && token === attempt) { if (unavailable) confirmUndelivered.notify(); finish(); } });
        };
        pending.set(request.requestId, { cancel: () => finish(),
          ...(request.kind === 'permission' ? { modeChanged: () => { void decide(); } } : {}) });
        void decide();
      });
    };
    const onRequest = async (method: string, raw: unknown): Promise<unknown> => {
      if (!['session/request_permission', 'cursor/create_plan', 'cursor/ask_question'].includes(method)) {
        throw new AcpRpcError(-32601, `Unsupported ACP method: ${method}`);
      }
      const params = record(raw);
      const cancelledResult = { outcome: { outcome: 'cancelled' } };
      if (closed || loading || cancelled || !running) return cancelledResult;
      if (typeof params.sessionId === 'string' && params.sessionId !== sessionId) return cancelledResult;
      const requestId = `cursor:${randomUUID()}`;
      if (method === 'session/request_permission') {
        const patch = record(params.toolCall);
        const tool = { ...translator.tool(patch.toolCallId), ...patch };
        const decision = await interact({ kind: 'permission', requestId,
          toolUseId: typeof tool.toolCallId === 'string' ? tool.toolCallId : undefined,
          toolName: cursorToolName(tool), input: cursorToolInput(tool),
          title: typeof tool.title === 'string' ? tool.title : undefined,
        }, cursorReviewAction(tool, opts.workingDir));
        if (!decision || cancelled || closed) return cancelledResult;
        const allow = decision.kind === 'permission' && decision.behavior === 'allow';
        const options = Array.isArray(params.options) ? params.options.map(record) : [];
        // ACP allow_always can write machine-wide grants. Cindy approval is only
        // for this request; never escalate it into native persistent permission.
        const option = options.find(option => option.kind === (allow ? 'allow_once' : 'reject_once'));
        return typeof option?.optionId === 'string'
          ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelledResult;
      }
      if (method === 'cursor/create_plan') {
        if (typeof params.plan !== 'string') return { outcome: { outcome: 'rejected', reason: 'Invalid plan' } };
        const decision = await interact({ kind: 'plan_review', requestId, plan: params.plan,
          toolUseId: typeof params.toolCallId === 'string' ? params.toolCallId : undefined });
        if (!decision || cancelled || closed) return cancelledResult;
        // An edited plan cannot be silently represented as acceptance of the
        // original: Cursor's extension has no edited-plan response field.
        const accepted = decision.kind === 'plan_review' && decision.behavior === 'allow' &&
          (!decision.editedPlan || decision.editedPlan === params.plan);
        if (accepted) userIntent = composeAutoReviewIntentWithApprovedPlan(userIntent, params.plan);
        return accepted ? { outcome: { outcome: 'accepted' } }
          : { outcome: { outcome: 'rejected', reason: decision.kind === 'plan_review'
            ? decision.editedPlan ?? decision.reason ?? 'Plan not approved' : 'Plan not approved' } };
      }
      if (method === 'cursor/ask_question') {
        const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
        if (!questions.length || questions.some(question => typeof question.id !== 'string' || typeof question.prompt !== 'string')) {
          return { outcome: { outcome: 'skipped', reason: 'Invalid questions' } };
        }
        const decision = await interact({ kind: 'ask_user_question', requestId,
          questions: questions.map(question => ({ question: question.prompt as string,
            header: question.id as string, multiSelect: question.allowMultiple === true,
            options: (Array.isArray(question.options) ? question.options : []).map(record)
              .filter(option => typeof option.label === 'string').map(option => ({ label: option.label as string })),
          })) });
        if (!decision || cancelled || closed || (decision.kind === 'ask_user_question' && decision.dismissed)) return cancelledResult;
        if (decision.kind !== 'ask_user_question') return { outcome: { outcome: 'skipped' } };
        const answers = cursorAnswers(questions, decision.answers);
        if (record(record(answers).outcome).outcome === 'answered') {
          userIntent = composeAutoReviewIntentWithClarification(userIntent, questions.map(question => ({
            question: String(question.prompt), answer: decision.answers[String(question.id)] ?? decision.answers[String(question.prompt)],
          })));
        }
        return answers;
      }
      // Unsupported blocking extension calls receive an explicit response.
      throw new AcpRpcError(-32601, `Unsupported ACP method: ${method}`);
    };
    const updateCatalog = (raw: unknown) => {
      sessionState = { ...sessionState, ...record(raw) };
      const catalog = readCursorModels(sessionState, parameterizedModels);
      const modes = record(sessionState.modes);
      if (typeof modes.currentModeId === 'string') planMode = modes.currentModeId === 'plan';
      this.capabilities.planMode = Array.isArray(modes.availableModes) && modes.availableModes.some(mode => record(mode).id === 'plan') ? yes : no;
      this.capabilities.switchModel = catalog.configId ? yes : no;
      // The legacy sentinel remains an accepted input, never a second Auto row.
      this.capabilities.availableModels = catalog.models;
      this.capabilities.hasFastMode = catalog.models.some(item => item.supportsFastMode === true);
      const efforts = [...new Set(catalog.models.flatMap(item => item.efforts))];
      this.capabilities.effort = efforts.length ? yes : no;
      this.capabilities.effortLevels = efforts.map(id => ({ id, displayName: id }));
    };
    const control = async (method: string, params: unknown, signal?: AbortSignal) => {
      if (fenced || closed || configuring) throw new Error('Cursor session is closed or configuring');
      configuring = true;
      try { return await client!.request(method, params, { timeoutMs: CONTROL_TIMEOUT, signal: signal ?? (this.startups.has(startup) ? startup.signal : undefined) }); }
      catch (error) {
        if (!(error instanceof AcpRpcError)) { fenced = true; await client!.close().catch(() => {}); }
        throw error;
      } finally { configuring = false; }
    };
    const setConfigOption = async (option: CursorConfigOption, value: string | boolean) => {
      if (running) throw new Error('Cannot change Cursor configuration during an active turn');
      if (option.currentValue === value) return;
      const response = await control('session/set_config_option', { sessionId, configId: option.id, value,
        ...(option.type === 'boolean' ? { type: 'boolean' } : {}) });
      updateCatalog(response);
      // Legacy agents may acknowledge a mutation without returning configOptions.
      if (!Array.isArray(record(response).configOptions)) {
        const configs = Array.isArray(sessionState.configOptions) ? sessionState.configOptions : [];
        updateCatalog({ configOptions: configs.map(item => record(item).id === option.id ? { ...record(item), currentValue: value } : item) });
      } else {
        const actual = (sessionState.configOptions as unknown[]).map(record).find(item => item.id === option.id);
        if (actual?.currentValue !== value) throw new Error('Cursor did not apply the requested configuration');
      }
    };
    const setEffort = async (effort: Effort) => {
      if (fenced || closed || configuring) throw new Error('Cursor session is closed or configuring');
      const controls = readCursorModelControls(sessionState.configOptions);
      if (!controls.effort || !controls.efforts.includes(effort)) throw new NotSupportedError('effort', { supported: false, reason: 'sdk-missing' });
      await setConfigOption(controls.effort, effort);
    };
    const setFastMode = async (enabled: boolean) => {
      if (fenced || closed || configuring) throw new Error('Cursor session is closed or configuring');
      const { fast } = readCursorModelControls(sessionState.configOptions);
      if (!fast) {
        if (!enabled) return;
        throw new NotSupportedError('fastMode', { supported: false, reason: 'sdk-missing' });
      }
      await setConfigOption(fast, fast.type === 'boolean' ? enabled : String(enabled));
    };
    const setModel = async (next: string, options?: { effort?: Effort }) => {
      if (fenced || closed || configuring) throw new Error('Cursor session is closed or configuring');
      if (running) throw new Error('Cannot change Cursor model during an active turn');
      const catalog = readCursorModels(sessionState, parameterizedModels);
      const target = next === CURSOR_DEFAULT_MODEL ? defaultModel : next;
      if (options?.effort && !catalog.models.find(item => item.id === target)?.efforts.includes(options.effort)) {
        throw new NotSupportedError('effort', { supported: false, reason: 'sdk-missing' });
      }
      if (target && target === catalog.currentModel) { model = target; if (options?.effort) await setEffort(options.effort); return; }
      if (!target || !catalog.configId || !catalog.models.some(item => item.id === target)) {
        throw new NotSupportedError('setModel', { supported: false, reason: 'sdk-missing' });
      }
      await setConfigOption({ id: catalog.configId, type: 'select', currentValue: catalog.currentModel, options: [] }, target);
      model = target;
      if (options?.effort) await setEffort(options.effort);
    };
    const setPlanMode = async (enabled: boolean, preparing = false) => {
      if (fenced || closed || configuring) throw new Error('Cursor session is closed or configuring');
      if (running && !preparing) throw new Error('Cannot change Cursor mode during an active turn');
      if (enabled === planMode) return;
      const modes = record(sessionState.modes);
      const available = Array.isArray(modes.availableModes) ? modes.availableModes.map(record) : [];
      const target = enabled ? 'plan' : 'agent';
      if (!available.some(item => item.id === target)) throw new NotSupportedError('setPlanMode', { supported: false, reason: 'sdk-missing' });
      await control('session/set_mode', { sessionId, modeId: target }, preparing ? preparingController?.signal : undefined);
      planMode = enabled;
      emit({ type: 'plan_mode_changed', data: { enabled } });
    };
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      fenced = true;
      closePromise = (async () => {
        cancelled = true;
        preparingController?.abort();
        clearInteractions();
        if (running && sessionId) await client?.notify('session/cancel', { sessionId }).catch(() => {});
        await client?.close(); // Exit proof comes before releasing host MCP/working-dir ownership.
        await active?.catch(() => {});
        if (!closed) {
          unregisterProcess?.();
          bridge?.disposeSessionCtx?.();
          queue.end();
        }
        closed = true;
        running = false;
        active = undefined;
        if (handle) {
          const directory = this.discoveryDirectories.get(handle);
          if (directory) await rm(directory, { recursive: true, force: true });
          this.discoveryDirectories.delete(handle);
          this.sessions.delete(handle);
        }
      })().catch(error => { closePromise = undefined; throw error; });
      return closePromise;
    };
    let handle: AgentSessionHandle | undefined;
    try {
      assertCurrent();
      if (opts.extraDirs?.length || opts.writableDirs?.length || opts[LIBRARY_READ_ROOT]) {
        throw new Error('Cursor ACP cannot enforce additional directory grants or a read-only Library root');
      }
      if (opts.reviewMode || opts.botRuntimeProfile) {
        throw new Error('Cursor ACP does not support restricted Reviewer or Bot runtime profiles');
      }
      if (opts.remoteHostId || opts.deviceHosted) throw new Error('Cursor ACP currently runs only on the task host computer');
      if (!path.isAbsolute(opts.workingDir)) throw new Error('Cursor ACP requires an absolute working directory');
      if (opts.thinkingEnabled !== undefined) throw new Error('Cursor ACP does not advertise a generic thinking switch');
      if (!this.capabilities.permissionModes.some(option => option.id === mode)) throw new NotSupportedError('permissionMode', no);
      const auth = await this.deps.auth.getState();
      if (!auth.authenticated) throw new AgentNotAuthenticatedError('cursor', 'Cursor Agent is not authenticated. Run agent login on the task host computer.');
      const env = { ...process.env, ...await this.deps.auth.getAuthEnv() };
      const discoveryOnly = opts.vendorOptions?.cursorDiscoveryOnly === true;
      const memoryEnabled = !discoveryOnly && (opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled) === true;
      const scope = await resolveMemoryScopeKey(opts.makerMemoryScopeKey ?? opts.workingDir);
      if (!discoveryOnly && this.deps.preparePiExtraSpawnConfig) {
        bridge = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
          agentKind: 'cursor', sessionId: opts.sessionId, sessionInstanceId: opts.sessionInstanceId,
          workingDir: opts.workingDir, memoryScopeKey: scope, memoryEnabled,
          vendorOptions: opts.vendorOptions, mcpCallerKind: 'unknown', mcpCallerAttested: false,
        });
      }
      if (firstPrompt && !discoveryOnly) {
        const memory = memoryEnabled ? opts.makerMemoryIndexSnapshot
          ?? (this.deps.makerMemory ? await (await this.deps.makerMemory.getStore(scope)).getIndex() : '') : '';
        // ACP has no system-message API. Pass caller-owned context once with the
        // first user prompt, keeping Cursor's native instructions untouched.
        context = [opts.botProfilePrompt, opts.botProfileContextPrompt, memory, opts.userPrompt].filter(Boolean).join('\n\n');
      }
      assertCurrent();
      const transport = (this.deps.createCursorTransport ?? spawnAcpTransport)({ binaryPath: this.deps.binaryPath, cwd: opts.workingDir, env });
      client = new AcpClient(transport, {
        requestTimeoutMs: CONTROL_TIMEOUT, onRequest,
        onNotification: (method, raw) => {
          const params = record(raw);
          if (method === 'session/update') {
            if (params.sessionId !== sessionId) return;
            const update = record(params.update);
            if (update.sessionUpdate === 'config_option_update') updateCatalog({ configOptions: update.configOptions });
            else if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
              updateCatalog({ modes: { ...record(sessionState.modes), currentModeId: update.currentModeId } });
              if (!loading) emit({ type: 'plan_mode_changed', data: { enabled: planMode } });
            }
            if (running) translator.update(update);
          } else if (!loading && running && method === 'cursor/update_todos') {
            if (typeof params.sessionId === 'string' && params.sessionId !== sessionId) return;
            translator.updateTodos(params.todos, params.merge === true);
          } else if (!loading && running && method === 'cursor/task') {
            // This extension is a completion notice, not a controllable durable
            // child session. Do not invent start/resume/stop handles.
            if (typeof params.toolCallId === 'string') emit({ type: 'agent_task_update', data: {
              provider: 'cursor', taskId: params.toolCallId, parentToolUseId: params.toolCallId,
              status: 'completed', title: params.description, model: params.model,
            } });
          }
        },
        onClose: () => {
          clearInteractions();
          if (!loading && !running && !fenced && !closed) {
            fenced = true;
            emit({ type: 'error', data: { message: 'Cursor Agent disconnected. Reopen this task to resume.', isTerminal: true, reason: 'cursor_acp_disconnected' } });
          }
        },
      });
      const pid = client.getPid();
      const registration = pid ? this.deps.registerLocalAgentProcess?.({ pid, kind: 'cursor', role: 'task-host' }) : undefined;
      if (typeof registration === 'function') unregisterProcess = registration;
      const init = record(await client.request('initialize', {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          _meta: { parameterizedModelPicker: true }, session: { configOptions: { boolean: {} } } },
        clientInfo: { name: 'cindy', version: '1.0.0' },
      }, { signal: startup.signal }));
      if (init.protocolVersion !== 1) throw new Error('Cursor ACP protocol version is unsupported');
      const capabilities = record(init.agentCapabilities);
      promptCapabilities = record(capabilities.promptCapabilities);
      this.capabilities.multimodal.image = promptCapabilities.image === true ? yes : no;
      const methods = Array.isArray(init.authMethods) ? init.authMethods.map(record) : [];
      if (methods.some(method => method.id === 'cursor_login')) await client.request('authenticate', { methodId: 'cursor_login' }, { signal: startup.signal });
      const mcpServers: unknown[] = [];
      if (bridge?.mcpBridge?.servers.length) {
        if (record(capabilities.mcpCapabilities).http !== true) throw new Error('This Cursor ACP version does not support Cindy HTTP MCP tools');
        for (const server of bridge.mcpBridge.servers) {
          const headers = server.remote
            ? Object.entries(server.remote.headerEnvVars).map(([name, envVar]) => ({ name, value: bridge!.mcpEnv?.[envVar] ?? env[envVar] }))
            : [{ name: 'Authorization', value: `Bearer ${bridge.mcpBridge.token}` }];
          if (headers.some(header => typeof header.value !== 'string')) throw new Error('Cursor MCP authentication environment is unavailable');
          mcpServers.push({ type: 'http', name: server.name, url: server.url, headers });
        }
      }
      // Cursor's native extension supplies each offered model's parameter choices
      // without selecting it or sending a prompt. Older CLIs keep their ACP catalog.
      try { parameterizedModels = record(await client.request('cursor/list_available_models', {}, { signal: startup.signal })).models; }
      catch (error) { if (!(error instanceof AcpRpcError) || error.code !== -32601) throw error; }
      updateCatalog({});
      if (opts.resumeSessionId) {
        if (capabilities.loadSession !== true) throw new Error('This Cursor ACP version cannot resume saved tasks');
        validateSessionId(opts.resumeSessionId);
        sessionId = opts.resumeSessionId;
        updateCatalog(await client.request('session/load', { sessionId, cwd: opts.workingDir, mcpServers }, { signal: startup.signal }));
      } else {
        const result = record(await client.request('session/new', { cwd: opts.workingDir, mcpServers }, { signal: startup.signal }));
        sessionId = validateSessionId(result.sessionId);
        updateCatalog(result);
      }
      if (discoveryOnly) this.deps.logger.debug('Cursor native catalog discovered', {
        sessionModelCount: this.capabilities.availableModels.length,
        parameterizedModelCount: Array.isArray(parameterizedModels) ? parameterizedModels.length : 0,
      });
      // session/load replays native history while loading=true. Cindy already
      // owns the transcript, so replay is never emitted as a new user turn.
      loading = false;
      defaultModel = readCursorModels(sessionState).currentModel;
      const requestedModel = model;
      model = defaultModel ?? CURSOR_DEFAULT_MODEL;
      if (requestedModel !== CURSOR_DEFAULT_MODEL) await setModel(requestedModel);
      if (opts.effort) await setEffort(opts.effort);
      if (opts.fastMode !== undefined) await setFastMode(opts.fastMode);
      if (opts.planMode !== undefined) await setPlanMode(opts.planMode);
      emit({ type: 'session_id', data: sessionId });
      if (planMode) emit({ type: 'plan_mode_changed', data: { enabled: true } });
      const validateSend = (options: SendOptions = {}) => {
        if (closed || fenced) throw new Error('Cursor session is closed');
        if (running || configuring) throw new Error('Cursor already has an active turn or configuration');
        if (options.signal?.aborted) throw new Error('Cursor send cancelled before dispatch');
        if (options[PINNED_SKILL_INVOCATION]) throw new Error('Cursor ACP cannot enforce a pinned Skill identity');
        if (options.toolsDisabled) throw new Error('Cursor ACP cannot guarantee a tools-disabled turn');
        if (options.turnPermissionPolicy) throw new TurnPermissionPolicyUnsupportedError('cursor', mode);
      };
      handle = {
        id: sessionId, agentKind: 'cursor', get model() { return model; },
        events: () => queue,
        getUsageSnapshot: () => ({ ...translator.usage }),
        setInteractionResolver: next => { resolver = next; },
        reviewAutoPermissionAction: reviewAutoAction,
        validateSendOptions: validateSend,
        isTurnRunning: () => running,
        async send(message: UserMessage, options: SendOptions = {}) {
          validateSend(options);
          // Reserve synchronously before reading attachments/mode changes, so a
          // concurrent caller cannot dispatch another prompt during preparation.
          running = true;
          cancelled = false;
          turnOptions = options;
          translator.beginTurn();
          preparingController = new AbortController();
          const signalAbort = () => { cancelled = true; preparingController?.abort(); };
          options.signal?.addEventListener('abort', signalAbort, { once: true });
          try {
            if (options.planMode !== undefined) await setPlanMode(options.planMode, true);
            const blocks = await promptBlocks(message, promptCapabilities);
            if (closed || cancelled || options.signal?.aborted) throw new Error('Cursor send cancelled before dispatch');
            const nextIntent = appendAutoReviewUserIntent(firstPrompt ? undefined : userIntent, message.content, options);
            actionContext.advance(typeof nextIntent !== 'string');
            userIntent = normalizeAutoReviewUserIntent(nextIntent);
            reviewUnavailable.reset(); confirmUndelivered.reset();
            if (firstPrompt && context) blocks.unshift({ type: 'text', text: context });
            emit({ type: 'status', data: { ...translator.usage, isRunning: true, status: 'Working' } });
            // ACP prompt returns only at the END of the turn. Dispatch promptly;
            // never await completion from Session.send (which would block UI).
            active = client!.request('session/prompt', { sessionId, prompt: blocks }, { timeoutMs: 24 * 60 * 60 * 1000 });
            firstPrompt = false;
            preparingController = undefined;
            options.signal?.removeEventListener('abort', signalAbort);
            const finish = () => {
              running = false;
              active = undefined;
              clearInteractions();
            };
            active.then(async result => {
              const response = record(result);
              if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(String(response.stopReason))) {
                fenced = true;
                try { await client!.close(); } catch {
                  emit({ type: 'error', data: { message: 'Cursor process stop is not confirmed. Retry closing this task.', isTerminal: false, reason: 'cursor_cleanup_pending' } });
                  return;
                }
                finish();
                emit({ type: 'error', data: { message: 'Cursor returned an invalid prompt result', isTerminal: true, reason: 'cursor_invalid_prompt_result' } });
                turnOptions = undefined;
                return;
              }
              finish();
              if (!closed) emit({ type: 'done', data: { ...translator.usage,
                stopReason: response.stopReason, cancelled: response.stopReason === 'cancelled' } });
              turnOptions = undefined;
            }, async error => {
              // A transport failure/timeout is not proof the native turn stopped.
              // Fence and confirm exit before publishing terminal idle state.
              if (!(error instanceof AcpRpcError)) {
                fenced = true;
                cancelled = true;
                clearInteractions();
                try { await client!.close(); } catch {
                  emit({ type: 'error', data: { message: 'Cursor process stop is not confirmed. Retry closing this task.', isTerminal: false, reason: 'cursor_cleanup_pending' } });
                  return;
                }
              }
              finish();
              if (!closed) emit({ type: 'error', data: { message: safeError(error), isTerminal: true,
                reason: cancelled ? 'cursor_cancelled' : 'cursor_acp_error' } });
              turnOptions = undefined;
            });
          } catch (error) {
            preparingController = undefined;
            options.signal?.removeEventListener('abort', signalAbort);
            running = false;
            turnOptions = undefined;
            throw error;
          }
        },
        async steer() { throw new NotSupportedError('sameTurnSteer', no); },
        async abort() {
          if (fenced) { await close(); return; }
          if (!running) return;
          cancelled = true;
          preparingController?.abort();
          clearInteractions();
          await client!.notify('session/cancel', { sessionId }).catch(() => {});
          const current = active;
          if (current) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([current.catch(() => {}), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Cursor did not confirm cancellation')), CANCEL_TIMEOUT);
              })]);
            } catch {
              // A missing acknowledgement never means idle. Fence this process,
              // rather than allowing the next turn to run concurrently.
              await close();
            } finally { if (timer) clearTimeout(timer); }
          }
        },
        close,
        setModel,
        setEffort, setFastMode,
        getFastMode: () => { const value = readCursorModelControls(sessionState.configOptions).fast?.currentValue; return value === true || value === 'true'; },
        async setPermissionMode(next) {
          if (closed || fenced) throw new Error('Cursor session is closed');
          if (!['ask', 'default', 'auto', 'bypassPermissions'].includes(next)) throw new NotSupportedError('permissionMode', no);
          if (mode === next) return;
          mode = next;
          permissionGeneration++;
          reviewUnavailable.reset(); confirmUndelivered.reset();
          // Re-evaluate only tool approvals. Plans and questions still need an explicit answer.
          for (const interaction of pending.values()) interaction.modeChanged?.();
        },
        setPlanMode, getPlanMode: () => planMode, getExecutionPlanMode: () => planMode,
      };
      assertCurrent();
      this.sessions.add(handle);
      return handle;
    } catch (error) {
      try {
        await close();
      } catch {
        let confirmStopped!: () => void;
        const whenStopped = new Promise<void>(resolve => { confirmStopped = resolve; });
        const pendingError = new AgentStartupCleanupPendingError('Cursor startup cleanup has not confirmed process exit', { cause: error, whenStopped });
        this.failedStartupCleanups.set(cleanupKey, { close, pendingError, confirmStopped });
        throw pendingError;
      }
      if (error instanceof AgentNotAuthenticatedError) throw error;
      if (error instanceof AcpRpcError && error.code === -32000) {
        throw new AgentNotAuthenticatedError('cursor', 'Cursor Agent authentication expired. Run agent login on the task host computer.');
      }
      throw new AgentStartupStoppedError(error instanceof AcpRpcError ? new AcpRpcError(error.code, safeError(error)) : error);
    }
  }
}

function validateSessionId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim() || id.length > 4096 || [...id].some(char => char.charCodeAt(0) < 32)) {
    throw new Error('Cursor ACP returned an invalid session identity');
  }
  return id;
}
function safeError(error: unknown): string {
  // Native errors can contain request payloads/tokens. Keep transport diagnosis
  // useful without reflecting arbitrary upstream error.data into UI/logs.
  return error instanceof Error ? redactSensitiveText(error.message).slice(0, 500) : 'Cursor ACP request failed';
}
async function promptBlocks(message: UserMessage, capabilities: AcpRecord): Promise<AcpRecord[]> {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  const blocks: AcpRecord[] = [];
  for (const item of message.content) {
    if (item.type === 'text') blocks.push({ type: 'text', text: item.text });
    else if (item.type === 'image') {
      if (capabilities.image !== true) throw new Error('This Cursor ACP version does not support image input');
      const file = await open(item.path, 'r');
      let bytes: Buffer;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('Cursor image input must be a regular file of at most 10 MiB');
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!result.bytesRead) throw new Error('Cursor image input changed while reading');
          offset += result.bytesRead;
        }
        if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw new Error('Cursor image input changed while reading');
      } finally { await file.close(); }
      blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: item.mimeType ?? 'image/png' });
    } else {
      const name = item.type === 'mention' ? item.name : path.basename(item.path);
      if (capabilities.embeddedContext === true) blocks.push({ type: 'resource_link', name, uri: pathToFileURL(item.path).href });
      else blocks.push({ type: 'text', text: `${name}: ${item.path}` });
    }
  }
  return blocks;
}
