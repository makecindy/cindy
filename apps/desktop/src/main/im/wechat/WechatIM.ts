import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BaseIM,
  type IMCardActionEvent,
  type IMHost,
  type IMMessageEvent,
  type IMStatus,
  type RichChannelIM,
  type SendFileResult,
  type StreamingTextHandle,
} from '@cindy/im';
import {
  asWechatIlinkError,
  chunkWechatText,
  filterWechatMarkdown,
  WECHAT_MEDIA_MAX_BYTES,
  WechatIlinkError,
  type WechatAuthorizationEvent,
  type WechatCredentials,
  type WechatInboundMessage,
  type WechatTransport,
} from '@cindy/wechat-ilink';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

import type { ImSessionRepo } from '../shared/sessionRepo';
import type { ImOrchestratorConfig } from '../shared/types';
import type { ImFinalOutput } from '@cindy/im';
import type { ImTurnRunner } from '../shared/turnRunner';
import {
  createWechatTurnPermissionPolicy,
  WECHAT_INTERACTION_CONFIRM_TIMEOUT_MS,
  WECHAT_TURN_PERMISSION_POLICY_UNSUPPORTED,
} from './permissionPolicy';
import {
  permissionModeCommandContext,
  renderTextPermissionModePicker,
  renderTextPermissionModeResult,
  resolvePermissionMode,
} from '../shared/permissionModeControl';
import { ui } from './uiText';
import { WechatTaskStore, type WechatActiveBinding, type WechatTask } from './taskStore';
import type { DbClient } from '../../localDb/client/DbClient';
import {
  removeUncommittedWechatFiles,
  removeReleasedWechatFiles,
  stageWechatTaskMedia,
  type WechatTaskAttachment,
} from './mediaStaging';

const CREDENTIAL_PREFIX = 'wechat_credentials_';
const DATA_KEY_NAME = 'wechat_data_key_v1';
const AUTH_BASE_URL = 'https://ilinkai.weixin.qq.com';
const EMPTY_POLL_DELAY_MS = 100;
const IDLE_PUMP_DELAY_MS = 200;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type WechatBotPhase =
  | 'disconnected'
  | 'authorizing'
  | 'waiting_confirmation'
  | 'connected'
  | 'reconnecting'
  | 'needs_reauth'
  | 'disabled_by_policy'
  | 'error';

export interface WechatBotState {
  phase: WechatBotPhase;
  bound: boolean;
  connectedAt?: number;
  lastInboundAt?: number;
  queuedTasks: number;
  errorCode?: string;
}

interface StoredWechatCredentials {
  botToken: string;
  ilinkBotId: string;
  userId: string;
  baseUrl: string;
  boundAt: number;
  bindingEpoch: string;
}

interface WechatTaskPayload {
  text: string;
  attachments: WechatTaskAttachment[];
  unsupportedMedia: string[];
}

interface ActiveTask {
  task: WechatTask;
  routeSessionId?: string;
  terminalCommitted: boolean;
}

function activePeerIdForSession<
  T extends { routeSessionId?: string; task: { sessionId: string } },
>(activeTasks: ReadonlyMap<string, T>, sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const peers = [...activeTasks.entries()]
    .filter(([, active]) => (active.routeSessionId ?? active.task.sessionId) === sessionId)
    .map(([peerId]) => peerId);
  return peers.length === 1 ? peers[0]! : null;
}

interface PendingWechatInteraction {
  request: InteractionRequest;
  resolve: (decision: InteractionDecision) => void;
  timer: NodeJS.Timeout;
}

interface TurnRuntime {
  runner: ImTurnRunner;
  repo: ImSessionRepo;
  config: ImOrchestratorConfig;
  resetSessionToDefaults(
    sessionId: string,
    config: ImOrchestratorConfig,
    prepared: Awaited<ReturnType<ImSessionRepo['prepareNewSession']>>,
  ): Promise<void>;
}

export interface WechatIMDeps {
  host: IMHost;
  getDbClient(): DbClient;
  createTransport(args: {
    credentials: StoredWechatCredentials | null;
    onAuthorizationEvent?: (event: WechatAuthorizationEvent) => void;
  }): WechatTransport;
  openAuthorizationUrl(url: string): Promise<void>;
  captureAccountGeneration(): number | null;
  isAccountGenerationCurrent(generation: number): boolean;
  isCompatibilityDisabled(): boolean;
  now?: () => number;
}

/**
 * Main-process personal WeChat connector.
 *
 * The class implements the rich interface only because the existing shared
 * turn runner still carries legacy card methods in its adapter type. Its
 * output driver is always `chunked-text`; every card method fails loudly so a
 * future regression cannot silently send a fake card over personal WeChat.
 */
