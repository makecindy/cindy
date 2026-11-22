import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { isAntigravitySubscriptionModel } from './model-policy.js';
export { isAntigravitySubscriptionModel } from './model-policy.js';
import { BaseAgent, AgentStartupStoppedError, TASK_SYSTEM_PROMPT, type AgentDeps, type AgentSessionHandle, type StartSessionOptions, type SendOptions } from '../base-agent.js';
import type { AuthState, Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { Capabilities } from '../../types/capabilities.js';
import type { AgentEvent, AntigravityCommandExit, AntigravityToolActivity, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import { ANTIGRAVITY_NATIVE_TOOL_NAME } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { AcpSubscriptionSession, type AcpDiscoveredModel } from './subscription-session.js';
import { record, type AcpRecord, type AcpResponse, type AcpTransport } from './client.js';
import { normalizeToolCallFields, type AcpToolCallStatus } from './protocol.js';
import { acpToolDisplayName } from './translator.js';
import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKGROUND_IDLE_MS = 2_000;
const CANCEL_GRACE_MS = 15_000;
const RECENT_TOOL_RESULTS_LIMIT = 512;
const COMMAND_WAKE_LIMIT = 3;
const COMMAND_WAKE_WINDOW_MS = 30 * 60_000;
// Give the CLI's background stream and Cindy's prior done time to settle.
const COMMAND_WAKE_GRACE_MS = 2_000;
const COMMAND_WAKE_TEXT = '[Cindy background command completed] A background command from this task has finished. Check its result and continue any remaining work from the current request.';
const COMMAND_WAKE_NATIVE_STREAM_BUSY = Symbol('command-wake-native-stream-busy');

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
  watchCommandExits?(sessionId: string, onExit: (exit: AntigravityCommandExit) => void): () => void;
  /** Synchronous host admission check, called again immediately before dispatch. */
  canWakeAfterCommandExit?(): boolean;
  dispose?(): void;
}

interface OpenAntigravityTool {
  background: boolean;
  status?: AcpToolCallStatus;
  outputHash?: string;
  nativeCommand?: true;
  daemon?: true;
  nativeExitTaskId?: string;
}

interface CommandWake {
  pending: Set<string>;
  completed: Set<string>;
  count: number;
  deadline: number;
  expiry: ReturnType<typeof setTimeout>;
  dispatchTimer?: ReturnType<typeof setTimeout>;
}
export interface AntigravityHost {
  connect(cwd: string, opts?: StartSessionOptions): Promise<AntigravityConnection>;
  /** Check the native subscription/credits policy before generation, independently of OAuth. */
  assertGenerationAllowed?(): Promise<void>;
  assertSessionAllowed?(): Promise<void>;
  authenticated?(): Promise<void>;
  disconnected?(): void;
  modelsChanged(models: AcpDiscoveredModel[], tier?: { id: string; name: string }, capabilities?: { supportsImageInput?: boolean }): void;
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
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
function resolveImageMimeType(filePath: string, explicitMimeType?: string): string | undefined {
  const raw = explicitMimeType?.trim().toLowerCase() || IMAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (!raw) return undefined;
  return raw === 'image/jpg' ? 'image/jpeg' : raw;
}
async function promptContent(
  message: UserMessage,
  opts: { supportsImageInput: boolean },
): Promise<AcpRecord[]> {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  const blocks: AcpRecord[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'file' || block.type === 'mention') {
      if (!path.isAbsolute(block.path)) throw new Error('ANTIGRAVITY_ATTACHMENT_PATH_INVALID');
      blocks.push({
        type: 'resource_link',
        uri: pathToFileURL(block.path).href,
        name: block.type === 'mention' ? block.name : path.basename(block.path),
        ...(block.type === 'file' && block.mimeType ? { mimeType: block.mimeType } : {}),
      });
      continue;
    }
    if (block.type === 'image') {
      if (!path.isAbsolute(block.path)) throw new Error('ANTIGRAVITY_ATTACHMENT_PATH_INVALID');
      const mimeType = resolveImageMimeType(block.path, block.mimeType);
      if (opts.supportsImageInput && mimeType && SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
        let bytes: Buffer;
        try {
          bytes = await fsReadFile(block.path);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`ANTIGRAVITY_IMAGE_READ_FAILED: ${detail}`);
        }
        if (bytes.length === 0) {
          throw new Error(`ANTIGRAVITY_IMAGE_READ_FAILED: empty image file ${block.path}`);
        }
        blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType });
        continue;
      }
      blocks.push({
        type: 'resource_link',
        uri: pathToFileURL(block.path).href,
        name: path.basename(block.path),
        ...(mimeType ? { mimeType } : {}),
      });
      continue;
    }
    throw new Error('ANTIGRAVITY_IMAGE_INPUT_UNSUPPORTED');
  }
  return blocks;
}
export class AntigravityAgent extends BaseAgent {
  readonly kind = 'antigravity' as const;
  readonly capabilities: Capabilities = {
    switchModel: yes, availableModels: [], hasFastMode: false, effort: no, effortLevels: [], reasoningDisplay: ['off'],
    permissionModes: [{ id: 'ask', displayName: 'Ask' }, { id: 'acceptEdits', displayName: 'Accept edits' }, { id: 'auto', displayName: 'Auto' }, { id: 'bypassPermissions', displayName: 'Full access' }], setPermissionModeMidSession: yes, planMode: yes,
    multimodal: { text: yes, image: yes, file: yes }, fork: no, rewind: no, abort: yes,
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
    this.capabilities.multimodal.image = yes;
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
    this.capabilities.multimodal.image = yes;
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
    this.updateModels(session.models);
    this.capabilities.multimodal.image = session.supportsImageInput ? yes : no;
    this.host.modelsChanged(this.nativeModels, session.tier, { supportsImageInput: session.supportsImageInput });
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
    const openTools = new Map<string, OpenAntigravityTool>();
    const settledTools = new Map<string, { background: boolean; awaitingOutput: boolean }>();
    const watchedCommandCalls = new Set<string>();
    let stopWatchingCommandExits: (() => void) | undefined;
    let commandWake: CommandWake | undefined;
    let lastNativeBackgroundOutputAt = -Infinity;
    let inputEpoch = 0;
    const clearCommandWake = () => {
      if (!commandWake) return;
      clearTimeout(commandWake.expiry);
      if (commandWake.dispatchTimer) clearTimeout(commandWake.dispatchTimer);
      commandWake = undefined;
    };
    const clearEmptyCommandWake = () => {
      if (!active && commandWake?.pending.size === 0 && commandWake.completed.size === 0) clearCommandWake();
    };
    const cancelPendingBackgroundWake = () => {
      inputEpoch++;
      clearCommandWake();
    };
    const canDispatchWake = (wake: CommandWake): boolean =>
      commandWake === wake && wake.completed.size > 0 && wake.count < COMMAND_WAKE_LIMIT &&
      Date.now() < wake.deadline && !active && !closed && !control && usable &&
      !this.locallyDisconnected && connection.isCurrent?.() !== false &&
      connection.canWakeAfterCommandExit?.() === true;
    const nativeQuietDelay = () => lastNativeBackgroundOutputAt + COMMAND_WAKE_GRACE_MS - Date.now();
    const assertWakeReady = (wake: CommandWake) => {
      if (!canDispatchWake(wake)) throw new Error('ANTIGRAVITY_WAKE_SUPERSEDED');
      if (nativeQuietDelay() > 0) throw COMMAND_WAKE_NATIVE_STREAM_BUSY;
    };
    const scheduleCommandWake = (delay = COMMAND_WAKE_GRACE_MS) => {
      const wake = commandWake;
      if (!wake || active || wake.dispatchTimer || wake.completed.size === 0) return;
      const timer = setTimeout(() => {
        // Keep this claim through preflight so multiple exits coalesce.
        void send({ type: 'user', content: COMMAND_WAKE_TEXT }, undefined, wake).catch(error => {
          if (commandWake !== wake || wake.dispatchTimer !== timer) return;
          wake.dispatchTimer = undefined;
          // Native output can come from another tool such as schedule. It is
          // evidence to wait for idle, not proof that a command was handled.
          if (error === COMMAND_WAKE_NATIVE_STREAM_BUSY) scheduleCommandWake(Math.max(0, nativeQuietDelay()));
          else if (wake.completed.size > 0 || wake.pending.size === 0) clearCommandWake();
        });
      }, delay);
      wake.dispatchTimer = timer;
      timer.unref?.();
    };
    const markCommandCompleted = (toolUseId: string) => {
      const wake = commandWake;
      if (!wake?.pending.delete(toolUseId)) return;
      wake.completed.add(toolUseId);
      scheduleCommandWake();
    };
    const armCommandWake = (toolUseId: string) => {
      if (!connection.canWakeAfterCommandExit) return;
      if (!commandWake) {
        const expiry = setTimeout(clearCommandWake, COMMAND_WAKE_WINDOW_MS);
        expiry.unref?.();
        commandWake = {
          pending: new Set(), completed: new Set(), count: 0,
          deadline: Date.now() + COMMAND_WAKE_WINDOW_MS, expiry,
        };
      }
      commandWake.pending.add(toolUseId);
    };
    const emit = (type: AgentEvent['type'], data: unknown, background = false, nativeToolName?: string) => {
      queue.push({
        type, data, source: 'antigravity',
        ...(background ? { turnScope: 'background' as const } : {}),
        ...(nativeToolName ? { [ANTIGRAVITY_NATIVE_TOOL_NAME]: nativeToolName } : {}),
      });
    };
    const emitToolActivity = (activity: AntigravityToolActivity) => emit('antigravity_tool_activity', activity, true);
    const stopCommandWatch = () => {
      watchedCommandCalls.clear();
      stopWatchingCommandExits?.();
      stopWatchingCommandExits = undefined;
    };
    const unwatchCommandCall = (toolUseId: string) => {
      if (watchedCommandCalls.delete(toolUseId) && watchedCommandCalls.size === 0) stopCommandWatch();
    };
    const watchCommandCall = (toolUseId: string) => {
      const current = connection;
      if (!current.watchCommandExits || watchedCommandCalls.has(toolUseId)) return;
      watchedCommandCalls.add(toolUseId);
      stopWatchingCommandExits ??= current.watchCommandExits(id, (exit) => {
        if (closed || current !== connection || !watchedCommandCalls.has(exit.toolUseId) || current.isCurrent?.() === false) return;
        const call = openTools.get(exit.toolUseId);
        if (!call) return;
        call.nativeExitTaskId = exit.taskId;
        // The native task can end before ACP returns the tool result. Keep the
        // call and its original turn scope until that result actually arrives.
        emitToolActivity({ kind: 'command_exited', ...exit });
        unwatchCommandCall(exit.toolUseId);
        markCommandCompleted(exit.toolUseId);
      });
    };
    const finishTool = (toolUseId: string, fullText: string, isError: boolean, awaitingOutput = false) => {
      const call = openTools.get(toolUseId);
      if (!call) return;
      const { background } = call;
      openTools.delete(toolUseId);
      unwatchCommandCall(toolUseId);
      settledTools.set(toolUseId, { background, awaitingOutput });
      if (settledTools.size > RECENT_TOOL_RESULTS_LIMIT) {
        const oldest = settledTools.keys().next().value;
        if (oldest !== undefined) settledTools.delete(oldest);
      }
      emit('tool_result_full', { toolUseId, fullText, isError }, background);
      emit('tool_result', { toolUseIds: [toolUseId], summary: isError ? 'failed' : 'done' }, background);
    };
    const interruptOpenTools = () => {
      for (const toolUseId of openTools.keys()) {
        finishTool(toolUseId, 'Interrupted before the tool finished.', true);
      }
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
        cancelPendingBackgroundWake();
        stopCommandWatch();
        // Only release the event stream after this process has stopped. Session's
        // normal stream-end lifecycle then rebuilds on the next user send; no replay.
        void retireSession().catch(() => {
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
            if (background && content.text.trim()) lastNativeBackgroundOutputAt = Date.now();
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
        } else if (type === 'tool_call' || type === 'tool_call_update') {
          const tool = normalizeToolCallFields(update);
          if (!tool) return;
          const toolUseId = tool.toolCallId;
          const isError = tool.status === 'failed';
          const terminal = tool.status === 'completed' || isError;
          const fullText = (tool.content ?? []).map(block => record(record(block).content))
            .filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n');
          const settled = settledTools.get(toolUseId);
          if (settled) {
            if (terminal && settled.awaitingOutput && fullText) {
              settled.awaitingOutput = false;
              emit('tool_result_full', { toolUseId, fullText, isError }, settled.background);
            }
            return;
          }
          let call = openTools.get(toolUseId);
          const alreadyOpen = call !== undefined;
          if (!call) {
            // An unrecognized update can be a late metadata patch, not a new call.
            if (type === 'tool_call_update' && tool.status === undefined) return;
            if (background) flushBackgroundText();
            else if (currentText) {
              emit('text', { text: currentText, isFinal: true, isFullText: true });
              currentText = '';
            }
            const content = {
              toolName: acpToolDisplayName({ ...tool, kind: tool.kind ?? 'Antigravity' }),
              input: type === 'tool_call' || tool.title || tool.name ? record(tool.rawInput) : {},
            };
            call = { background };
            openTools.set(toolUseId, call);
            emit('tool_use', { toolUseId, ...parseMessageToolUse({ role: 'tool_use', toolUseId, content }) }, background, tool.name);
          }
          if (tool.name === 'run_command') call.nativeCommand = true;
          const input = record(tool.rawInput);
          if (input.is_daemon === true || input.IsDaemon === true) {
            call.daemon = true;
            commandWake?.pending.delete(toolUseId);
            commandWake?.completed.delete(toolUseId);
            clearEmptyCommandWake();
          }
          if (terminal) {
            finishTool(toolUseId, fullText, isError, !fullText);
            markCommandCompleted(toolUseId);
            return;
          }
          if (call.background && call.nativeCommand && !call.nativeExitTaskId) watchCommandCall(toolUseId);
          const started = tool.status === 'in_progress' && call.status !== 'in_progress';
          if (tool.status) call.status = tool.status;
          const rawOutput = record(tool.rawOutput).output;
          const output = fullText || (typeof rawOutput === 'string' ? rawOutput : '');
          const outputHash = output ? createHash('sha256').update(output).digest('hex') : undefined;
          const newOutput = outputHash !== undefined && outputHash !== call.outputHash;
          if (outputHash) call.outputHash = outputHash;
          if (alreadyOpen && call.background && !call.nativeExitTaskId && (started || newOutput)) {
            emitToolActivity({ kind: 'tool_progress', toolUseId });
          }
        }
      },
      async requestPermission(input, signal) {
        const decision = await resolver({ kind: 'permission', requestId: `acp-${String(input.toolCallId)}`, toolUseId: String(input.toolCallId), toolName: String(input.title ?? input.kind ?? 'Antigravity'), input: record(input.rawInput), title: String(input.title ?? 'Antigravity') }, signal);
        return decision.kind === 'permission' && decision.behavior === 'allow';
      },
    });
    const thisAgent = this;
    let session = createSession(connection);
    let retirement: {
      session: AcpSubscriptionSession;
      pending?: Promise<void>;
      confirmed: boolean;
      waitingForExit: boolean;
    } | undefined;
    const retireSession = (finishToolCards = true): Promise<void> => {
      if (retirement?.session !== session) {
        retirement = { session, confirmed: false, waitingForExit: false };
      }
      const retiring = retirement;
      if (retiring.pending) return retiring.pending;
      const owner = connection;
      const confirmExit = () => {
        if (session !== retiring.session || retiring.confirmed) return;
        retiring.confirmed = true;
        stopCommandWatch();
        try { owner.dispose?.(); } finally {
          flushBackgroundText();
          if (closed || finishToolCards) interruptOpenTools();
          emitToolActivity({ kind: 'process_exited' });
          if (closed) queue.end();
        }
      };
      retiring.pending = retiring.session.close().then(confirmExit, error => {
        retiring.pending = undefined;
        // Observe a late exit after a failed close. In the ordinary path,
        // closing the subscription first lets pending prompt terminals drain.
        if (!retiring.waitingForExit && owner.transport.whenExited) {
          retiring.waitingForExit = true;
          void owner.transport.whenExited.then(confirmExit).catch(() => {
            thisAgent.deps.logger.warn('ACP cleanup failed after process exit');
          });
        }
        throw error;
      });
      return retiring.pending;
    };
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
    } catch (error) { await retireSession(); throw new AgentStartupStoppedError(error); }
    const reconnect = async (next: PermissionMode | undefined): Promise<void> => {
      usable = false;
      await retireSession();
      interruptOpenTools();
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
      } catch (error) { await retireSession(); throw error; }
      usable = true;
    };
    const change = async (run: () => Promise<void>): Promise<void> => {
      if (active || closed || control) throw new Error('ANTIGRAVITY_SESSION_BUSY');
      assertCurrent();
      cancelPendingBackgroundWake();
      const pending = run(); control = pending;
      try { await pending; } finally { if (control === pending) control = undefined; }
    };
    const send = async (message: UserMessage, sendOpts?: SendOptions, wake?: CommandWake) => {
      if (wake) {
        assertWakeReady(wake);
      } else {
        cancelPendingBackgroundWake();
        lastNativeBackgroundOutputAt = -Infinity;
      }
      if (this.locallyDisconnected) throw new Error('Google 订阅连接已断开，请先重新连接。');
      if (active || closed || control || sendOpts?.turnPermissionPolicy) throw new Error('ANTIGRAVITY_TURN_UNSUPPORTED');
      const controller = new AbortController();
      const epoch = inputEpoch;
      const claimTurn = () => {
        turnController = controller; active = true; currentText = '';
        cancelTurn = cancelled;
      };
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
          if (session !== retiring) return;
          usable = false;
          // Clear dead activity now. A later reconnect still owns tool-card reconciliation.
          void retireSession(false).catch(() => {
            thisAgent.deps.logger.warn('ACP cleanup pending after cancel', { code: 'ACP_PROCESS_EXIT_UNCONFIRMED' });
          });
        }, CANCEL_GRACE_MS);
        cancelTimer.unref?.();
      };
      // During wake preflight, a user send can still reserve the turn.
      if (!wake) claimTurn();
      sendOpts?.signal?.addEventListener('abort', cancelled, { once: true });
      const release = () => {
        if (cancelTimer) clearTimeout(cancelTimer);
        if (turnController === controller) {
          active = false;
          promptDispatched = false;
          turnController = undefined;
          cancelTurn = undefined;
        }
        sendOpts?.signal?.removeEventListener('abort', cancelled);
      };
      const finish = (outcome: AcpResponse) => {
        if (settled) return;
        settled = true;
        const text = currentText;
        currentText = '';
        const result = 'result' in outcome ? outcome.result : {};
        const cancelled = cancelledByCaller || result.stopReason === 'cancelled';
        const mayArmWake = !closed && epoch === inputEpoch && result.stopReason === 'end_turn' &&
          !cancelled && (!wake || commandWake === wake);
        if (wake && !mayArmWake && commandWake === wake) clearCommandWake();
        release();
        if (text) emit('text', { text, isFinal: true, isFullText: true });
        for (const [toolUseId, call] of openTools) {
          if (call.background) continue;
          if (cancelled || 'error' in outcome) {
            finishTool(toolUseId, 'Interrupted before the tool finished.', true);
          } else {
            call.background = true;
            if (call.nativeCommand) {
              if (mayArmWake && call.status === 'in_progress' && !call.daemon && !call.nativeExitTaskId) {
                armCommandWake(toolUseId);
              }
              watchCommandCall(toolUseId);
            }
          }
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
        clearEmptyCommandWake();
        scheduleCommandWake();
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
        const content = await promptContent(message, { supportsImageInput: session.supportsImageInput });
        controller.signal.throwIfAborted();
        if (closed) throw new Error('ANTIGRAVITY_SESSION_CLOSED');
        const dispatched = await session.dispatchPrompt(content, controller.signal, {
          beforeSend() {
            if (wake) assertWakeReady(wake);
          },
          sent() {
            if (wake) {
              claimTurn();
              wake.dispatchTimer = undefined;
              wake.completed.clear();
              if (++wake.count >= COMMAND_WAKE_LIMIT) clearCommandWake();
            }
            flushBackgroundText();
            promptDispatched = true;
            emit('status', { isRunning: true, status: 'Thinking...', ...(wake ? { providerInitiatedTurn: true } : {}) });
          },
          response: finish,
        });
        void dispatched.completion.catch(error => {
          finish({ error: error instanceof Error ? error : new Error('ACP 请求失败') });
        });
      } catch (error) { release(); throw error; }
    };
    return {
      id: scope + id, agentKind: 'antigravity', get model() { return session.currentModel ?? opts.model; },
      setInteractionResolver(next) { resolver = next; }, events: () => queue,
      isTurnRunning: () => active,
      countPendingWakeContinuations: () => commandWake && Date.now() < commandWake.deadline ? 1 : 0,
      cancelPendingBackgroundWake,
      getUsageSnapshot: () => ({ ...usage }),
      send: (message, sendOpts) => send(message, sendOpts),
      steer: async () => { throw new Error('ANTIGRAVITY_STEER_NOT_IMPLEMENTED'); },
      abort: async () => {
        cancelPendingBackgroundWake();
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
      close: async () => {
        closed = true;
        cancelPendingBackgroundWake();
        cancelTurn?.();
        await control?.catch(() => {});
        await retireSession();
        interruptOpenTools();
        queue.end();
      },
    };
  }
}
