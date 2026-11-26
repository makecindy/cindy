/**
 * One Cindy task running on one ACP agent endpoint.
 *
 * `openAcpSession` performs the v1 handshake (initialize → session/new, or
 * session/resume / session/load for an existing task) over a host-provided
 * transport and returns an `AcpSession` whose methods match the
 * `AgentSessionHandle` contract used by Cindy's built-in engines. Wiring it into
 * Maker / Desktop is a separate step; this module has no host dependencies.
 */

import { randomUUID } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../../interfaces/logger.js';
import {
  TurnPermissionPolicyUnsupportedError,
  type AgentSessionHandle,
  type SendOptions,
  type TakeMcpToolResult,
  type TurnPermissionPolicy,
} from '../base-agent.js';
import { NotSupportedError, type Capabilities } from '../../types/capabilities.js';
import type { Effort, PermissionMode, UserContentBlock, UserMessage } from '../../types/common.js';
import type { AgentEvent, InteractionRequest, InteractionResolver, UsageSnapshot } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import {
  ACP_SUPPORTED_PERMISSION_MODES,
  findModeOption,
  mapModeValues,
  buildAcpCapabilities,
  currentEffort,
  findEffortOption,
  findModelOption,
  mapEffortValues,
} from './capabilities.js';
import { AcpConnection, AcpConnectionClosedError, AcpRpcError, methodNotFound } from './connection.js';
import { defusePluginEngineSlashMentions, isLeadingSlashCommand } from './briefing.js';
import type { AcpLineTransport, AcpTransportClosed } from './line-transport.js';
import {
  ACP_ERROR_AUTH_REQUIRED,
  ACP_PERMISSION_GATE_SCOPE,
  ACP_PROTOCOL_VERSION,
  ACP_STEERING_METHOD,
  JSONRPC_METHOD_NOT_FOUND,
  acpCindyErrorSignals,
  asNonEmptyString,
  readAcpCindyError,
  type AcpCindyError,
  asRecord,
  normalizeAvailableCommandNames,
  normalizeConfigOptions,
  normalizeInitializeResult,
  normalizePermissionOptions,
  normalizeStopReason,
  normalizeToolCallFields,
  normalizeTurnUsage,
  type AcpAuthMethod,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpMcpServer,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpRecord,
  type AcpToolCallFields,
} from './protocol.js';
import { acpToolDisplayName, AcpUpdateTranslator, type AcpTurnOutcome } from './translator.js';

const DEFAULT_CANCEL_GRACE_MS = 15_000;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
/** Matched by the host's no-active-turn handling, which then delivers the message as the next turn. */
const NO_ACTIVE_TURN_TO_STEER = 'No active turn to steer';
/**
 * Work an agent does after answering a prompt (between turns) counts as live for
 * this long after its last update, so the runtime is not reclaimed mid-task.
 */
export const ACP_BACKGROUND_QUIET_MS = 30_000;
/**
 * Tool calls still open between turns are settled after the agent has sent
 * nothing for this long. Agents that wait on purpose (for example a scheduled
 * check minutes later) keep a call open meanwhile; this bound only stops a lost
 * final status from leaving a call running forever.
 */
export const ACP_OPEN_TOOL_QUIET_CAP_MS = 30 * 60_000;
/**
 * A reply the agent writes between turns has no end-of-turn to close it. It is
 * closed once the agent pauses this long, so it is saved and shown like any reply
 * instead of streaming forever and being lost on reload.
 */
export const ACP_BACKGROUND_SEGMENT_IDLE_MS = 2_000;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** `session/update` kinds that describe session state rather than conversation content. */
const STATE_UPDATES: ReadonlySet<unknown> = new Set([
  'config_option_update',
  'usage_update',
  'session_info_update',
  'available_commands_update',
  'current_mode_update',
]);

export interface AcpClientInfo {
  name: string;
  title?: string;
  version: string;
}

/** Display-only facts from the local ACP connection, never a model catalogue or budget. */
export interface AcpReportedModelDetails {
  modelId: string;
  imageInput?: boolean;
  contextWindow?: number;
}

export interface OpenAcpSessionOptions {
  /** Connected to a freshly started endpoint; the session owns and closes it. */
  transport: AcpLineTransport;
  /** Absolute task working directory. */
  cwd: string;
  clientInfo: AcpClientInfo;
  mcpServers?: readonly AcpMcpServer[];
  /**
   * Names in `mcpServers` the task cannot run without (for a task whose files are on another
   * computer, the server that replaces the agent's own file and command tools). An agent that
   * cannot connect to one of them is refused before any session is created.
   */
  requiredMcpServers?: readonly string[];
  /** ACP session id persisted for this task; resumes instead of creating a session. */
  resumeSessionId?: string;
  model?: string;
  /** An explicit companion model must be accepted by this engine before it can receive a message. */
  requireSelectedModel?: boolean;
  effort?: Effort;
  permissionMode?: PermissionMode;
  logger?: Logger;
  requestTimeoutMs?: number;
  /** How long a cancelled prompt may take to settle before Cindy ends the turn itself. */
  cancelGraceMs?: number;
  readFile?: (path: string) => Promise<Uint8Array>;
  /**
   * Host text sent ahead of the first message of a newly created agent session (for example
   * collaboration role instructions; plugin engines get no Cindy system prompt). A resumed or
   * loaded session already has it in its own history, so it is not repeated. A function receives
   * the names of the MCP servers the agent accepted, so the text only names tools it really has.
   */
  briefing?: string | ((acceptedMcpServers: readonly string[]) => string);
  /** Current companion settings for the first prompt after restoring the native conversation. */
  resumedCompanionBriefing?: string;
  /** Lowercase Skill names discovered for this session, so host briefings defuse `/skill` mentions. */
  skillCommandNames?: readonly string[];
  /**
   * Rewrites a message whose text starts with `/<name>` (see skill-invocation.ts); null keeps the
   * text. Called only for such messages, so ordinary messages are sent without waiting on it.
   */
  expandSlashInvocation?: (text: string) => Promise<string | null>;
  /** Called once when the session's event stream ends (closed, or the endpoint exited). */
  onEnded?: () => void;
  /** Backfills empty MCP tool results from the host HTTP MCP bridge when the engine omits them. */
  takeMcpToolResult?: TakeMcpToolResult;
  /** Overrides ACP_OPEN_TOOL_QUIET_CAP_MS (tests). */
  openToolQuietCapMs?: number;
  now?: () => number;
}

export type AcpResumeOutcome = 'new' | 'resumed' | 'loaded';

export class AcpProtocolVersionError extends Error {
  constructor(readonly agentProtocolVersion: number) {
    super(`ACP agent speaks protocol version ${agentProtocolVersion}; Cindy supports ${ACP_PROTOCOL_VERSION}`);
    this.name = 'AcpProtocolVersionError';
  }
}