export class WechatIM extends BaseIM implements RichChannelIM {
  readonly #deps: WechatIMDeps;
  readonly #statusHandlers = new Set<(status: IMStatus) => void>();
  readonly #messageHandlers = new Set<(event: IMMessageEvent) => void>();
  readonly #activeTasks = new Map<string, ActiveTask>();
  readonly #pendingInteractions = new Map<string, PendingWechatInteraction>();
  #state: Omit<WechatBotState, 'bound'> = { phase: 'disconnected', queuedTasks: 0 };
  #hasBinding = false;
  #store: WechatTaskStore | null = null;
  #turnRuntime: TurnRuntime | null = null;
  #epoch: {
    binding: WechatActiveBinding;
    credentials: StoredWechatCredentials;
    transport: WechatTransport;
    abort: AbortController;
    drain: Promise<void>;
    generation: number;
  } | null = null;
  #authorizationAbort: AbortController | null = null;
  #pollBarrier: Promise<void> = Promise.resolve();
  #compatibilityDisabled = false;
  #compatibilityRevision = 0;
  #lifecycleBarrier: Promise<void> = Promise.resolve();

  constructor(deps: WechatIMDeps) {
    super('wechat', deps.host);
    this.#deps = deps;
    this.#compatibilityDisabled = deps.isCompatibilityDisabled();
  }

  attachTurnRuntime(runtime: TurnRuntime): void {
    if (this.#turnRuntime) throw new Error('WeChat turn runtime already attached.');
    this.#turnRuntime = runtime;
  }

  getState(): WechatBotState {
    return { ...this.#state, bound: this.#hasBinding };
  }

  async init(): Promise<void> {
    await this.setCompatibilityDisabled(this.#deps.isCompatibilityDisabled());
    const revision = this.#compatibilityRevision;
    await this.#queueLifecycle(async () => {
      if (this.#store && !this.#compatibilityDisabled) return;
      await this.#resumeStoredBinding(revision);
    });
  }

  setCompatibilityDisabled(disabled: boolean): Promise<void> {
    if (disabled === this.#compatibilityDisabled) return this.#lifecycleBarrier;
    this.#compatibilityDisabled = disabled;
    const revision = ++this.#compatibilityRevision;
    if (disabled) {
      this.cancelAuthorization();
      this.#epoch?.abort.abort();
      this.#setState({
        phase: 'disabled_by_policy',
        queuedTasks: this.#state.queuedTasks,
      });
    }
    return this.#queueLifecycle(() => this.#applyCompatibilityDisabled(disabled, revision));
  }

  async #applyCompatibilityDisabled(disabled: boolean, revision: number): Promise<void> {
    if (revision !== this.#compatibilityRevision || disabled !== this.#compatibilityDisabled) return;
    if (disabled) {
      const stopped = this.#stopEpoch();
      this.#setState({
        phase: 'disabled_by_policy',
        queuedTasks: this.#state.queuedTasks,
      });
      await stopped;
      return;
    }
    if (!this.#hasBinding) {
      this.#setState({ phase: 'disconnected', queuedTasks: 0 });
      return;
    }
    await this.#resumeStoredBinding(revision);
  }

  async #resumeStoredBinding(revision: number): Promise<void> {
    const active = await this.#readActiveBindingWithoutKey();
    if (!this.#isCompatibilityRevisionCurrent(revision)) return;
    if (!active) {
      this.#hasBinding = false;
      this.#setState({
        phase: this.#compatibilityDisabled ? 'disabled_by_policy' : 'disconnected',
        queuedTasks: 0,
      });
      return;
    }
    this.#hasBinding = true;
    if (this.#compatibilityDisabled) {
      this.#setState({ phase: 'disabled_by_policy', queuedTasks: 0 });
      return;
    }
    const key = this.#readDataKey();
    const credentials = this.#readCredentials(active.bindingEpoch);
    if (!key || !credentials) {
      this.#setState({
        phase: 'needs_reauth',
        queuedTasks: 0,
        errorCode: 'credentials_missing',
      });
      return;
    }
    if (!this.#store) {
      this.#store = new WechatTaskStore(this.#deps.getDbClient(), key);
      await this.#store.stopAll({
        bindingEpoch: active.bindingEpoch,
        now: this.#now(),
        errorCode: 'PROCESS_RESTARTED',
      });
    }
    if (!this.#isCompatibilityRevisionAllowed(revision)) return;
    await this.#stopEpoch();
    if (!this.#isCompatibilityRevisionAllowed(revision)) return;
    await this.#startEpoch(active, credentials, revision);
  }

  dispose(): Promise<void> {
    this.cancelAuthorization();
    return this.#queueLifecycle(async () => {
      await this.#stopEpoch();
      this.#store?.destroy();
      this.#store = null;
      this.#activeTasks.clear();
      this.#hasBinding = false;
      this.#setState({ phase: 'disconnected', queuedTasks: 0 });
    });
  }

  registerIpc(): void {
    // Registered in Desktop Main with a trusted-renderer sender check.
  }

  async authorize(): Promise<{ started: true }> {
    if (this.#deps.isCompatibilityDisabled() && !this.#compatibilityDisabled) {
      await this.setCompatibilityDisabled(true);
    }
    if (this.#compatibilityDisabled) {
      this.#setState({
        phase: 'disabled_by_policy',
        queuedTasks: this.#state.queuedTasks,
      });
      throw new Error('WECHAT_DISABLED_BY_POLICY');
    }
    const compatibilityRevision = this.#compatibilityRevision;
    if (!this.host.secrets.isAvailable()) {
      throw new Error('WECHAT_SAFE_STORAGE_UNAVAILABLE');
    }
    const generation = this.#deps.captureAccountGeneration();
    if (generation === null) throw new Error('WECHAT_ACCOUNT_SCOPE_CLOSED');
    this.cancelAuthorization();
    const abort = new AbortController();
    this.#authorizationAbort = abort;
    this.#setState({ ...this.#state, phase: 'authorizing', errorCode: undefined });
    const transport = this.#deps.createTransport({
      credentials: null,
      onAuthorizationEvent: (event) => {
        if (
          this.#authorizationAbort !== abort ||
          !this.#isCompatibilityRevisionAllowed(compatibilityRevision)
        ) {
          return;
        }
        if (event.status === 'waiting' || event.status === 'scanned') {
          this.#setState({ ...this.#state, phase: 'waiting_confirmation' });
        } else if (event.status === 'qr-refreshed') {
          void this.#deps.openAuthorizationUrl(event.challenge.qrCodeUrl);
        }
      },
    });

    void (async () => {
      try {
        const challenge = await transport.beginAuthorization(abort.signal);
        if (
          this.#authorizationAbort !== abort ||
          !this.#isGenerationCurrent(generation) ||
          !this.#isCompatibilityRevisionAllowed(compatibilityRevision)
        ) {
          return;
        }
        this.#setState({ ...this.#state, phase: 'waiting_confirmation' });
        await this.#deps.openAuthorizationUrl(challenge.qrCodeUrl);
        const credentials = await transport.waitAuthorization(challenge, abort.signal);
        if (
          this.#authorizationAbort !== abort ||
          !this.#isGenerationCurrent(generation) ||
          !this.#isCompatibilityRevisionAllowed(compatibilityRevision)
        ) {
          return;
        }
        await this.#queueLifecycle(() =>
          this.#activateAuthorizedCredentials(credentials, generation, compatibilityRevision),
        );
      } catch (error) {
        const safe = asWechatIlinkError(error);
        if (
          safe.code !== 'ABORTED' &&
          this.#isGenerationCurrent(generation) &&
          this.#isCompatibilityRevisionAllowed(compatibilityRevision)
        ) {
          this.#setState({
            ...this.#state,
            phase: safe.code === 'AUTH_REPLACED' ? 'needs_reauth' : 'error',
            errorCode: safe.code.toLowerCase(),
          });
        }
      } finally {
        if (this.#authorizationAbort === abort) this.#authorizationAbort = null;
      }
    })();
    return { started: true };
  }

  cancelAuthorization(): void {
    this.#authorizationAbort?.abort();
    this.#authorizationAbort = null;
    if (this.#state.phase === 'authorizing' || this.#state.phase === 'waiting_confirmation') {
      this.#setState({
        ...this.#state,
        phase: authorizationCancelPhase(Boolean(this.#epoch), this.#hasBinding),
      });
    }
  }

  unbind(): Promise<void> {
    this.cancelAuthorization();
    return this.#queueLifecycle(() => this.#unbind());
  }

  async #unbind(): Promise<void> {
    const active = this.#epoch?.binding ?? (await this.#readActiveBindingWithoutKey());
    if (!active) {
      this.#setState({
        phase: this.#compatibilityDisabled ? 'disabled_by_policy' : 'disconnected',
        queuedTasks: 0,
      });
      return;
    }
    const key = this.#readDataKey();
    if (!key) throw new Error('WECHAT_DATA_KEY_UNAVAILABLE');
    const store = this.#store ?? new WechatTaskStore(this.#deps.getDbClient(), key);
    // Stop the live agent turn while its binding is still valid. Closing the
    // rows first lets a late terminal callback race with cleanup and leaves
    // the attached Desktop session running after the user has unbound.
    await this.#stopEpoch();
    await store.closeBindingEpoch(active.bindingEpoch, this.#now());
    const cleanup = await store.unbindCleanup(active.bindingEpoch);
    await removeReleasedWechatFiles(cleanup.filePaths);
    this.host.secrets.remove(`${CREDENTIAL_PREFIX}${active.bindingEpoch}`);
    this.host.secrets.remove(DATA_KEY_NAME);
    store.destroy();
    this.#store = null;
    this.#hasBinding = false;
    this.#setState({
      phase: this.#compatibilityDisabled ? 'disabled_by_policy' : 'disconnected',
      queuedTasks: 0,
    });
  }

  onMessage(handler: (event: IMMessageEvent) => void): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onStatusChange(handler: (status: IMStatus) => void): () => void {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  onCardAction(handler: (event: IMCardActionEvent) => void): () => void {
    void handler;
    return () => undefined;
  }

  getStatus(): IMStatus {
    if (this.#state.phase === 'connected') {
      return { kind: 'connected', appId: this.#epoch?.credentials.ilinkBotId ?? 'wechat' };
    }
    if (
      this.#state.phase === 'authorizing' ||
      this.#state.phase === 'waiting_confirmation' ||
      this.#state.phase === 'reconnecting'
    ) {
      return { kind: 'connecting' };
    }
    if (this.#state.phase === 'error' || this.#state.phase === 'needs_reauth') {
      return { kind: 'error', reason: this.#state.errorCode ?? 'wechat_error' };
    }
    return { kind: 'idle' };
  }

  async sendText(userId: string, text: string): Promise<{ messageId: string }> {
    const active = this.#activeTasks.get(userId);
    const epoch = this.#epoch;
    if (!epoch || this.#compatibilityDisabled || epoch.abort.signal.aborted) {
      throw new Error('WECHAT_NO_ACTIVE_CONTEXT');
    }
    const contextToken =
      active?.task.contextToken ??
      (
        await this.#requireStore().getLatestPeerContext({
          bindingEpoch: epoch.binding.bindingEpoch,
          peerId: userId,
        })
      )?.contextToken;
    if (!contextToken) throw new Error('WECHAT_PEER_NOT_KNOWN');
    const clientId = randomUUID();
    await epoch.transport.sendMessage(
      {
        peerId: userId,
        text,
        contextToken,
        clientId,
      },
      epoch.abort.signal,
    );
    return { messageId: clientId };
  }

  async getMostRecentPeerId(): Promise<string | null> {
    const epoch = this.#epoch;
    if (!epoch || this.#compatibilityDisabled || epoch.abort.signal.aborted) return null;
    return this.#requireStore().getMostRecentPeer(epoch.binding.bindingEpoch);
  }

  getActivePeerIdForSession(sessionId: string | undefined): string | null {
    return activePeerIdForSession(this.#activeTasks, sessionId);
  }

  async handleTextInteraction(
    userId: string,
    request: InteractionRequest,
    options?: { timeoutMs?: number },
  ): Promise<InteractionDecision> {
    const previous = this.#pendingInteractions.get(userId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(defaultWechatInteractionDecision(previous.request, 'replaced_by_new_request'));
    }

    let resolvePending!: (decision: InteractionDecision) => void;
    const result = new Promise<InteractionDecision>((resolve) => {
      resolvePending = resolve;
    });
    const timer = setTimeout(() => {
      this.#pendingInteractions.delete(userId);
      resolvePending(defaultWechatInteractionDecision(request, 'wechat_interaction_timeout'));
    }, options?.timeoutMs ?? WECHAT_INTERACTION_CONFIRM_TIMEOUT_MS);
    timer.unref?.();
    this.#pendingInteractions.set(userId, { request, resolve: resolvePending, timer });
    try {
      await this.sendText(userId, formatWechatInteractionPrompt(request));
    } catch (error) {
      const pending = this.#pendingInteractions.get(userId);
      if (pending?.request.requestId === request.requestId) {
        clearTimeout(pending.timer);
        this.#pendingInteractions.delete(userId);
      }
      return defaultWechatInteractionDecision(
        request,
        error instanceof Error ? error.message : 'wechat_interaction_send_failed',
      );
    }
    return result;
  }

  /**
   * Resolve only the exact pending request owned by the central interaction
   * route. Request-id matching prevents a late timeout/release from cancelling
   * a newer one-shot confirmation for the same WeChat peer.
   */
  cancelTextInteraction(
    userId: string,
    requestId: string,
    decision: InteractionDecision,
  ): boolean {
    const pending = this.#pendingInteractions.get(userId);
    if (!pending || pending.request.requestId !== requestId) return false;
    clearTimeout(pending.timer);
    this.#pendingInteractions.delete(userId);
    pending.resolve(decision);
    return true;
  }

  sendMarkdownText(userId: string, markdown: string): Promise<{ messageId: string }> {
    return this.sendText(userId, filterWechatMarkdown(markdown));
  }

  async sendFile(userId: string, absPath: string, displayName?: string): Promise<SendFileResult> {
    const epoch = this.#epoch;
    if (!epoch || this.#compatibilityDisabled || epoch.abort.signal.aborted) {
      return { ok: false, reason: 'SEND_FAIL' };
    }
    const contextToken =
      this.#activeTasks.get(userId)?.task.contextToken ??
      (
        await this.#requireStore().getLatestPeerContext({
          bindingEpoch: epoch.binding.bindingEpoch,
          peerId: userId,
        })
      )?.contextToken;
    if (!contextToken) return { ok: false, reason: 'SEND_FAIL' };
    let uploadedSuccessfully = false;
    try {
      const local = await readOutboundWechatFile(absPath, displayName);
      if (this.#compatibilityDisabled || epoch.abort.signal.aborted) {
        return { ok: false, reason: 'SEND_FAIL' };
      }
      const uploaded = await epoch.transport.uploadMedia(
        {
          peerId: userId,
          bytes: local.bytes,
          fileName: local.fileName,
          kind: local.kind,
        },
        epoch.abort.signal,
      );
      uploadedSuccessfully = true;
      if (this.#compatibilityDisabled || epoch.abort.signal.aborted) {
        return { ok: false, reason: 'SEND_FAIL' };
      }
      const clientId = randomUUID();
      await epoch.transport.sendMedia(
        {
          peerId: userId,
          contextToken,
          clientId,
          uploaded,
        },
        epoch.abort.signal,
      );
      return { ok: true, messageId: clientId };
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : '';
      if (code === 'ENOENT') return { ok: false, reason: 'NOT_FOUND' };
      if (code === 'WECHAT_FILE_EMPTY') return { ok: false, reason: 'EMPTY' };
      if (code === 'WECHAT_FILE_TOO_LARGE') return { ok: false, reason: 'TOO_LARGE' };
      return { ok: false, reason: uploadedSuccessfully ? 'SEND_FAIL' : 'UPLOAD_FAIL' };
    }
  }

  sendInteractiveCard(): Promise<{ messageId: string }> {
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  updateInteractiveCard(): Promise<void> {
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  patchMarkdownCard(): Promise<void> {
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  startStreamingText(
    userId: string,
    initial?: string,
    opts?: { threadTs?: string },
  ): Promise<StreamingTextHandle> {
    void userId;
    void initial;
    void opts;
    return Promise.reject(new Error('WECHAT_RICH_OUTPUT_UNSUPPORTED'));
  }

  async commitFinal(output: ImFinalOutput): Promise<void> {
    const active = this.#activeTasks.get(output.userId);
    if (!active) throw new Error('WECHAT_NO_ACTIVE_TASK');
    const chunks = chunkWechatText(normalizeFinalOutputText(output.text));
    const kind =
      output.terminal === 'done'
        ? ('final' as const)
        : output.terminal === 'aborted'
          ? ('interrupted' as const)
          : ('error' as const);
    const result = await this.#requireStore().commitTerminal({
      bindingEpoch: active.task.bindingEpoch,
      taskId: active.task.id,
      now: this.#now(),
      outbox: chunks.map((chunk, index) => ({
        id: randomUUID(),
        clientId: randomUUID(),
        kind,
        chunkIndex: index,
        text: chunk,
        ...(index === 0 && output.mediaAbsPaths?.length
          ? {
              mediaJson: JSON.stringify(
                output.mediaAbsPaths.slice(0, 4).map((absPath) => ({
                  absPath,
                  clientId: randomUUID(),
                })),
              ),
            }
          : {}),
      })),
    });
    if (!result.committed) throw new Error('WECHAT_TERMINAL_COMMIT_REJECTED');
    active.terminalCommitted = true;
  }

  async onUserMessagePersisted(args: {
    sessionId: string;
    userMessageId: string | null;
    persisted: boolean;
  }): Promise<void> {
    const bindingEpoch = this.#epoch?.binding.bindingEpoch;
    if (!args.persisted || !args.userMessageId || !bindingEpoch) return;
    try {
      await this.#requireStore().promoteTaskAttachments({
        bindingEpoch,
        taskId: args.userMessageId,
        sessionId: args.sessionId,
        now: this.#now(),
      });
    } catch (error) {
      this.log.warn('WeChat attachment promotion requires repair', {
        task: shortId(args.userMessageId),
        code: machineErrorCode(error),
      });
    }
  }

  async #activateAuthorizedCredentials(
    raw: WechatCredentials,
    generation: number,
    compatibilityRevision: number,
  ): Promise<void> {
    if (
      !this.#isGenerationCurrent(generation) ||
      !this.#isCompatibilityRevisionAllowed(compatibilityRevision)
    ) {
      return;
    }
    const bindingEpoch = randomUUID();
    const stored: StoredWechatCredentials = {
      botToken: raw.token,
      ilinkBotId: raw.botId,
      userId: raw.userId,
      baseUrl: raw.baseUrl,
      boundAt: this.#now(),
      bindingEpoch,
    };
    const key = this.#readDataKey() ?? randomBytes(32);
    if (!this.host.secrets.write(DATA_KEY_NAME, Buffer.from(key).toString('base64'))) {
      throw new Error('WECHAT_DATA_KEY_WRITE_FAILED');
    }
    if (!this.host.secrets.write(`${CREDENTIAL_PREFIX}${bindingEpoch}`, JSON.stringify(stored))) {
      throw new Error('WECHAT_CREDENTIAL_WRITE_FAILED');
    }
    const store = this.#store ?? new WechatTaskStore(this.#deps.getDbClient(), key);
    this.#store = store;
    const previous = await store.getActiveBinding();
    const activated = await store.activateBindingEpoch({
      bindingEpoch,
      expectedActiveEpoch: previous?.bindingEpoch ?? null,
      now: this.#now(),
    });
    if (
      !activated.activated ||
      !this.#isGenerationCurrent(generation) ||
      !this.#isCompatibilityRevisionAllowed(compatibilityRevision)
    ) {
      let restoredPrevious = false;
      if (activated.activated) {
        if (previous) {
          const rollback = await store.activateBindingEpoch({
            bindingEpoch: previous.bindingEpoch,
            expectedActiveEpoch: bindingEpoch,
            initialCursor: previous.cursor,
            now: this.#now(),
          });
          restoredPrevious = rollback.activated;
        } else {
          await store.closeBindingEpoch(bindingEpoch, this.#now());
        }
      }
      this.host.secrets.remove(`${CREDENTIAL_PREFIX}${bindingEpoch}`);
      this.#hasBinding = activated.activated
        ? restoredPrevious
        : activated.activeBindingEpoch !== null;
      throw new Error('WECHAT_BINDING_EPOCH_STALE');
    }
    this.#hasBinding = true;
    await this.#stopEpoch();
    if (previous) {
      await store.closeBindingEpoch(previous.bindingEpoch, this.#now());
      const cleanup = await store.unbindCleanup(previous.bindingEpoch);
      await removeReleasedWechatFiles(cleanup.filePaths);
      this.host.secrets.remove(`${CREDENTIAL_PREFIX}${previous.bindingEpoch}`);
    }
    if (!this.#isCompatibilityRevisionAllowed(compatibilityRevision)) return;
    await this.#startEpoch({ bindingEpoch, cursor: '' }, stored, compatibilityRevision);
  }

  async #startEpoch(
    binding: WechatActiveBinding,
    credentials: StoredWechatCredentials,
    compatibilityRevision: number,
  ): Promise<void> {
    if (!this.#isCompatibilityRevisionAllowed(compatibilityRevision)) return;
    const generation = this.#deps.captureAccountGeneration();
    if (generation === null) throw new Error('WECHAT_ACCOUNT_SCOPE_CLOSED');
    const abort = new AbortController();
    const transport = this.#deps.createTransport({ credentials });
    try {
      await transport.notifyStart(abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return;
      this.log.warn('WeChat start notification failed; continuing with polling', {
        code: machineErrorCode(error),
      });
    }
    if (
      abort.signal.aborted ||
      !this.#isGenerationCurrent(generation) ||
      !this.#isCompatibilityRevisionAllowed(compatibilityRevision)
    ) {
      return;
    }
    const drain = Promise.allSettled([
      this.#pollLoop(binding, transport, abort.signal, generation),
      this.#taskPump(binding, abort.signal, generation),
      this.#outboxLoop(binding, transport, abort.signal, generation),
    ]).then(() => undefined);
    this.#epoch = { binding, credentials, transport, abort, drain, generation };
    const queuedTasks = await this.#requireStore().countQueuedTasks(binding.bindingEpoch);
    if (!this.#isCompatibilityRevisionAllowed(compatibilityRevision)) {
      await this.#stopEpoch();
      return;
    }
    this.#setState({
      phase: 'connected',
      connectedAt: this.#now(),
      queuedTasks,
    });
  }

  async #stopEpoch(): Promise<void> {
    const epoch = this.#epoch;
    this.#epoch = null;
    if (!epoch) return;
    epoch.abort.abort();
    for (const [peerId, pending] of this.#pendingInteractions) {
      clearTimeout(pending.timer);
      pending.resolve(defaultWechatInteractionDecision(pending.request, 'wechat_binding_stopped'));
      this.#pendingInteractions.delete(peerId);
    }
    await stopActiveWechatTurns(
      this.#turnRuntime?.runner ?? null,
      epoch.credentials.ilinkBotId,
      this.#activeTasks.keys(),
    );
    await epoch.drain;
    try {
      await epoch.transport.notifyStop(new AbortController().signal);
    } catch (error) {
      this.log.warn('WeChat stop notification failed', {
        code: machineErrorCode(error),
      });
    }
    this.#activeTasks.clear();
  }

  async #pollLoop(
    binding: WechatActiveBinding,
    transport: WechatTransport,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    let cursor = binding.cursor;
    let failures = 0;
    while (!signal.aborted && this.#isGenerationCurrent(generation)) {
      try {
        const result = await transport.poll(cursor, signal);
        const now = this.#now();
        const preparedInputs = await Promise.all(
          result.messages.map((message, index) =>
            this.#toTaskInput(binding.bindingEpoch, message, transport, signal, now, index),
          ),
        );
        const interactionIndexes = new Set(
          result.messages
            .map((message, index) =>
              this.#pendingInteractions.has(message.senderId) &&
              message.text.trim() !== '/stop' &&
              message.text.trim() !== '/stop all'
                ? index
                : -1,
            )
            .filter((index) => index >= 0),
        );
        const normalPreparedInputs = preparedInputs.filter(
          (_input, index) => !interactionIndexes.has(index),
        );
        const inputs = normalPreparedInputs.map((input) => input.message);
        const mediaBlobs = normalPreparedInputs.flatMap((input) => input.mediaBlobs);
        const mediaRefs = normalPreparedInputs.flatMap((input) => input.mediaRefs);
        const fileAttachments = normalPreparedInputs.flatMap((input) => input.fileAttachments);
        const allFileAttachments = preparedInputs.flatMap((input) => input.fileAttachments);
        let releasePollBarrier!: () => void;
        this.#pollBarrier = new Promise<void>((resolve) => {
          releasePollBarrier = resolve;
        });
        let committed;
        try {
          committed = await this.#requireStore().commitPollBatch({
            bindingEpoch: binding.bindingEpoch,
            expectedCursor: cursor,
            nextCursor: result.cursor,
            now,
            messages: inputs,
            mediaBlobs,
            mediaRefs,
            fileAttachments,
          });
          await removeUncommittedWechatFiles(
            allFileAttachments,
            acceptedPollTaskIds(committed),
          );
          if (committed.committed) {
            for (const message of result.messages) {
              await this.#requireStore().refreshPendingOutboxContext({
                bindingEpoch: binding.bindingEpoch,
                peerId: message.senderId,
                contextToken: message.contextToken,
                now,
              });
            }
          }
          if (committed.committed) {
            for (let index = 0; index < result.messages.length; index += 1) {
              const message = result.messages[index];
              const task = preparedInputs[index]?.message;
              const command = message?.text.trim();
              if (!message || !task || (command !== '/stop' && command !== '/stop all')) {
                continue;
              }
              await this.#requireStore().cancelForCommand({
                bindingEpoch: binding.bindingEpoch,
                commandTaskId: task.id,
                ...(command === '/stop' ? { peerId: message.senderId } : {}),
                now,
              });
              if (command === '/stop all') {
                await this.#turnRuntime?.runner.disposeAllSessions();
              } else {
                await this.#turnRuntime?.runner.stopActiveTurn({
                  botContextId: this.#epoch?.credentials.ilinkBotId ?? '',
                  userId: message.senderId,
                });
              }
              const pending = this.#pendingInteractions.get(message.senderId);
              if (pending) {
                clearTimeout(pending.timer);
                pending.resolve(
                  defaultWechatInteractionDecision(pending.request, 'wechat_user_stopped'),
                );
                this.#pendingInteractions.delete(message.senderId);
              }
            }
          }
          for (const index of interactionIndexes) {
            const message = result.messages[index];
            if (message) {
              await this.#handleInteractionReplyMessage(message, transport, signal);
            }
          }
        } finally {
          releasePollBarrier();
        }
        if (!committed.committed) return;
        cursor = result.cursor;
        failures = 0;
        if (result.messages.length > 0) {
          this.#setState({
            ...this.#state,
            phase: 'connected',
            lastInboundAt: now,
            queuedTasks: await this.#requireStore().countQueuedTasks(binding.bindingEpoch),
          });
        } else {
          await delay(EMPTY_POLL_DELAY_MS, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        const safe = asWechatIlinkError(error);
        if (safe.code === 'AUTH_REPLACED' || safe.code === 'AUTH_EXPIRED') {
          this.#setState({
            ...this.#state,
            phase: 'needs_reauth',
            errorCode: safe.code.toLowerCase(),
          });
          return;
        }
        if (!safe.retryable) {
          this.#setState({
            ...this.#state,
            phase: 'error',
            errorCode: safe.code.toLowerCase(),
          });
          return;
        }
        this.#setState({
          ...this.#state,
          phase: 'reconnecting',
          errorCode: safe.code.toLowerCase(),
        });
        const backoff = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)];
        failures += 1;
        await delay(withJitter(backoff), signal);
      }
    }
  }

  async #taskPump(
    binding: WechatActiveBinding,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    while (!signal.aborted && this.#isGenerationCurrent(generation)) {
      await this.#pollBarrier;
      const task = await this.#requireStore().leaseNextTask({
        bindingEpoch: binding.bindingEpoch,
        now: this.#now(),
      });
      if (!task) {
        await delay(IDLE_PUMP_DELAY_MS, signal);
        continue;
      }
      try {
        await this.#processTask(task);
      } catch (error) {
        this.log.warn('WeChat task processing failed', {
          task: shortId(task.id),
          code: machineErrorCode(error),
        });
        const interrupted = await this.#requireStore().commitInterrupted({
          bindingEpoch: task.bindingEpoch,
          taskId: task.id,
          now: this.#now(),
          errorCode: machineErrorCode(error),
        });
        if (!interrupted) {
          await this.#requireStore().releaseDispatch(task.bindingEpoch, task.id);
        }
      }
      this.#setState({
        ...this.#state,
        queuedTasks: await this.#requireStore().countQueuedTasks(binding.bindingEpoch),
      });
    }
  }

  async #processTask(task: WechatTask): Promise<void> {
    const runtime = this.#turnRuntime;
    if (!runtime) throw new Error('WECHAT_TURN_RUNTIME_NOT_ATTACHED');
    const payload = parseTaskPayload(task.payloadJson);
    const command = payload.text.trim();
    if (
      this.#pendingInteractions.has(task.peerId) &&
      command !== '/stop' &&
      command !== '/stop all'
    ) {
      await this.#processInteractionReply(task, payload.text);
      return;
    }
    if (command === '/stop' || command === '/stop all') {
      const pending = this.#pendingInteractions.get(task.peerId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(defaultWechatInteractionDecision(pending.request, 'wechat_user_stopped'));
        this.#pendingInteractions.delete(task.peerId);
      }
    }
    if (command.startsWith('/')) {
      await this.#processCommand(task, command);
      return;
    }
    const prompt =
      payload.unsupportedMedia.length > 0
        ? `${payload.text}\n\n（微信消息还包含当前版本暂不支持的媒体，本轮仅处理文字。）`
        : payload.text;
    if (!hasWechatTaskContent(prompt, payload.attachments)) {
      await this.#commitSimpleReply(task, '当前版本暂不支持处理这类微信媒体。');
      return;
    }

    const active: ActiveTask = { task, terminalCommitted: false };
    this.#activeTasks.set(task.peerId, active);
    const stopTyping = await this.#startTyping(task);
    let dispatch;
    try {
      dispatch = await runtime.runner.dispatchAgentTurn({
        botContextId: this.#epoch?.credentials.ilinkBotId ?? '',
        userId: task.peerId,
        userMessageId: task.id,
        text: prompt,
        attachments: payload.attachments,
        queueMode: 'external',
        beforeProviderStart: async () => {
          const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
          if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');
        },
        onRouteResolved: (sessionId) => {
          if (this.#activeTasks.get(task.peerId) === active) {
            active.routeSessionId = sessionId;
          }
        },
        turnPermissionPolicy: createWechatTurnPermissionPolicy(task.id, {
          onInteractionStateChange: (state) => {
            void this.#requireStore().setWaitingDesktop(
              task.bindingEpoch,
              task.id,
              state === 'waiting',
            );
          },
        }),
      });
    } catch (error) {
      await stopTyping();
      throw error;
    }

    if (dispatch.kind !== 'accepted') {
      await stopTyping();
      this.#activeTasks.delete(task.peerId);
      if (dispatch.kind === 'busy') {
        await this.#requireStore().releaseDispatch(task.bindingEpoch, task.id);
        await delay(IDLE_PUMP_DELAY_MS);
      } else {
        await this.#commitPreDispatchFailure(task, dispatch.reason);
      }
      return;
    }
    let terminal;
    try {
      terminal = await dispatch.terminal;
    } finally {
      await stopTyping();
    }
    this.#activeTasks.delete(task.peerId);
    if (!active.terminalCommitted) {
      await this.#requireStore().commitInterrupted({
        bindingEpoch: task.bindingEpoch,
        taskId: task.id,
        now: this.#now(),
        errorCode: safeMachineCode(terminal.errorCode ?? 'terminal_output_missing'),
      });
    }
    await this.#flushCurrentOutbox(task.bindingEpoch);
  }

  async #processInteractionReply(task: WechatTask, text: string): Promise<void> {
    const pending = this.#pendingInteractions.get(task.peerId);
    if (!pending) return;
    const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
    if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');
    const decision = parseWechatInteractionReply(pending.request, text);
    if (!decision) {
      await this.#commitInteractionReply(
        task,
        '回复格式不正确。请按上一条消息提示回复；权限确认只支持“允许”或“拒绝”。',
      );
      await this.#flushCurrentOutbox(task.bindingEpoch);
      return;
    }
    clearTimeout(pending.timer);
    this.#pendingInteractions.delete(task.peerId);
    pending.resolve(decision);
    await this.#commitAcceptedReply(task, '已收到你的选择，继续处理。');
    await this.#flushCurrentOutbox(task.bindingEpoch);
  }

  async #handleInteractionReplyMessage(
    message: WechatInboundMessage,
    transport: WechatTransport,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = this.#pendingInteractions.get(message.senderId);
    if (!pending) return;
    const decision = parseWechatInteractionReply(pending.request, message.text);
    if (decision) {
      clearTimeout(pending.timer);
      this.#pendingInteractions.delete(message.senderId);
      pending.resolve(decision);
    }
    try {
      await transport.sendMessage(
        {
          peerId: message.senderId,
          text: decision
            ? '已收到你的选择，继续处理。'
            : '回复格式不正确。请按上一条消息提示回复；权限确认只支持“允许”或“拒绝”。',
          contextToken: message.contextToken,
          clientId: randomUUID(),
        },
        signal,
      );
    } catch {
      // Interaction acknowledgement is best effort; the decision itself has
      // already been correlated in memory and the agent will produce its next
      // durable response.
    }
  }

  async #commitInteractionReply(task: WechatTask, text: string): Promise<void> {
    const result = await this.#requireStore().commitTerminal({
      bindingEpoch: task.bindingEpoch,
      taskId: task.id,
      now: this.#now(),
      outbox: chunkWechatText(text).map((chunk, index) => ({
        id: randomUUID(),
        clientId: randomUUID(),
        kind: 'final',
        chunkIndex: index,
        text: chunk,
      })),
    });
    if (!result.committed) throw new Error('WECHAT_INTERACTION_REPLY_REJECTED');
  }

  async #startTyping(task: WechatTask): Promise<() => Promise<void>> {
    const epoch = this.#epoch;
    if (!epoch || this.#compatibilityDisabled || epoch.abort.signal.aborted) {
      return async () => undefined;
    }
    let ticket: string;
    try {
      ticket = await epoch.transport.getTypingTicket(
        task.peerId,
        task.contextToken,
        epoch.abort.signal,
      );
      await epoch.transport.setTyping(task.peerId, ticket, true, epoch.abort.signal);
    } catch {
      return async () => undefined;
    }

    let stopped = false;
    let busy = false;
    let nextHeartbeatAt = this.#now() + 60_000;
    const timer = setInterval(() => {
      if (stopped || busy || this.#compatibilityDisabled || epoch.abort.signal.aborted) return;
      busy = true;
      void (async () => {
        try {
          await epoch.transport.setTyping(task.peerId, ticket, true, epoch.abort.signal);
          if (this.#now() >= nextHeartbeatAt) {
            await epoch.transport.sendMessage(
              {
                peerId: task.peerId,
                text: '任务仍在处理中…',
                contextToken: task.contextToken,
                clientId: randomUUID(),
              },
              epoch.abort.signal,
            );
            nextHeartbeatAt = this.#now() + 120_000;
          }
        } catch {
          // Presence is best effort and must never fail the task.
        } finally {
          busy = false;
        }
      })();
    }, 5_000);
    timer.unref?.();

    return async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        await epoch.transport.setTyping(task.peerId, ticket, false, epoch.abort.signal);
      } catch {
        // Best-effort presence cleanup.
      }
    };
  }

  async #processCommand(task: WechatTask, command: string): Promise<void> {
    const runtime = this.#turnRuntime;
    if (!runtime) throw new Error('WECHAT_TURN_RUNTIME_NOT_ATTACHED');
    if (/^\/permission(?:\s|$)/.test(command)) {
      await this.#processPermissionCommand(task, command, runtime);
      return;
    }
    switch (command) {
      case '/help':
        await this.#commitSimpleReply(
          task,
          '可用命令：/new 新对话；/stop 中止当前执行；/stop all 中止全部执行；/status 查看状态；/help 查看帮助。',
        );
        return;
      case '/status':
        await this.#commitSimpleReply(
          task,
          `Cindy 微信连接正常，当前队列 ${this.#state.queuedTasks} 条。`,
        );
        return;
      case '/stop':
      case '/stop all':
        await this.#commitSimpleReply(task, '已停止任务。');
        return;
      case '/new': {
        const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
        if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');
        const prepared = await runtime.repo.prepareNewSession(
          this.#epoch?.credentials.ilinkBotId ?? '',
          task.peerId,
        );
        const existing = await runtime.repo.findActiveSession(
          this.#epoch?.credentials.ilinkBotId ?? '',
          task.peerId,
        );
        const row =
          existing ??
          (await runtime.repo.createSession(
            this.#epoch?.credentials.ilinkBotId ?? '',
            task.peerId,
            undefined,
            prepared,
          ));
        if (existing) {
          await runtime.resetSessionToDefaults(row.id, runtime.config, prepared);
        }
        await runtime.runner.disposeOneSession(row.id);
        await this.#requireStore().advanceConversationEpoch(
          task.bindingEpoch,
          task.id,
          task.peerId,
        );
        const active: ActiveTask = { task, terminalCommitted: false };
        this.#activeTasks.set(task.peerId, active);
        await this.commitFinal({
          userId: task.peerId,
          text: '已开始一段新对话。',
          terminal: 'done',
        });
        this.#activeTasks.delete(task.peerId);
        await this.#flushCurrentOutbox(task.bindingEpoch);
        return;
      }
      default:
        await this.#commitSimpleReply(task, '未知命令。发送 /help 查看可用命令。');
    }
  }

  async #processPermissionCommand(
    task: WechatTask,
    command: string,
    runtime: TurnRuntime,
  ): Promise<void> {
    const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
    if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');

    const botContextId = this.#epoch?.credentials.ilinkBotId ?? '';
    const target = await runtime.runner.resolveRouteTarget(botContextId, task.peerId);
    let reply: string;
    if (!target) {
      reply = ui.agent.apiKeyMissing;
    } else {
      const context = permissionModeCommandContext(
        target.row.id,
        target.row.permissionMode,
        runtime.runner.getPermissionModes(target.row.agentKind),
      );
      const [, rawMode, rawConfirmation] = command.split(/\s+/);
      if (!rawMode) {
        reply = renderTextPermissionModePicker(ui, context);
      } else {
        const mode = resolvePermissionMode(context.modes, rawMode);
        if (!mode) {
          reply = renderTextPermissionModePicker(ui, context);
        } else {
          const result = await runtime.runner.changePermissionMode({
            sessionId: target.row.id,
            mode: mode.id,
            modes: context.modes,
            confirmedFullAccess: ['confirm', '确认'].includes(rawConfirmation?.toLowerCase()),
          });
          reply = renderTextPermissionModeResult(ui, result);
        }
      }
    }

    await this.#commitAcceptedReply(task, reply);
    await this.#flushCurrentOutbox(task.bindingEpoch);
  }

  async #commitSimpleReply(task: WechatTask, text: string): Promise<void> {
    const accepted = await this.#requireStore().markAccepted(task.bindingEpoch, task.id);
    if (!accepted) throw new Error('WECHAT_ACCEPT_CAS_REJECTED');
    await this.#commitAcceptedReply(task, text);
    await this.#flushCurrentOutbox(task.bindingEpoch);
  }

  async #commitAcceptedReply(task: WechatTask, text: string): Promise<void> {
    const existing = this.#activeTasks.get(task.peerId);
    if (existing && existing.task.id !== task.id) {
      await this.#commitInteractionReply(task, text);
      return;
    }
    const active: ActiveTask = { task, terminalCommitted: false };
    this.#activeTasks.set(task.peerId, active);
    try {
      await this.commitFinal({ userId: task.peerId, text, terminal: 'done' });
    } finally {
      this.#activeTasks.delete(task.peerId);
    }
  }

  async #commitPreDispatchFailure(task: WechatTask, reason: string): Promise<void> {
    const text = wechatPreDispatchFailureText(reason);
    const chunks = chunkWechatText(text);
    await this.#requireStore().commitPreDispatchFailure({
      bindingEpoch: task.bindingEpoch,
      taskId: task.id,
      now: this.#now(),
      errorCode: safeMachineCode(reason),
      outbox: chunks.map((chunk, index) => ({
        id: randomUUID(),
        clientId: randomUUID(),
        kind: 'error',
        chunkIndex: index,
        text: chunk,
      })),
    });
    await this.#flushCurrentOutbox(task.bindingEpoch);
  }

  async #outboxLoop(
    binding: WechatActiveBinding,
    transport: WechatTransport,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    while (!signal.aborted && this.#isGenerationCurrent(generation)) {
      await this.#flushOutbox(transport, binding.bindingEpoch, signal);
      await delay(1_000, signal);
    }
  }

  async #flushCurrentOutbox(bindingEpoch: string): Promise<void> {
    const epoch = this.#epoch;
    if (!epoch || epoch.binding.bindingEpoch !== bindingEpoch) return;
    await this.#flushOutbox(epoch.transport, bindingEpoch, epoch.abort.signal);
  }

  async #flushOutbox(
    transport: WechatTransport,
    bindingEpoch: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.#isSendEpochCurrent(bindingEpoch, signal)) return;
    const store = this.#requireStore();
    for (const item of await store.listDueOutbox(bindingEpoch, this.#now())) {
      if (!this.#isSendEpochCurrent(bindingEpoch, signal)) return;
      for (let immediateAttempt = 0; immediateAttempt < 3; immediateAttempt += 1) {
        if (!this.#isSendEpochCurrent(bindingEpoch, signal)) return;
        if (!(await store.claimOutbox(bindingEpoch, item.id))) break;
        if (!this.#isSendEpochCurrent(bindingEpoch, signal)) {
          await store.recordOutboxFailure({
            bindingEpoch,
            outboxId: item.id,
            nextRetryAt: this.#now(),
            terminal: false,
            errorCode: 'ABORTED',
          });
          return;
        }
        try {
          await this.#sendOutboxItem(transport, bindingEpoch, item, signal);
          await store.markOutboxDelivered(bindingEpoch, item.id, this.#now());
          break;
        } catch (error) {
          const failure = classifyOutboxSendError(error);
          const retryNow = failure.retryable && immediateAttempt < 2;
          await store.recordOutboxFailure({
            bindingEpoch,
            outboxId: item.id,
            nextRetryAt: failure.retryable
              ? retryNow
                ? this.#now()
                : this.#now() + retryDelay(item.attempts + immediateAttempt + 1)
              : this.#now(),
            terminal: !failure.retryable,
            errorCode: failure.code,
          });
          if (failure.code === 'AUTH_REPLACED' || failure.code === 'AUTH_EXPIRED') {
            this.#setState({
              ...this.#state,
              phase: 'needs_reauth',
              errorCode: failure.code.toLowerCase(),
            });
            return;
          }
          if (!retryNow) break;
        }
      }
    }
  }

  async #sendOutboxItem(
    transport: WechatTransport,
    bindingEpoch: string,
    item: Awaited<ReturnType<WechatTaskStore['listDueOutbox']>>[number],
    signal: AbortSignal,
  ): Promise<void> {
    this.#assertSendEpochCurrent(bindingEpoch, signal);
    const peerId = await this.#peerIdForTask(bindingEpoch, item.taskId);
    this.#assertSendEpochCurrent(bindingEpoch, signal);
    if (item.text) {
      await transport.sendMessage(
        {
          peerId,
          text: item.text,
          contextToken: item.contextToken,
          clientId: item.clientId,
        },
        signal,
      );
    }
    for (const media of parseOutboxMedia(item.mediaJson)) {
      this.#assertSendEpochCurrent(bindingEpoch, signal);
      const local = await readOutboundWechatFile(media.absPath);
      this.#assertSendEpochCurrent(bindingEpoch, signal);
      const uploaded = await transport.uploadMedia(
        {
          peerId,
          bytes: local.bytes,
          fileName: local.fileName,
          kind: local.kind,
        },
        signal,
      );
      this.#assertSendEpochCurrent(bindingEpoch, signal);
      await transport.sendMedia(
        {
          peerId,
          contextToken: item.contextToken,
          clientId: media.clientId,
          uploaded,
        },
        signal,
      );
    }
  }

  async #peerIdForTask(bindingEpoch: string, taskId: string): Promise<string> {
    const row = await this.#deps.getDbClient().queryOne<{ peerId: string }>(
      `SELECT peer_id AS peerId
       FROM wechat_inbox
       WHERE binding_epoch = ? AND id = ?`,
      [bindingEpoch, taskId],
    );
    if (!row?.peerId) throw new Error('WECHAT_OUTBOX_TASK_MISSING');
    return row.peerId;
  }

  async #toTaskInput(
    bindingEpoch: string,
    message: WechatInboundMessage,
    transport: WechatTransport,
    signal: AbortSignal,
    receivedAt: number,
    index: number,
  ) {
    const runtime = this.#turnRuntime;
    if (!runtime) throw new Error('WECHAT_TURN_RUNTIME_NOT_ATTACHED');
    const botId = this.#epoch?.credentials.ilinkBotId ?? 'wechat';
    const prepared = await runtime.repo.prepareNewSession(botId, message.senderId);
    const existing = await runtime.repo.findActiveSession(botId, message.senderId);
    const session =
      existing ?? (await runtime.repo.createSession(botId, message.senderId, undefined, prepared));
    const epoch = await this.#requireStore().getConversationEpoch(bindingEpoch, message.senderId);
    const taskId = randomUUID();
    const staged = await stageWechatTaskMedia({
      bindingEpoch,
      taskId,
      sessionId: session.id,
      media: [...(message.quote?.media ?? []), ...message.media],
      transport,
      signal,
      now: receivedAt,
    });
    const quote = formatWechatQuote(message);
    return {
      message: {
        id: taskId,
        platformMessageId: message.messageId,
        platformSeq: platformSequence(message, receivedAt, index),
        peerId: message.senderId,
        receivedAt,
        platformCreatedAt: message.createdAt ?? receivedAt,
        sessionId: session.id,
        conversationEpoch: epoch,
        payloadJson: JSON.stringify({
          text: quote ? `${quote}\n${message.text}`.trim() : message.text,
          attachments: staged.attachments,
          unsupportedMedia: staged.unsupportedMedia,
        } satisfies WechatTaskPayload),
        contextToken: message.contextToken,
        overloadReply: {
          outboxId: randomUUID(),
          clientId: randomUUID(),
          text: '当前微信任务较多，请稍后再试。',
        },
      },
      mediaBlobs: staged.mediaBlobs,
      mediaRefs: staged.mediaRefs,
      fileAttachments: staged.fileAttachments,
    };
  }

  async #readActiveBindingWithoutKey(): Promise<WechatActiveBinding | null> {
    const row = await this.#deps.getDbClient().queryOne<{
      bindingEpoch: string;
      cursor: string;
    }>(
      `SELECT binding_epoch AS bindingEpoch, sync_cursor AS cursor
       FROM wechat_sync_state
       WHERE is_active = 1
       LIMIT 1`,
    );
    return row ?? null;
  }

  #readDataKey(): Buffer | null {
    const raw = this.host.secrets.read(DATA_KEY_NAME);
    if (!raw) return null;
    try {
      const key = Buffer.from(raw, 'base64');
      return key.byteLength === 32 ? key : null;
    } catch {
      return null;
    }
  }

  #readCredentials(bindingEpoch: string): StoredWechatCredentials | null {
    const raw = this.host.secrets.read(`${CREDENTIAL_PREFIX}${bindingEpoch}`);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<StoredWechatCredentials>;
      return value.bindingEpoch === bindingEpoch &&
        typeof value.botToken === 'string' &&
        value.botToken &&
        typeof value.ilinkBotId === 'string' &&
        value.ilinkBotId &&
        typeof value.userId === 'string' &&
        value.userId &&
        typeof value.baseUrl === 'string' &&
        value.baseUrl.startsWith('https://') &&
        typeof value.boundAt === 'number'
        ? (value as StoredWechatCredentials)
        : null;
    } catch {
      return null;
    }
  }

  #requireStore(): WechatTaskStore {
    if (!this.#store) throw new Error('WECHAT_STORE_NOT_READY');
    return this.#store;
  }

  #queueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycleBarrier.then(operation);
    this.#lifecycleBarrier = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #isCompatibilityRevisionCurrent(revision: number): boolean {
    return revision === this.#compatibilityRevision;
  }

  #isCompatibilityRevisionAllowed(revision: number): boolean {
    return this.#isCompatibilityRevisionCurrent(revision) && !this.#compatibilityDisabled;
  }

  #isSendEpochCurrent(bindingEpoch: string, signal: AbortSignal): boolean {
    const epoch = this.#epoch;
    return (
      !this.#compatibilityDisabled &&
      !signal.aborted &&
      epoch?.binding.bindingEpoch === bindingEpoch &&
      epoch.abort.signal === signal
    );
  }

  #assertSendEpochCurrent(bindingEpoch: string, signal: AbortSignal): void {
    if (!this.#isSendEpochCurrent(bindingEpoch, signal)) {
      throw new WechatIlinkError('ABORTED', 'The WeChat send epoch was stopped.', true);
    }
  }

  #isGenerationCurrent(generation: number): boolean {
    return this.#deps.isAccountGenerationCurrent(generation);
  }

  #setState(state: Omit<WechatBotState, 'bound'>): void {
    this.#state = state;
    this.host.ipc.broadcast('wechatBot:state-changed', this.getState());
    const status = this.getStatus();
    for (const handler of this.#statusHandlers) handler(status);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

export const WECHAT_AUTH_BASE_URL = AUTH_BASE_URL;

export function sessionIdFor(botId: string, peerId: string): string {
  const digest = createHash('sha256').update(`${botId}\0${peerId}`).digest('hex').slice(0, 32);
  return `wechat_${digest}`;
}

function parseTaskPayload(raw: string): WechatTaskPayload {
  const value = JSON.parse(raw) as Partial<WechatTaskPayload>;
  const attachments = value.attachments ?? [];
  if (
    typeof value.text !== 'string' ||
    !Array.isArray(attachments) ||
    !attachments.every(isWechatTaskAttachment) ||
    !Array.isArray(value.unsupportedMedia) ||
    !value.unsupportedMedia.every((item) => typeof item === 'string')
  ) {
    throw new Error('WECHAT_TASK_PAYLOAD_INVALID');
  }
  return {
    text: value.text,
    attachments,
    unsupportedMedia: value.unsupportedMedia,
  };
}

function isWechatTaskAttachment(value: unknown): value is WechatTaskAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<WechatTaskAttachment>;
  return (
    (item.kind === 'image' || item.kind === 'file') &&
    (item.storage === 'cindy-media' || item.storage === 'file') &&
    typeof item.absPath === 'string' &&
    typeof item.originalName === 'string' &&
    typeof item.mimeType === 'string' &&
    (item.url === undefined || typeof item.url === 'string')
  );
}

function formatWechatQuote(message: WechatInboundMessage): string {
  const quote = message.quote;
  if (!quote) return '';
  const details = [quote.title?.trim(), quote.text?.trim()].filter((item): item is string =>
    Boolean(item),
  );
  if (quote.media.length > 0) details.push(`附件 ${quote.media.length} 个`);
  return details.length > 0 ? `[引用：${details.join('｜')}]` : '';
}

function platformSequence(
  message: WechatInboundMessage,
  receivedAt: number,
  index: number,
): number {
  const parsed = Number.parseInt(message.messageId, 10);
  if (Number.isSafeInteger(parsed)) return parsed;
  return (message.createdAt ?? receivedAt) * 100 + index;
}

function acceptedPollTaskIds(
  result: Awaited<ReturnType<WechatTaskStore['commitPollBatch']>>,
): ReadonlySet<string> {
  if (!result.committed) return new Set();
  const rejected = new Set(result.rejectedTaskIds);
  return new Set(result.insertedTaskIds.filter((taskId) => !rejected.has(taskId)));
}

const PERMANENT_OUTBOX_ERROR_CODES = new Set([
  'ENOENT',
  'WECHAT_FILE_EMPTY',
  'WECHAT_FILE_TOO_LARGE',
  'WECHAT_OUTBOX_MEDIA_INVALID',
  'WECHAT_OUTBOX_TASK_MISSING',
]);