export class AcpAuthRequiredError extends Error {
  constructor(readonly authMethods: readonly AcpAuthMethod[]) {
    super('The agent needs you to sign in before it can start a session');
    this.name = 'AcpAuthRequiredError';
  }
}

/**
 * The agent refused to open a session because of its account (`error.data._meta.cindy`): used up,
 * signed out or overloaded. The message carries the stable account codes Cindy's failure policy
 * and the chat's error copy already know, never the agent's own text.
 */
export class AcpAccountError extends Error {
  readonly signals: Record<string, unknown>;
  constructor(readonly classified: AcpCindyError, readonly cause?: unknown) {
    super(classified.kind === 'usage-limit'
      ? '[SUBSCRIPTION_ACCOUNT_LIMITED] The plugin engine account has reached its usage limit'
        + (classified.resetsAt !== undefined ? `\nresetAtMs=${classified.resetsAt}` : '')
      : classified.kind === 'auth-required'
        ? '[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The plugin engine account requires login'
        : 'The plugin engine service is currently overloaded');
    this.name = 'AcpAccountError';
    this.signals = acpCindyErrorSignals(classified);
  }
}

/** The agent cannot connect to an MCP server this task depends on. */
export class AcpRequiredMcpUnavailableError extends Error {
  constructor(readonly servers: readonly string[]) {
    super('[PLUGIN_ENGINE_REMOTE_TOOLS_UNSUPPORTED] This plugin engine cannot use the tools of the computer the task is on, so it cannot run this task from another computer.');
    this.name = 'AcpRequiredMcpUnavailableError';
  }
}

/** Retains the task's native identity when its conversation cannot be restored. */
export class AcpResumeUnavailableError extends Error {
  constructor(readonly sessionId: string, readonly why: 'unsupported' | 'failed', readonly cause?: unknown) {
    super('[PLUGIN_ENGINE_RESUME_UNAVAILABLE] The plugin engine could not restore the previous conversation. Your messages are kept. Choose another engine or start a new task.');
    this.name = 'AcpResumeUnavailableError';
  }
}

export function filterMcpServers(
  servers: readonly AcpMcpServer[],
  caps: AcpInitializeResult['agentCapabilities']['mcpCapabilities'],
): { accepted: AcpMcpServer[]; dropped: string[] } {
  const accepted: AcpMcpServer[] = [];
  const dropped: string[] = [];
  for (const server of servers) {
    const type = 'type' in server ? server.type : 'stdio';
    if ((type === 'http' && !caps.http) || (type === 'sse' && !caps.sse)) dropped.push(server.name);
    else accepted.push(server);
  }
  return { accepted, dropped };
}

function authAware(error: unknown, init: AcpInitializeResult): unknown {
  const classified = error instanceof AcpRpcError ? readAcpCindyError(error.data) : null;
  if (classified && classified.kind !== 'auth-required') return new AcpAccountError(classified, error);
  return error instanceof AcpRpcError && (error.code === ACP_ERROR_AUTH_REQUIRED || classified?.kind === 'auth-required')
    ? new AcpAuthRequiredError(init.authMethods)
    : error;
}

/** Routes connection traffic to the session once it exists; earlier content updates are replay and dropped. */
class AcpRouter {
  private target: AcpSession | null = null;
  private buffered: AcpRecord[] = [];
  private replayCutoff = 0;

  notification(method: string, params: AcpRecord): void {
    if (this.target) {
      this.target.handleNotification(method, params);
      return;
    }
    if (method === 'session/update' && STATE_UPDATES.has(asRecord(params.update).sessionUpdate)) this.buffered.push(params);
  }

  async request(method: string, params: AcpRecord, signal: AbortSignal): Promise<unknown> {
    if (this.target) return this.target.handleRequest(method, params, signal);
    if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
    throw methodNotFound(method);
  }

  /** Marks where the session-open response arrived on the wire; later buffered updates are newer than it. */
  markSessionOpened(): void {
    this.replayCutoff = this.buffered.length;
  }

  attach(session: AcpSession, dropConfigUpdates: boolean): void {
    this.target = session;
    const buffered = this.buffered;
    const cutoff = this.replayCutoff;
    this.buffered = [];
    this.replayCutoff = 0;
    for (let i = 0; i < buffered.length; i += 1) {
      const params = buffered[i]!;
      // The handshake response carries the newest configuration up to cutoff; only earlier updates are stale replay.
      const kind = asRecord(params.update).sessionUpdate;
      if (dropConfigUpdates && i < cutoff && (kind === 'config_option_update' || kind === 'current_mode_update')) continue;
      session.handleNotification('session/update', params);
    }
  }
}

export async function openAcpSession(opts: OpenAcpSessionOptions): Promise<AcpSession> {
  const router = new AcpRouter();
  const connection = new AcpConnection(opts.transport, {
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    onNotification: (method, params) => router.notification(method, params),
    onRequest: (method, params, signal) => router.request(method, params, signal),
  });
  try {
    const init = normalizeInitializeResult(await connection.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Phase 1 lets the agent read/write files and run commands itself.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: opts.clientInfo.name, version: opts.clientInfo.version, ...(opts.clientInfo.title ? { title: opts.clientInfo.title } : {}) },
    }));
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpProtocolVersionError(init.protocolVersion);

    const { accepted, dropped } = filterMcpServers(opts.mcpServers ?? [], init.agentCapabilities.mcpCapabilities);
    if (dropped.length > 0) {
      opts.logger?.warn('acp: dropping MCP servers whose transport the agent did not advertise', {
        dropped,
        mcpCapabilities: init.agentCapabilities.mcpCapabilities,
      });
    }
    const missing = (opts.requiredMcpServers ?? []).filter((name) => !accepted.some((server) => server.name === name));
    if (missing.length > 0) throw new AcpRequiredMcpUnavailableError(missing);
    let sessionId: string;
    let outcome: AcpResumeOutcome;
    let result: AcpRecord;
    const onSessionOpened = (): void => router.markSessionOpened();
    if (opts.resumeSessionId) {
      const method = init.agentCapabilities.sessionCapabilities.resume
        ? 'session/resume'
        : init.agentCapabilities.loadSession ? 'session/load' : null;
      if (!method) throw new AcpResumeUnavailableError(opts.resumeSessionId, 'unsupported');
      try {
        result = await connection.request(
          method,
          { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: accepted },
          { onResult: onSessionOpened },
        );
      } catch (error) {
        const mapped = authAware(error, init);
        if (mapped instanceof AcpAuthRequiredError || mapped instanceof AcpAccountError
          || error instanceof AcpConnectionClosedError) throw mapped;
        throw new AcpResumeUnavailableError(opts.resumeSessionId, 'failed', error);
      }
      sessionId = opts.resumeSessionId;
      outcome = method === 'session/resume' ? 'resumed' : 'loaded';
    } else {
      try {
        result = await connection.request(
          'session/new',
          { cwd: opts.cwd, mcpServers: accepted },
          { onResult: onSessionOpened },
        );
      } catch (error) {
        throw authAware(error, init);
      }
      const created = asNonEmptyString(result.sessionId);
      if (!created) throw new Error('ACP session/new returned no sessionId');
      sessionId = created;
      outcome = 'new';
    }

    const acceptedMcpServers = accepted.map((server) => server.name);
    const session = new AcpSession({
      connection,
      init,
      sessionId,
      configOptions: normalizeConfigOptions(result.configOptions),
      resumeOutcome: outcome,
      acceptedMcpServers,
      droppedMcpServers: dropped,
      briefing: outcome === 'new'
        ? typeof opts.briefing === 'function' ? opts.briefing(acceptedMcpServers) : opts.briefing ?? ''
        : '',
      options: opts,
    });
    router.attach(session, Array.isArray(result.configOptions));
    await session.applyInitialSelection(opts.model, opts.effort, opts.permissionMode);
    return session;
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

/**
 * Host restrictions on one prompt, enforced through the agent's permission gate
 * (protocol.ts ACP_PERMISSION_GATE_SCOPE): the agent asks before every tool call.
 */
interface TurnGate {
  policy: TurnPermissionPolicy | null;
  /** Host text-only turn: every tool call is refused, Full access included. */
  toolsDisabled: boolean;
}

interface QueuedPrompt {
  blocks: AcpContentBlock[];
  gate: TurnGate | null;
}

interface ActiveTurn {
  token: number;
  permissionTurnId: string | null;
  contextSelection: string;
  settled: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  gate: TurnGate | null;
}

/** Tool names Cindy's channel rules know, for the ACP v1 tool kinds that have one. */
const ACP_KIND_POLICY_NAMES: Readonly<Record<string, string>> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Grep',
  execute: 'Bash',
  fetch: 'WebFetch',
};

function mergeGates(running: TurnGate, incoming: TurnGate): TurnGate {
  const prior = running.policy;
  const next = incoming.policy;
  // A steered message can add restrictions to the running turn, never remove the current ones.
  const policy = prior && next && prior !== next
    ? { ...next, forceConfirmToolCall: (name: string, input: unknown) =>
        prior.forceConfirmToolCall(name, input) || next.forceConfirmToolCall(name, input) }
    : next ?? prior;
  return { policy, toolsDisabled: running.toolsDisabled || incoming.toolsDisabled };
}

interface AcpSessionInit {
  connection: AcpConnection;
  init: AcpInitializeResult;
  sessionId: string;
  configOptions: AcpConfigOption[];
  resumeOutcome: AcpResumeOutcome;
  acceptedMcpServers: string[];
  droppedMcpServers: string[];
  /** Briefing for a new session, resolved against the accepted MCP servers. */
  briefing: string;
  options: OpenAcpSessionOptions;
}

function selected(option: AcpPermissionOption | undefined): AcpPermissionOutcome {
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}

const ABORTED = Symbol('aborted');