function classifyOutboxSendError(error: unknown): { code: string; retryable: boolean } {
  const explicitCode =
    error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : '';
  const localCode = explicitCode || (error instanceof Error ? error.message : '');
  if (PERMANENT_OUTBOX_ERROR_CODES.has(localCode)) {
    return { code: safeMachineCode(localCode), retryable: false };
  }
  const safe = asWechatIlinkError(error);
  return { code: safe.code, retryable: safe.retryable };
}

async function stopActiveWechatTurns(
  runner: ImTurnRunner | null,
  botContextId: string,
  peerIds: Iterable<string>,
): Promise<void> {
  if (!runner) return;
  await Promise.all(
    [...new Set(peerIds)].map((userId) => runner.stopActiveTurn({ botContextId, userId })),
  );
}

function retryDelay(attempt: number): number {
  return [1_000, 5_000, 30_000, 120_000][Math.min(Math.max(attempt - 1, 0), 3)];
}

interface OutboxMedia {
  absPath: string;
  clientId: string;
}

function parseOutboxMedia(raw: string): OutboxMedia[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('WECHAT_OUTBOX_MEDIA_INVALID');
  }
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    !value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Partial<OutboxMedia>).absPath === 'string' &&
        path.isAbsolute((item as Partial<OutboxMedia>).absPath!) &&
        typeof (item as Partial<OutboxMedia>).clientId === 'string' &&
        (item as Partial<OutboxMedia>).clientId!.length > 0,
    )
  ) {
    throw new Error('WECHAT_OUTBOX_MEDIA_INVALID');
  }
  return value as OutboxMedia[];
}

async function readOutboundWechatFile(
  absPath: string,
  displayName?: string,
): Promise<{
  bytes: Uint8Array;
  fileName: string;
  kind: 'image' | 'video' | 'file';
}> {
  if (!path.isAbsolute(absPath)) {
    throw Object.assign(new Error('WeChat outbound path must be absolute.'), {
      code: 'ENOENT',
    });
  }
  const handle = await fs.open(absPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw Object.assign(new Error('WeChat outbound path is not a regular file.'), {
        code: 'ENOENT',
      });
    }
    if (stat.size === 0) {
      throw Object.assign(new Error('WeChat outbound file is empty.'), {
        code: 'WECHAT_FILE_EMPTY',
      });
    }
    if (stat.size > WECHAT_MEDIA_MAX_BYTES) {
      throw Object.assign(new Error('WeChat outbound file exceeds 5 MB.'), {
        code: 'WECHAT_FILE_TOO_LARGE',
      });
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) {
      throw new Error('WECHAT_OUTBOUND_FILE_CHANGED');
    }
    return {
      bytes,
      fileName: sanitizeOutboundFileName(displayName ?? path.basename(absPath)),
      kind: detectOutboundWechatKind(bytes),
    };
  } finally {
    await handle.close();
  }
}

function sanitizeOutboundFileName(input: string): string {
  const value = path
    .basename(input.normalize('NFKC'))
    .replace(/\p{Cc}/gu, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180);
  return value || 'cindy-file.bin';
}