/** Resolves with ABORTED as soon as the signal fires, even if `promise` never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function firstOfKind(options: readonly AcpPermissionOption[], kinds: readonly string[]): AcpPermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  return undefined;
}

export class AcpSession {
  readonly agentKind = 'acp' as const;
  readonly id: string;
  readonly resumeOutcome: AcpResumeOutcome;
  /** MCP servers the agent could not accept (transport not advertised). */
  readonly droppedMcpServers: readonly string[];
  readonly initializeResult: AcpInitializeResult;

  private readonly connection: AcpConnection;
  private readonly logger: Logger | undefined;
  private readonly readImage: (path: string) => Promise<Uint8Array>;
  private readonly expandSlashInvocation: ((text: string) => Promise<string | null>) | undefined;
  private readonly cancelGraceMs: number;
  private readonly onEnded: (() => void) | undefined;
  private readonly queue = createAsyncQueue<AgentEvent>();
  private readonly translator: AcpUpdateTranslator;
  private readonly pendingPrompts: QueuedPrompt[] = [];
  /** Sent once, ahead of the first prompt of a new session. */
  private pendingBriefing: string | null;
  /** Slash-command names advertised by Skills or `available_commands_update`. */
  private readonly commandNames = new Set<string>();
  private sendChain: Promise<void> = Promise.resolve();
  private stopGeneration = 0;
  private readonly permissionControllers = new Set<AbortController>();
  private readonly capabilityListeners = new Set<(capabilities: Capabilities) => void>();
  private configOptions: AcpConfigOption[];
  private reportedContextWindow: number | undefined;
  private reportedSelection = '';
  private contextSelectionPending = 0;
  private modelDetailsListener?: (details: AcpReportedModelDetails | undefined) => void;
  private readonly requireSelectedModel: boolean;
  private readonly initialModel: string;
  private capabilitiesSnapshot: Capabilities;
  /** Advertised `_session/steering`, and has not answered it with method-not-found. */
  private steeringOffered: boolean;
  private permissionMode: 'ask' | 'bypassPermissions' = 'ask';
  /** The Cindy mode the task asked for, reported when a turn policy is refused. */
  private selectedPermissionMode: PermissionMode = 'ask';
  /** The most recent finished turn can still own permission requests while the session is idle. */
  private backgroundPermission: Pick<ActiveTurn, 'permissionTurnId' | 'gate'> | null = null;
  private resolver: InteractionResolver | null = null;
  private turn: ActiveTurn | null = null;
  private turnSeq = 0;
  private permissionSeq = 0;
  private usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
  private title: string | undefined;
  private closing: Promise<void> | null = null;
  private ended = false;
  private detachTransportClose?: () => void;
  private readonly now: () => number;
  private readonly openToolQuietCapMs: number;
  /** Last time the agent produced conversation output while no turn was running. */
  private lastBackgroundAt = 0;
  private openToolCapTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundSegmentTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(init: AcpSessionInit) {
    this.connection = init.connection;
    this.initializeResult = init.init;
    this.id = init.sessionId;
    this.resumeOutcome = init.resumeOutcome;
    this.droppedMcpServers = init.droppedMcpServers;
    this.configOptions = init.configOptions;
    this.requireSelectedModel = init.options.requireSelectedModel === true;
    this.initialModel = this.model;
    this.reportedSelection = this.contextSelection();
    this.steeringOffered = init.init.steering;
    this.capabilitiesSnapshot = this.buildCapabilities();
    this.logger = init.options.logger;
    this.readImage = init.options.readFile ?? ((path) => fsReadFile(path));
    this.expandSlashInvocation = init.options.expandSlashInvocation;
    this.cancelGraceMs = init.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.onEnded = init.options.onEnded;
    this.now = init.options.now ?? Date.now;
    this.openToolQuietCapMs = init.options.openToolQuietCapMs ?? ACP_OPEN_TOOL_QUIET_CAP_MS;
    const briefing = init.resumeOutcome === 'new' ? init.briefing : init.options.resumedCompanionBriefing;
    this.pendingBriefing = briefing?.trim() ? briefing : null;
    for (const name of init.options.skillCommandNames ?? []) {
      const trimmed = name.trim().replace(/^\/+/, '').toLowerCase();
      if (trimmed) this.commandNames.add(trimmed);
    }
    this.translator = new AcpUpdateTranslator({
      blockIdPrefix: `acp-${init.sessionId}`,
      ...(init.options.takeMcpToolResult ? { takeMcpToolResult: init.options.takeMcpToolResult } : {}),
      mcpServerNames: init.acceptedMcpServers,
    });
    if (init.options.permissionMode) this.applyPermissionMode(init.options.permissionMode);
    this.connection.onClose((info) => this.handleConnectionClosed(info));
    // Logical RPC closure cancels requests. Only an endpoint exit can end
    // the product event stream and release the task for a replacement.
    this.detachTransportClose = init.options.transport.onClose((info) => {
      if (info.reason !== 'protocol-error') this.endEvents();
    });
  }

  /** Current model value as the agent reports it; empty when the agent exposes no model option. */
  get model(): string {
    const option = findModelOption(this.configOptions);
    return typeof option?.currentValue === 'string' ? option.currentValue : '';
  }

  /** Names the ACP endpoint advertised after session creation. */
  getPluginEngineCommandNames(): readonly string[] {
    return [...this.commandNames];
  }

  get capabilities(): Capabilities {
    return this.capabilitiesSnapshot;
  }

  /** AgentSessionHandle: Maker prefers these over the agent-level capabilities. */
  get negotiatedCapabilities(): Capabilities {
    return this.capabilitiesSnapshot;
  }

  /** Title the agent published through `session_info_update`, if any. */
  get sessionTitle(): string | undefined {
    return this.title;
  }

  onCapabilitiesChange(listener: (capabilities: Capabilities) => void): () => void {
    this.capabilityListeners.add(listener);
    return () => this.capabilityListeners.delete(listener);
  }

  observeReportedModelDetails(listener: (details: AcpReportedModelDetails | undefined) => void): void {
    if (this.ended) return;
    this.modelDetailsListener = listener;
    this.publishReportedModelDetails();
  }

  private publishReportedModelDetails(): void {
    const imageInput = this.initializeResult.reportedImageInput;
    const contextWindow = this.reportedContextWindow;
    const modelId = this.model;
    this.notifyReportedModelDetails(modelId && (imageInput !== undefined || contextWindow !== undefined) ? {
      modelId,
      ...(imageInput !== undefined ? { imageInput } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    } : undefined);
  }

  private notifyReportedModelDetails(details: AcpReportedModelDetails | undefined): void {
    try {
      this.modelDetailsListener?.(details);
    } catch (error) {
      this.logger?.error('acp: model details listener failed', { error: String(error) });
    }
  }

  private contextSelection(): string {
    return JSON.stringify([this.model, findEffortOption(this.configOptions)?.currentValue, ...this.configOptions
      .filter(option => option.category === 'model_config')
      .map(option => [option.id, option.currentValue])]);
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  getUsageSnapshot(): UsageSnapshot {
    return { ...this.usage };
  }

  getEffort(): Effort | null {
    return currentEffort(findEffortOption(this.configOptions));
  }

  isTurnRunning(): boolean {
    return this.turn !== null;
  }

  /**
   * AgentSessionHandle: the agent is still working after answering its last
   * prompt — a tool call it has not finished, or output within the last
   * ACP_BACKGROUND_QUIET_MS. Runtime reclamation keeps the process meanwhile.
   */
  async hasLiveBackgroundWork(): Promise<boolean> {
    return this.hasBackgroundWork();
  }

  /** The next send reopens this session with `session/resume` or `session/load`; without either a resume fails. */
  canResumeAfterClose(): boolean {
    const { loadSession, sessionCapabilities } = this.initializeResult.agentCapabilities;
    return sessionCapabilities.resume || loadSession;
  }

  private hasBackgroundWork(): boolean {
    if (this.ended || this.turn) return false;
    if (this.translator.openToolCount() > 0) return true;
    return this.lastBackgroundAt > 0 && this.now() - this.lastBackgroundAt <= ACP_BACKGROUND_QUIET_MS;
  }

  setInteractionResolver(resolver: InteractionResolver): void {
    this.resolver = resolver;
  }

  /**
   * AgentSessionHandle: refuses a host turn policy this agent cannot enforce before the turn is
   * accepted, like the built-in engines. Text-only turns on an agent without the permission gate
   * run as before.
   */
  validateSendOptions(opts: SendOptions): void {
    this.turnGate(opts);
  }

  private turnGate(opts: SendOptions | undefined): TurnGate | null {
    const policy = opts?.turnPermissionPolicy ?? null;
    const toolsDisabled = opts?.toolsDisabled === true;
    if (!policy && !toolsDisabled) return null;
    if (!this.initializeResult.permissionGate) {
      if (policy) throw new TurnPermissionPolicyUnsupportedError('acp', this.selectedPermissionMode);
      return null;
    }
    // Full access approves every request, so it cannot carry a policy's confirmations.
    if (policy && this.permissionMode === 'bypassPermissions') {
      throw new TurnPermissionPolicyUnsupportedError('acp', 'bypassPermissions');
    }
    return { policy, toolsDisabled };
  }

  /** Starts a turn, or queues it behind the running one (ACP allows one prompt per session). */
  async send(message: UserMessage, opts?: SendOptions): Promise<void> {
    if (this.ended || this.closing) throw new Error('ACP session is closed');
    const gate = this.turnGate(opts);
    // Attachments are read asynchronously; chain conversions so turns keep the order they were sent in.
    const generation = this.stopGeneration;
    const accepted = this.sendChain.then(async () => {
      const prompt = await this.toPrompt(message);
      if (prompt.length === 0) throw new Error('Cannot send an empty message');
      if (this.ended || this.closing) throw new Error('ACP session is closed');
      // Stop also discards messages that were still being prepared, like queued ones.
      if (generation !== this.stopGeneration) return;
      const firstText = prompt.find((block): block is Extract<AcpContentBlock, { type: 'text' }> => block.type === 'text')?.text ?? '';
      if (this.pendingBriefing && !isLeadingSlashCommand(firstText)) {
        prompt.unshift({ type: 'text', text: defusePluginEngineSlashMentions(this.pendingBriefing, this.commandNames) });
        this.pendingBriefing = null;
      }
      this.pendingPrompts.push({ blocks: prompt, gate });
      this.pump();
    });
    this.sendChain = accepted.catch(() => {});
    return accepted;
  }

  /**
   * Adds the message to the running turn through ACP_STEERING_METHOD. Agents that do
   * not offer it get the message as the next turn, as ACP v1 allows one prompt at a time.
   *
   * Rejections tell the host what happened: no active turn (the agent's turn already
   * ended, so the host sends it as the next turn), "delivery uncertain" (sent, no
   * answer; the agent may have it, so it must not be sent again), or the agent's error.
   */
  async steer(message: UserMessage, opts?: SendOptions): Promise<void> {
    if (!this.steeringOffered) {
      await this.send(message, opts);
      return;
    }
    const gate = this.turnGate(opts);
    const turn = this.turn;
    if (this.ended || this.closing) throw new Error('ACP session is closed');
    if (!turn || turn.cancelTimer) throw new Error(NO_ACTIVE_TURN_TO_STEER);
    // The agent was not told to ask before each call of an ungated turn: the message waits for its own turn.
    if (gate && !turn.gate) throw new Error(NO_ACTIVE_TURN_TO_STEER);
    const prompt = await this.toPrompt(message);
    if (prompt.length === 0) throw new Error('Cannot send an empty message');
    if (this.ended || this.closing || this.connection.closed) throw new Error('ACP session is closed');
    // Attachments are read asynchronously: the turn may have ended or been stopped meanwhile.
    if (this.turn !== turn || turn.cancelTimer) throw new Error(NO_ACTIVE_TURN_TO_STEER);
    // Before the agent can act on the message; a steer that is not taken leaves the turn stricter, never looser.
    if (gate && turn.gate) turn.gate = mergeGates(turn.gate, gate);
    let result: AcpRecord;
    try {
      result = await this.connection.request(ACP_STEERING_METHOD, {
        sessionId: this.id,
        prompt,
        // Without this an agent whose turn just ended starts a turn of its own, which Cindy does not track.
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      }, {
        onResult: (reply) => {
          // Finish the old segment before the decoder handles any following update.
          if (reply.outcome === 'injected' && this.turn === turn) this.emit(this.translator.flushPending());
        },
      });
    } catch (error) {
      if (!(error instanceof AcpRpcError)) {
        throw new Error(`ACP steering delivery uncertain: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (error.code === JSONRPC_METHOD_NOT_FOUND) {
        this.logger?.warn('acp: agent advertised steering but does not handle it; later messages wait for the next turn');
        this.steeringOffered = false;
        this.refreshCapabilities();
      }
      throw error;
    }
    switch (result.outcome) {
      case 'injected':
        return;
      case 'promptRequired':
        throw new Error(NO_ACTIVE_TURN_TO_STEER);
      case 'startedNewTurn':
        // Agents older than the idle opt-in run it themselves; its output arrives as background work.
        this.logger?.info('acp: agent started the steered message as its own turn');
        return;
      default:
        throw new Error(`ACP agent did not take the steered message (outcome: ${String(result.outcome)})`);
    }
  }

  async abort(): Promise<void> {
    this.stopGeneration += 1;
    this.pendingPrompts.length = 0;
    const turn = this.turn;
    if (!turn) {
      this.backgroundPermission = null;
      this.cancelPermissions();
      // Agents that keep working after a prompt (DSH documents it) stop that work on cancel;
      // others ignore a cancel with no prompt in flight.
      if (this.hasBackgroundWork() && !this.connection.closed) this.connection.notify('session/cancel', { sessionId: this.id });
      return;
    }
    if (turn.settled || turn.cancelTimer) return;
    turn.cancelTimer = setTimeout(() => {
      this.logger?.warn('acp: agent did not settle a cancelled prompt in time', { graceMs: this.cancelGraceMs });
      // Mark the handle as closing before emitting done so no queued or later prompt
      // can share the endpoint with the prompt that ignored cancellation.
      this.retireEndpoint();
      this.finishTurn(turn.token, { stopReason: 'cancelled' });
    }, this.cancelGraceMs);
    // ACP also expects cancelled responses to permission requests that arrive during the grace period.
    this.cancelPermissions();
    this.connection.notify('session/cancel', { sessionId: this.id });
  }

  close(): Promise<void> {
    return this.beginClose(() => this.doClose());
  }

  async setModel(model: string, opts?: { effort?: Effort }): Promise<void> {
    await this.selectModel(model);
    if (opts?.effort) {
      try {
        await this.setEffort(opts.effort);
      } catch (error) {
        // The new model may not offer that level; keep the agent's own default.
        this.logger?.debug('acp: effort not applied after model switch', { error: String(error) });
      }
    }
  }

  private async selectModel(model: string): Promise<void> {
    const option = findModelOption(this.configOptions);
    if (this.requireSelectedModel && model === 'default' && !option?.options.some(entry => entry.value === model)) {
      // This host choice delegates back to the model the endpoint selected when the session opened.
      if (!option || !this.initialModel) return;
      model = this.initialModel;
    }
    if (!option) throw new NotSupportedError('switchModel', { supported: false, reason: 'sdk-missing' });
    if (!option.options.some((entry) => entry.value === model)) throw new Error(`The agent does not offer model "${model}"`);
    if (option.currentValue !== model) await this.setConfigValue(option.id, model);
    if (this.requireSelectedModel && this.model !== model) throw new Error(`The agent did not select model "${model}"`);
  }

  async setEffort(effort: Effort): Promise<void> {
    const option = findEffortOption(this.configOptions);
    const mapped = mapEffortValues(option).find((entry) => entry.effort === effort);
    if (!option || !mapped) throw new NotSupportedError('effort', { supported: false, reason: 'sdk-missing' });
    if (option.currentValue !== mapped.value) await this.setConfigValue(option.id, mapped.value);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.applyPermissionMode(mode);
    await this.applyAgentMode(mode);
  }

  /** Switches the agent's own mode when it offers one standing for this Cindy mode (`ask` <-> `default`). */
  private async applyAgentMode(mode: PermissionMode): Promise<void> {
    const option = findModeOption(this.configOptions);
    const mappedModes = mapModeValues(option);
    const mapped = mappedModes.find((entry) => entry.mode === mode)
      ?? (mode === 'ask' ? mappedModes.find((entry) => entry.mode === 'default') : undefined)
      ?? (mode === 'default' ? mappedModes.find((entry) => entry.mode === 'ask') : undefined);
    if (!option || !mapped || option.currentValue === mapped.value) return;
    await this.setConfigValue(option.id, mapped.value);
  }

  /** @internal Apply the host selections after the engine handshake and before the first prompt. */
  async applyInitialSelection(model: string | undefined, effort: Effort | undefined, permissionMode?: PermissionMode): Promise<void> {
    if (model && model !== this.model) {
      try {
        await this.setModel(model);
      } catch (error) {
        if (this.requireSelectedModel) throw error;
        this.logger?.warn('acp: stored model not applied; keeping the agent default', { error: String(error) });
      }
    }
    if (effort && effort !== this.getEffort()) {
      try {
        await this.setEffort(effort);
      } catch (error) {
        this.logger?.debug('acp: stored effort not applied', { error: String(error) });
      }
    }
    if (permissionMode) {
      try {
        await this.applyAgentMode(permissionMode);
      } catch (error) {
        this.logger?.debug('acp: stored mode not applied', { error: String(error) });
      }
    }
  }

  /** @internal Called by the connection router. */
  handleNotification(method: string, params: AcpRecord): void {
    if (method !== 'session/update' || params.sessionId !== this.id) return;
    const update = asRecord(params.update);
    switch (update.sessionUpdate) {
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) this.replaceConfigOptions(update.configOptions);
        return;
      case 'usage_update':
        this.applyUsage(update);
        return;
      case 'session_info_update': {
        const title = asNonEmptyString(update.title);
        if (title) this.title = title;
        return;
      }
      case 'current_mode_update': {
        const modeId = asNonEmptyString(update.currentModeId);
        if (modeId) this.applyCurrentModeUpdate(modeId);
        return;
      }
      case 'available_commands_update':
        for (const name of normalizeAvailableCommandNames(update.availableCommands)) {
          this.commandNames.add(name.toLowerCase());
        }
        return;
      default:
        if (STATE_UPDATES.has(update.sessionUpdate)) return;
        this.emit(this.translator.handleUpdate(update));
        if (this.turn) return;
        // Progress on a running call may change nothing on screen, yet it proves the agent
        // is still working: it keeps the runtime busy and restarts the open-call quiet bound.
        this.lastBackgroundAt = this.now();
        this.armOpenToolCap();
        this.armBackgroundSegmentClose();
    }
  }

  /** Closes the agent's text / thinking between turns once it pauses (see ACP_BACKGROUND_SEGMENT_IDLE_MS). */
  private armBackgroundSegmentClose(): void {
    this.clearBackgroundSegmentClose();
    this.backgroundSegmentTimer = setTimeout(() => {
      this.backgroundSegmentTimer = null;
      if (!this.ended && !this.turn) this.emit(this.translator.flushPending());
    }, ACP_BACKGROUND_SEGMENT_IDLE_MS);
    this.backgroundSegmentTimer.unref?.();
  }

  private clearBackgroundSegmentClose(): void {
    if (!this.backgroundSegmentTimer) return;
    clearTimeout(this.backgroundSegmentTimer);
    this.backgroundSegmentTimer = null;
  }

  /** @internal Called by the connection router. */
  async handleRequest(method: string, params: AcpRecord, signal: AbortSignal): Promise<unknown> {
    if (method === 'session/request_permission' && params.sessionId === this.id) {
      return { outcome: await this.decidePermission(params, signal) };
    }
    // fs/* and terminal/* are not advertised in phase 1.
    throw methodNotFound(method);
  }

  private pump(): void {
    if (this.turn || this.ended || this.closing) return;
    const next = this.pendingPrompts.shift();
    if (!next) return;
    // Output produced between turns (autonomous agent work) is closed off as background.
    this.emit(this.translator.flushPending());
    this.clearBackgroundSegmentClose();
    this.clearOpenToolCap();
    const turn: ActiveTurn = {
      token: ++this.turnSeq,
      permissionTurnId: this.initializeResult.permissionGate ? randomUUID() : null,
      contextSelection: this.reportedSelection,
      settled: false,
      cancelTimer: null,
      gate: next.gate,
    };
    this.turn = turn;
    this.backgroundPermission = null;
    this.usage = { ...this.usage, tokenUsage: 0 };
    this.emit([{ type: 'status', data: { status: 'running', ...this.usage, isRunning: true } }]);
    const usageModel = this.model;
    const params: AcpRecord = { sessionId: this.id, prompt: next.blocks };
    if (turn.permissionTurnId) {
      params._meta = { permissionGate: {
        turnId: turn.permissionTurnId,
        ...(next.gate ? { scope: ACP_PERMISSION_GATE_SCOPE } : {}),
      } };
    }
    this.connection.request('session/prompt', params, { timeoutMs: null }).then(
      (result) => {
        // The prompt result is the only per-turn token report; `usage_update` only carries the context size.
        const usage = normalizeTurnUsage(result);
        this.finishTurn(turn.token, { stopReason: normalizeStopReason(result), ...(usage ? { usage, usageModel } : {}) });
      },
      (error: unknown) => this.finishTurn(turn.token, this.errorOutcome(error)),
    );
  }

  private finishTurn(token: number, outcome: AcpTurnOutcome): void {
    const turn = this.turn;
    if (!turn || turn.token !== token || turn.settled) return;
    turn.settled = true;
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    this.cancelPermissions();
    this.turn = null;
    this.backgroundPermission = turn.cancelTimer || 'error' in outcome || outcome.stopReason === 'cancelled'
      ? null
      : { permissionTurnId: turn.permissionTurnId, gate: turn.gate };
    // Turn-closing events belong to the turn that just ended, so they are not tagged background.
    for (const event of this.translator.finish(outcome)) this.queue.push(event);
    this.pump();
    // Calls the agent left running continue as background work.
    if (!this.turn) this.armOpenToolCap();
  }

  /** (Re)starts the quiet bound for tool calls left open between turns. */
  private armOpenToolCap(): void {
    this.clearOpenToolCap();
    if (this.ended || this.turn || this.translator.openToolCount() === 0) return;
    this.openToolCapTimer = setTimeout(() => {
      this.openToolCapTimer = null;
      if (this.ended || this.turn || this.translator.openToolCount() === 0) return;
      this.logger?.warn('acp: agent sent nothing for open tool calls between turns; settling them', {
        open: this.translator.openToolCount(),
        quietMs: this.openToolQuietCapMs,
      });
      this.emit(this.translator.settleOpenTools('done'));
    }, this.openToolQuietCapMs);
    this.openToolCapTimer.unref?.();
  }

  private clearOpenToolCap(): void {
    if (!this.openToolCapTimer) return;
    clearTimeout(this.openToolCapTimer);
    this.openToolCapTimer = null;
  }

  private errorOutcome(error: unknown): AcpTurnOutcome {
    if (error instanceof AcpConnectionClosedError) {
      return { error: 'The agent process ended unexpectedly.', reason: 'acp-agent-exited' };
    }
    const classified = error instanceof AcpRpcError ? readAcpCindyError(error.data) : null;
    if (error instanceof AcpRpcError && (error.code === ACP_ERROR_AUTH_REQUIRED || classified?.kind === 'auth-required')) {
      return { error: 'The agent needs you to sign in again.', reason: 'acp-auth-required' };
    }
    if (classified) {
      return {
        error: classified.kind === 'usage-limit'
          ? 'The plugin engine account has reached its usage limit.'
          : 'The plugin engine service is currently overloaded.',
        reason: classified.kind === 'usage-limit' ? 'acp-usage-limit' : 'acp-overloaded',
        signals: acpCindyErrorSignals(classified),
      };
    }
    return { error: error instanceof Error ? error.message : String(error), reason: 'acp-request-failed' };
  }

  private emit(events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    const background = this.turn === null;
    for (const event of events) this.queue.push(background ? { ...event, turnScope: 'background' } : event);
    if (!background) return;
    this.lastBackgroundAt = this.now();
    this.armOpenToolCap();
  }

  private applyUsage(update: AcpRecord): void {
    const used = typeof update.used === 'number' && update.used >= 0 ? update.used : null;
    const size = typeof update.size === 'number' && update.size >= 0 ? update.size : null;
    if (used === null || size === null) return;
    const window = Number.isSafeInteger(size) && size > 0 ? size : undefined;
    if (this.contextSelectionPending === 0
      && (!this.turn || this.turn.contextSelection === this.reportedSelection)
      && this.reportedContextWindow !== window) {
      this.reportedContextWindow = window;
      this.publishReportedModelDetails();
    }
    const cost = asRecord(update.cost);
    this.usage = {
      ...this.usage,
      contextTokens: used,
      contextWindow: size,
      ...(cost.currency === 'USD' && typeof cost.amount === 'number' ? { costUsd: cost.amount } : {}),
    };
    if (this.turn) this.emit([{ type: 'status', data: { status: 'running', ...this.usage, isRunning: true } }]);
  }

  private applyPermissionMode(mode: PermissionMode): void {
    this.selectedPermissionMode = mode;
    // Modes Cindy cannot enforce for ACP fall back to asking, never to auto-approval.
    this.permissionMode = mode === 'bypassPermissions' ? 'bypassPermissions' : 'ask';
    if (!ACP_SUPPORTED_PERMISSION_MODES.has(mode)
      && !mapModeValues(findModeOption(this.configOptions)).some((entry) => entry.mode === mode)) {
      this.logger?.debug('acp: permission mode mapped to ask', { mode });
    }
  }

  private async decidePermission(params: AcpRecord, signal: AbortSignal): Promise<AcpPermissionOutcome> {
    if (signal.aborted || this.closing || this.turn?.cancelTimer) return { outcome: 'cancelled' };
    const options = normalizePermissionOptions(params.options);
    const reject = firstOfKind(options, ['reject_once']);
    const permission = this.turn ?? this.backgroundPermission;
    const requestGate = asRecord(asRecord(params._meta).permissionGate);
    if (this.initializeResult.permissionGate
      && (!permission?.permissionTurnId || requestGate.turnId !== permission.permissionTurnId)) {
      return selected(reject);
    }
    const gate = permission?.gate;
    if (gate?.toolsDisabled) return selected(reject);
    const allowOnce = firstOfKind(options, ['allow_once']);
    const fields = normalizeToolCallFields(params.toolCall);
    if (gate?.policy && !fields) return selected(reject);
    const { events, toolCall } = this.translator.noteToolCall(fields ?? { toolCallId: `acp-permission-${this.permissionSeq + 1}` });
    this.emit(events);
    if (this.permissionMode === 'bypassPermissions') {
      return selected(allowOnce ?? reject);
    }
    const input = toolCall.rawInput;
    const hasInputRecord = input !== null && typeof input === 'object' && !Array.isArray(input);
    const requestInput = hasInputRecord ? input as AcpRecord : input === undefined ? {} : { value: input };
    const policyToolName = toolCall.kind && Object.hasOwn(ACP_KIND_POLICY_NAMES, toolCall.kind)
      ? ACP_KIND_POLICY_NAMES[toolCall.kind]
      : undefined;
    const toolName = (gate?.policy ? policyToolName : undefined) ?? acpToolDisplayName(toolCall);
    // The channel must be able to classify the operation and its input before a routine call can run unasked.
    // A shell approval without a command would also leave the channel's destructive-command check blind.
    if (gate?.policy && toolCall.kind === 'execute'
      && (typeof requestInput.command !== 'string' || requestInput.command.trim() === '')) {
      return selected(reject);
    }
    // An IM policy can defer authorization to the normal approval chain, including the
    // owner's review of guest writes. Only explicitly read-only kinds can skip that chain.
    const canRunRoutine = gate?.policy?.origin.kind !== 'im'
      || toolCall.kind === 'read' || toolCall.kind === 'search';
    if (gate?.policy && canRunRoutine && policyToolName && hasInputRecord && requestGate.routine === true
      && !this.policyForcesConfirmation(gate.policy, policyToolName, requestInput)
      && (!toolCall.name || toolCall.name === policyToolName
        || !this.policyForcesConfirmation(gate.policy, toolCall.name, requestInput))) {
      return selected(allowOnce ?? reject);
    }
    const resolver = this.resolver;
    if (!resolver) return selected(reject);

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    this.permissionControllers.add(controller);
    const request: InteractionRequest = {
      kind: 'permission',
      requestId: `acp-permission-${++this.permissionSeq}`,
      toolUseId: toolCall.toolCallId,
      // A gated turn's confirmation goes through the channel's checks, which know tools by these names.
      toolName,
      input: requestInput,
      ...(toolCall.title ? { title: toolCall.title } : {}),
      displayName: acpToolDisplayName(toolCall),
      metadata: {
        ...(toolCall.kind ? { acpToolKind: toolCall.kind } : {}),
        ...(policyToolName ? { acpPolicyToolName: policyToolName } : {}),
        ...(toolCall.name ? { acpReportedToolName: toolCall.name } : {}),
        ...(toolCall.locations?.length ? { acpLocations: toolCall.locations } : {}),
        acpOptions: options.map((option) => ({ name: option.name, kind: option.kind })),
      },
    };
    try {
      // Stop must answer the agent at once, even while a confirmation card is still open.
      const decision = await untilAborted(resolver(request, controller.signal), controller.signal);
      if (decision === ABORTED || controller.signal.aborted) return { outcome: 'cancelled' };
      if (decision.kind !== 'permission' || decision.behavior !== 'allow') return selected(reject);
      return selected(allowOnce ?? reject);
    } catch (error) {
      if (controller.signal.aborted) return { outcome: 'cancelled' };
      this.logger?.warn('acp: permission resolver failed; rejecting', { error: String(error) });
      return selected(reject);
    } finally {
      signal.removeEventListener('abort', forwardAbort);
      this.permissionControllers.delete(controller);
    }
  }

  private policyForcesConfirmation(policy: TurnPermissionPolicy, toolName: string, input: Record<string, unknown>): boolean {
    try {
      return policy.forceConfirmToolCall(toolName, input) === true;
    } catch (error) {
      // A failing safety rule cannot become an approval.
      this.logger?.error('acp: turn permission policy failed; asking for confirmation', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private cancelPermissions(): void {
    for (const controller of this.permissionControllers) controller.abort();
    this.permissionControllers.clear();
  }

  private async setConfigValue(configId: string, value: string): Promise<void> {
    // A usage update carries no model id. Don't attribute it while a selection RPC is in flight.
    let pending = configId === findModelOption(this.configOptions)?.id
      || configId === findEffortOption(this.configOptions)?.id;
    if (pending) this.contextSelectionPending++;
    const finish = () => {
      if (!pending) return;
      pending = false;
      this.contextSelectionPending--;
    };
    try {
      await this.connection.request(
        'session/set_config_option',
        { sessionId: this.id, configId, value },
        {
          onResult: (result) => {
            finish();
            if (Array.isArray(result.configOptions)) {
              this.replaceConfigOptions(result.configOptions);
              return;
            }
            // Agents that omit the response state still applied the change.
            this.configOptions = this.configOptions.map((option) => option.id === configId ? { ...option, currentValue: value } : option);
            this.refreshCapabilities();
          },
        },
      );
    } finally {
      finish();
    }
  }

  private replaceConfigOptions(raw: unknown[]): void {
    this.configOptions = normalizeConfigOptions(raw);
    this.refreshCapabilities();
  }

  private applyCurrentModeUpdate(modeId: string): void {
    const option = findModeOption(this.configOptions);
    if (!option || option.currentValue === modeId) return;
    if (!option.options.some((entry) => entry.value === modeId)) return;
    this.configOptions = this.configOptions.map((entry) => entry.id === option.id ? { ...entry, currentValue: modeId } : entry);
  }

  private buildCapabilities(): Capabilities {
    return buildAcpCapabilities({ ...this.initializeResult, steering: this.steeringOffered }, this.configOptions);
  }

  private refreshCapabilities(): void {
    const selection = this.contextSelection();
    if (selection !== this.reportedSelection) {
      this.reportedSelection = selection;
      this.reportedContextWindow = undefined;
      this.publishReportedModelDetails();
    }
    this.capabilitiesSnapshot = this.buildCapabilities();
    for (const listener of this.capabilityListeners) {
      try {
        listener(this.capabilitiesSnapshot);
      } catch (error) {
        this.logger?.error('acp: capability listener failed', { error: String(error) });
      }
    }
  }

  private async toPrompt(message: UserMessage): Promise<AcpContentBlock[]> {
    if (typeof message.content === 'string') {
      return message.content.length > 0 ? [{ type: 'text', text: await this.expandText(message.content) }] : [];
    }
    const blocks: AcpContentBlock[] = [];
    // Only the message's opening text can be a slash invocation: its first text block, the same text
    // the host keeps its notes off (desktop `shouldPrependMobileClientPromptNote`).
    const opening = message.content.findIndex((block) => block.type === 'text');
    for (const [index, block] of message.content.entries()) {
      blocks.push(index === opening && block.type === 'text'
        ? { type: 'text', text: await this.expandText(block.text) }
        : await this.toContentBlock(block));
    }
    return blocks;
  }

  private async expandText(text: string): Promise<string> {
    if (!this.expandSlashInvocation || !text.trimStart().startsWith('/')) return text;
    return (await this.expandSlashInvocation(text)) ?? text;
  }

  private async toContentBlock(block: UserContentBlock): Promise<AcpContentBlock> {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image': {
        const mimeType = block.mimeType ?? IMAGE_MIME_BY_EXTENSION[extname(block.path).toLowerCase()];
        if (this.initializeResult.agentCapabilities.promptCapabilities.image && mimeType) {
          const bytes = await this.readImage(block.path);
          return { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType };
        }
        return { type: 'resource_link', uri: pathToFileURL(block.path).href, name: basename(block.path), ...(mimeType ? { mimeType } : {}) };
      }
      case 'file':
        return { type: 'resource_link', uri: pathToFileURL(block.path).href, name: basename(block.path), ...(block.mimeType ? { mimeType: block.mimeType } : {}) };
      case 'mention':
        if (block.kind === 'agent') return { type: 'text', text: `@${block.name}` };
        return { type: 'resource_link', uri: pathToFileURL(block.path).href, name: block.name };
    }
  }

  private handleConnectionClosed(info: AcpTransportClosed): void {
    if (info.reason !== 'closed-by-client') {
      this.logger?.warn('acp: agent connection ended', { reason: info.reason, ...(info.detail ? { detail: info.detail } : {}) });
    }
    this.pendingPrompts.length = 0;
    const turn = this.turn;
    if (turn) {
      this.finishTurn(turn.token, info.reason === 'closed-by-client'
        ? { stopReason: 'cancelled' }
        : { error: 'The agent process ended unexpectedly.', reason: 'acp-agent-exited' });
    } else {
      // Work between turns ends with the connection: keep what the agent already wrote,
      // and mark calls it left running as interrupted.
      this.emit(this.translator.flushPending());
      this.emit(this.translator.settleOpenTools('interrupted'));
    }
    this.clearBackgroundSegmentClose();
    this.clearOpenToolCap();
    if (info.reason === 'protocol-error') this.retireEndpoint();
  }

  private beginClose(action: () => Promise<void>): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(action).finally(() => { this.closing = null; });
    return this.closing;
  }

  private retireEndpoint(): void {
    void this.beginClose(() => this.closeEndpoint()).catch((error: unknown) => {
      this.logger?.warn('acp: could not confirm endpoint exit', { error: String(error) });
    });
  }

  private async doClose(): Promise<void> {
    this.pendingPrompts.length = 0;
    await this.abort();
    if (this.initializeResult.agentCapabilities.sessionCapabilities.close && !this.connection.closed) {
      try {
        await this.connection.request('session/close', { sessionId: this.id }, { timeoutMs: SESSION_CLOSE_TIMEOUT_MS });
      } catch (error) {
        this.logger?.debug('acp: session/close failed; closing the endpoint anyway', { error: String(error) });
      }
    }
    if (this.turn) this.finishTurn(this.turn.token, { stopReason: 'cancelled' });
    await this.closeEndpoint();
  }

  private async closeEndpoint(): Promise<void> {
    await this.connection.close();
    this.endEvents();
  }

  private endEvents(): void {
    if (this.ended) return;
    this.ended = true;
    this.notifyReportedModelDetails(undefined);
    this.modelDetailsListener = undefined;
    this.clearBackgroundSegmentClose();
    this.clearOpenToolCap();
    this.detachTransportClose?.();
    this.queue.end();
    try {
      this.onEnded?.();
    } catch (error) {
      this.logger?.error('acp: onEnded hook failed', { error: String(error) });
    }
  }
}

/**
 * Compile-time contract: an AcpSession is an AgentSessionHandle for the 'acp' engine kind.
 */
export const asAcpSessionHandle = (session: AcpSession): AgentSessionHandle => session;