function detectOutboundWechatKind(bytes: Uint8Array): 'image' | 'video' | 'file' {
  const ascii = (offset: number, value: string): boolean =>
    bytes.length >= offset + value.length &&
    Array.from(value).every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 'PNG\r\n\u001a\n')) ||
    ascii(0, 'GIF87a') ||
    ascii(0, 'GIF89a') ||
    (ascii(0, 'RIFF') && ascii(8, 'WEBP'))
  ) {
    return 'image';
  }
  return ascii(4, 'ftyp') ? 'video' : 'file';
}

function withJitter(value: number): number {
  return Math.round(value * (0.8 + Math.random() * 0.4));
}

function shortId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function safeMachineCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .slice(0, 64);
  return normalized || 'PRE_DISPATCH_REJECTED';
}

/**
 * 派发前失败的用户可见文案(纯函数,便于单测)。reason 来源:
 *  - `${WECHAT_TURN_PERMISSION_POLICY_UNSUPPORTED}:agent:<mode>` — Agent 未声明
 *    turnPermissionPolicy(如 Pi),任何模式都不可用 → 引导换 Agent;
 *  - `${WECHAT_TURN_PERMISSION_POLICY_UNSUPPORTED}:mode:<mode>` — 当前权限模式
 *    在该 Agent 的 unsupportedPermissionModes 里 → 引导换权限模式;
 *  - 旧格式 `TURN_PERMISSION_POLICY_UNSUPPORTED:<mode>` / `unsupported_turn_permission`
 *    保持既有兼容行为,兜底按「换权限模式」处理;
 *  - 'missing_auth' — 未连接模型服务;
 *  - 其余 — 通用重试提示。
 */
export function wechatPreDispatchFailureText(reason: string): string {
  if (reason.includes(`${WECHAT_TURN_PERMISSION_POLICY_UNSUPPORTED}:agent`)) {
    // 当前权限模式若是换 Agent 后仍不兼容的档位(bypassPermissions / acceptEdits),
    // 仅换 Agent 会在新 Agent 上再次命中权限模式错误,补一条 /permission 提示。
    const mode = reason.split(':').pop() ?? '';
    if (mode === 'bypassPermissions' || mode === 'acceptEdits') {
      return `${ui.error.agentUnsupported}\n${ui.error.agentSwitchAlsoCheckPermissionMode}`;
    }
    return ui.error.agentUnsupported;
  }
  if (
    reason.includes(WECHAT_TURN_PERMISSION_POLICY_UNSUPPORTED) ||
    reason.includes('unsupported_turn_permission')
  ) {
    return ui.error.permissionModeUnsupported;
  }
  if (reason === 'missing_auth') {
    return '当前 Agent 尚未完成授权，请先在 Cindy 中连接模型服务。';
  }
  return '这条消息暂时无法启动，请稍后重试。';
}

function normalizeFinalOutputText(text: string): string {
  return filterWechatMarkdown(text) || '✅ (本轮无文本输出)';
}

function hasWechatTaskContent(text: string, attachments: readonly WechatTaskAttachment[]): boolean {
  return text.trim().length > 0 || attachments.length > 0;
}

function formatWechatInteractionPrompt(request: InteractionRequest): string {
  if (request.kind === 'permission') {
    return `需要确认工具“${request.displayName ?? request.toolName}”。
回复“允许”执行一次，或回复“拒绝”取消本次操作。微信内不支持永久授权。`;
  }
  if (request.kind === 'plan_review') {
    const plan = request.plan.length > 6_000 ? `${request.plan.slice(0, 6_000)}…` : request.plan;
    return `Agent 提交了一份执行计划：

${plan}

回复“批准”继续，或回复“拒绝”取消。`;
  }
  const question = request.questions[0];
  if (!question) return 'Agent 正在等待你的回答，但没有可显示的问题。请回复“继续”。';
  const options = (question.options ?? [])
    .slice(0, 9)
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join('\n');
  return `Agent 需要你的回答：
${question.question}
${options ? `\n${options}\n` : ''}
请回复选项序号，或直接输入你的回答。`;
}

function defaultWechatInteractionDecision(
  request: InteractionRequest,
  reason: string,
): InteractionDecision {
  if (request.kind === 'ask_user_question') {
    return { kind: 'ask_user_question', answers: {} };
  }
  if (request.kind === 'plan_review') {
    return { kind: 'plan_review', behavior: 'deny', reason };
  }
  return { kind: 'permission', behavior: 'deny', reason };
}

function parseWechatInteractionReply(
  request: InteractionRequest,
  rawText: string,
): InteractionDecision | null {
  const text = rawText.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (request.kind === 'permission') {
    if (['允许', '同意', '确认', 'allow', 'yes', 'y'].includes(normalized)) {
      return { kind: 'permission', behavior: 'allow' };
    }
    if (['拒绝', '不允许', '取消', 'deny', 'no', 'n'].includes(normalized)) {
      return { kind: 'permission', behavior: 'deny', reason: 'wechat_user_denied' };
    }
    return null;
  }
  if (request.kind === 'plan_review') {
    if (['批准', '同意', '确认', '继续', 'approve', 'allow', 'yes', 'y'].includes(normalized)) {
      return { kind: 'plan_review', behavior: 'allow' };
    }
    if (['拒绝', '取消', 'deny', 'no', 'n'].includes(normalized)) {
      return { kind: 'plan_review', behavior: 'deny', reason: 'wechat_user_denied' };
    }
    return null;
  }
  const question = request.questions[0];
  if (!question) return { kind: 'ask_user_question', answers: {} };
  const index = Number.parseInt(text, 10);
  const option = Number.isInteger(index) && index >= 1 ? question.options?.[index - 1] : undefined;
  return {
    kind: 'ask_user_question',
    answers: { [question.question]: option?.label ?? text },
  };
}

function authorizationCancelPhase(hasEpoch: boolean, hasBinding: boolean): WechatBotPhase {
  if (hasEpoch) return 'connected';
  return hasBinding ? 'needs_reauth' : 'disconnected';
}

function machineErrorCode(error: unknown): string {
  return error instanceof Error ? safeMachineCode(error.message) : 'unknown_error';
}

export const __testing = {
  activePeerIdForSession,
  acceptedPollTaskIds,
  authorizationCancelPhase,
  classifyOutboxSendError,
  hasWechatTaskContent,
  normalizeFinalOutputText,
  formatWechatInteractionPrompt,
  parseWechatInteractionReply,
  stopActiveWechatTurns,
  wechatPreDispatchFailureText,
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
