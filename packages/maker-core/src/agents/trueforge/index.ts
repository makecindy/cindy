import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

import type { AgentKind, PermissionMode, UserMessage } from '../../types/common.js';
import type {
  AgentEvent,
  InteractionRequest,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import type { Capabilities, ModelDescriptor } from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import {
  BaseAgent,
  type AgentDeps,
  type AgentSessionHandle,
  type SendOptions,
  type StartSessionOptions,
} from '../base-agent.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import {
  asTrueForgeEvent,
  parseToolArguments,
  toolNameOf,
  type TrueForgeEvent,
} from './protocol.js';
import {
  beginTrueForgeTurn,
  createTrueForgeTranslateState,
  emitToolUse,
  finishTrueForgeTurn,
  rememberToolCalls,
  translateTrueForgeEvent,
  type TrueForgeTranslateState,
} from './translator.js';

interface TrueForgeStream {
  withMetadata(): AsyncIterable<{ data: unknown; id?: string | number | null }>;
}

interface TrueForgeClientLike {
  fetch(path: string, init?: unknown, options?: unknown): Promise<{ ok: boolean }>;
  sessions: {
    get(sessionId: string): Promise<unknown>;
    create(body: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(sessionId: string, body: unknown, options?: unknown): Promise<TrueForgeStream>;
    cancel(sessionId: string, request?: unknown, options?: unknown): Promise<unknown>;
  };
}

export interface TrueForgeAgentConfig {
  baseUrl: string;
  model: string;
  displayName?: string;
  contextWindow: number;
  idToken?: string;
  fetch?: typeof globalThis.fetch;
  /** Test seam; production always constructs the version-pinned SDK client. */
  client?: TrueForgeClientLike;
}

interface ConsumedTurn {
  terminal: TrueForgeEvent;
  events: Map<string, TrueForgeEvent>;
}

function unsupported(message: string) {
  return {
    supported: false as const,
    reason: 'not-implemented' as const,
    message,
  };
}

function textOf(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'mention') parts.push(`@${block.name} (${block.path})`);
    else {
      throw new NotSupportedError(`multimodal:${block.type}`, {
        supported: false,
        reason: 'not-implemented',
        message: 'TrueForge file and image forwarding is not implemented yet.',
      });
    }
  }
  return parts.join('\n').trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

async function resolveWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('TrueForge turn aborted');
  let fail!: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    fail = () => reject(new Error('TrueForge turn aborted'));
    signal.addEventListener('abort', fail, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener('abort', fail);
  }
}

// Keep the experimental service adapter out of the stable three-agent union until every Cindy
// orchestration surface has an explicit TrueForge policy. Runtime dispatch is string-keyed, so the
// desktop host can opt in without widening unrelated scheduler/IM/device-link contracts.
const TRUEFORGE_KIND = 'trueforge' as AgentKind;

/** Experimental adapter for a user-managed TrueForge 0.1.x HTTP/SSE service. */
export class TrueForgeAgent extends BaseAgent {
  readonly kind: AgentKind = TRUEFORGE_KIND;
  readonly capabilities: Capabilities;
  private readonly client: TrueForgeClientLike;

  constructor(
    deps: AgentDeps,
    private readonly config: TrueForgeAgentConfig,
  ) {
    super({ ...deps, runtimeKind: 'service', binaryPath: '' });
    const model: ModelDescriptor = {
      id: config.model,
      displayName: config.displayName?.trim() || config.model,
      contextWindow: config.contextWindow,
      efforts: [],
      defaultEffort: null,
      newSessionDefault: ['trueforge'],
    };
    this.capabilities = this.buildCapabilities({
      switchModel: unsupported('Change the model in the TrueForge service configuration.'),
      availableModels: [model],
      hasFastMode: false,
      effort: unsupported('TrueForge does not expose a per-session reasoning-effort control.'),
      effortLevels: [],
      reasoningDisplay: ['off'],
      permissionModes: [
        {
          id: 'ask',
          displayName: 'TrueForge approvals',
          description: 'Use the approval gates configured by the TrueForge agent.',
        },
      ],
      setPermissionModeMidSession: unsupported(
        'Approval policy is owned by the TrueForge agent spec.',
      ),
      turnPermissionPolicy: {
        supported: unsupported(
          'Per-turn Cindy permission policies are not bridged to TrueForge yet.',
        ),
        unsupportedPermissionModes: ['ask'],
      },
      planMode: unsupported('TrueForge does not expose Cindy plan mode.'),
      multimodal: {
        text: { supported: true },
        image: unsupported('Image forwarding is not implemented yet.'),
        file: unsupported('File forwarding is not implemented yet.'),
      },
      runtimeCapabilities: unsupported('TrueForge commands are managed by its server.'),
      fork: unsupported('TrueForge session branching is not exposed by this adapter.'),
      rewind: unsupported('TrueForge rewind is not exposed by this adapter.'),
      sessionTree: unsupported('TrueForge thread trees are not exposed by this adapter.'),
      abort: { supported: true },
      sameTurnSteer: unsupported('TrueForge accepts follow-up input as a new turn.'),
      memory: {
        supported: unsupported('TrueForge memory is managed by its server.'),
      },
      extraDirs: unsupported('TrueForge cannot mount Cindy reference directories.'),
    });
    this.client =
      config.client ??
      (new TrueForge({
        baseUrl: config.baseUrl,
        ...(config.idToken ? { token: config.idToken } : {}),
        ...(config.fetch ? { fetch: config.fetch } : {}),
        timeoutInSeconds: 600,
        maxRetries: 1,
      }) as unknown as TrueForgeClientLike);
  }

  override async isRuntimeReady(): Promise<boolean> {
    try {
      const response = await this.client.fetch('/healthz', undefined, {
        timeoutInSeconds: 5,
        maxRetries: 0,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  override async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    if (opts.remoteHostId) {
      throw new NotSupportedError('remoteSession', {
        supported: false,
        reason: 'not-implemented',
        message: 'TrueForge sessions are service-backed and cannot run through Cindy SSH remotes.',
      });
    }

    let sessionId = opts.resumeSessionId?.trim() || '';
    if (sessionId) {
      try {
        await this.client.sessions.get(sessionId);
      } catch (error) {
        if (statusCodeOf(error) !== 404) throw error;
        const cleared = await opts.onInvalidResumeSession?.(sessionId);
        if (!cleared) throw error;
        sessionId = '';
      }
    }
    if (!sessionId) {
      const created = await this.client.sessions.create({
        agent: {
          spec: {
            model: { name: this.config.model },
            config: { dynamicSubAgents: { enabled: false } },
          },
        },
      });
      sessionId = created.data.id;
    }

    const queue = createAsyncQueue<AgentEvent>();
    const state = createTrueForgeTranslateState(this.config.contextWindow);
    let resolver: InteractionResolver | null = null;
    let currentRun: Promise<void> | null = null;
    let streamAbort: AbortController | null = null;
    let cancelSettlement: Promise<void> | null = null;
    let closed = false;
    const client = this.client;
    const logger = this.deps.logger;

    queue.push({
      type: 'session_id',
      source: 'trueforge',
      data: sessionId,
    });

    const consume = async (stream: TrueForgeStream): Promise<ConsumedTurn> => {
      const events = new Map<string, TrueForgeEvent>();
      let terminal: TrueForgeEvent | null = null;
      for await (const envelope of stream.withMetadata()) {
        const event = asTrueForgeEvent(envelope.data);
        if (!event) continue;
        if (event.id && isEventDelta(envelope.data as never)) {
          const base = events.get(event.id);
          if (base) {
            mergeEventDelta(base as never, envelope.data as never);
            rememberToolCalls(state, base.toolCalls);
          }
        } else if (event.id) {
          events.set(event.id, event);
          rememberToolCalls(state, event.toolCalls);
        }
        translateTrueForgeEvent(event, queue, state);
        if (event.type === 'turn.done') terminal = event;
      }
      if (!terminal) throw new Error('TrueForge stream ended without turn.done');
      return { terminal, events };
    };

    const sourceCall = (
      action: TrueForgeEvent,
      ref: { id?: string; sourceEventId?: string },
      events: Map<string, TrueForgeEvent>,
    ) => {
      const source = ref.sourceEventId ? events.get(ref.sourceEventId) : undefined;
      return (
        source?.toolCalls?.find((call) => call.id === ref.id) ??
        (ref.id ? state.calls.get(ref.id) : undefined) ??
        action.toolCalls?.find((call) => call.id === ref.id)
      );
    };

    const resolveActions = async (
      actions: readonly TrueForgeEvent[],
      events: Map<string, TrueForgeEvent>,
    ): Promise<Array<Record<string, unknown>>> => {
      if (!resolver)
        throw new Error(
          'TrueForge requested user input before an interaction resolver was attached',
        );
      const responses: Array<Record<string, unknown>> = [];
      for (const action of actions) {
        if (action.type === 'mcp.auth_required') {
          const names = (action.mcpServers ?? []).map((server) => server.name).filter(Boolean);
          throw new Error(
            `TrueForge MCP authentication requires opening its UI${names.length ? ` for ${names.join(', ')}` : ''}`,
          );
        }
        for (const ref of action.toolCalls ?? []) {
          const call = sourceCall(action, ref, events);
          if (!call)
            throw new Error(
              `TrueForge interaction is missing tool metadata for ${ref.id ?? 'unknown call'}`,
            );
          emitToolUse(queue, state, call);
          const requestId = `${action.id ?? action.type}:${call.id}`;
          if (action.type === 'tool.approval_required') {
            const request: InteractionRequest = {
              kind: 'permission',
              requestId,
              toolUseId: call.id,
              toolName: toolNameOf(call),
              input: parseToolArguments(call.function?.arguments),
            };
            const activeSignal = streamAbort?.signal;
            if (!activeSignal) throw new Error('TrueForge turn is no longer active');
            const decision = await resolveWithAbort(resolver(request), activeSignal);
            if (decision.kind !== 'permission')
              throw new Error('TrueForge received an invalid approval decision');
            responses.push({
              type: 'user.tool_approval',
              threadId: action.threadId ?? 'main',
              toolCallId: call.id,
              approval:
                decision.behavior === 'allow'
                  ? { status: 'allow' }
                  : {
                      status: 'deny',
                      ...(decision.reason ? { reason: decision.reason } : {}),
                    },
            });
            continue;
          }
          if (action.type === 'tool.response_required') {
            const input = parseToolArguments(call.function?.arguments);
            const options = Array.isArray(input.options)
              ? input.options.filter((value): value is string => typeof value === 'string')
              : [];
            const question =
              typeof input.question === 'string'
                ? input.question
                : 'What should TrueForge do next?';
            const request: InteractionRequest = {
              kind: 'ask_user_question',
              requestId,
              toolUseId: call.id,
              questions: [
                {
                  question,
                  ...(options.length ? { options: options.map((label) => ({ label })) } : {}),
                },
              ],
            };
            const activeSignal = streamAbort?.signal;
            if (!activeSignal) throw new Error('TrueForge turn is no longer active');
            const decision = await resolveWithAbort(resolver(request), activeSignal);
            if (decision.kind !== 'ask_user_question')
              throw new Error('TrueForge received an invalid tool response');
            const answer = decision.answers[question] ?? Object.values(decision.answers)[0] ?? '';
            responses.push({
              type: 'user.tool_response',
              threadId: action.threadId ?? 'main',
              toolCallId: call.id,
              content: answer,
            });
          }
        }
      }
      return responses;
    };

    const consumeWithContinuations = async (firstStream: TrueForgeStream): Promise<void> => {
      let consumed = await consume(firstStream);
      while (!closed) {
        const status = consumed.terminal.state?.status;
        if (status === 'error') {
          finishTrueForgeTurn(
            queue,
            state,
            consumed.terminal.state?.message || 'TrueForge turn failed',
          );
          return;
        }
        const actions = consumed.terminal.state?.requiredActions ?? [];
        if (actions.length === 0) {
          finishTrueForgeTurn(queue, state);
          return;
        }
        const input = await resolveActions(actions, consumed.events);
        if (input.length === 0)
          throw new Error('TrueForge paused without a supported required action');
        const activeSignal = streamAbort?.signal;
        if (closed || !activeSignal || activeSignal.aborted) return;
        const next = await client.sessions.createTurnStream(
          sessionId,
          { input: input as never[] },
          { abortSignal: activeSignal },
        );
        consumed = await consume(next as unknown as TrueForgeStream);
      }
    };

    const startRun = async (message: UserMessage): Promise<void> => {
      if (closed) throw new Error('TrueForge session is closed');
      if (cancelSettlement) await cancelSettlement;
      if (closed) throw new Error('TrueForge session is closed');
      if (currentRun) throw new Error('TrueForge session already has a running turn');
      const content = textOf(message);
      if (!content) throw new Error('TrueForge requires a non-empty text message');
      beginTrueForgeTurn(state);
      const activeAbort = new AbortController();
      streamAbort = activeAbort;
      let markStarted!: () => void;
      let markStartFailed!: (error: unknown) => void;
      const started = new Promise<void>((resolve, reject) => {
        markStarted = resolve;
        markStartFailed = reject;
      });
      currentRun = (async () => {
        try {
          const stream = await client.sessions.createTurnStream(
            sessionId,
            { input: [{ type: 'user.message', content }] },
            { abortSignal: activeAbort.signal },
          );
          markStarted();
          await consumeWithContinuations(stream);
        } catch (error) {
          markStartFailed(error);
          throw error;
        }
      })()
        .catch((error) => {
          if (!closed && !activeAbort.signal.aborted) {
            finishTrueForgeTurn(queue, state, errorMessage(error));
            logger.warn('trueforge turn failed', {
              message: errorMessage(error),
            });
          }
        })
        .finally(() => {
          currentRun = null;
          if (streamAbort === activeAbort) streamAbort = null;
        });
      await started;
    };

    const handle: AgentSessionHandle = {
      id: sessionId,
      agentKind: TRUEFORGE_KIND,
      model: this.config.model,
      async send(message: UserMessage, _sendOpts?: SendOptions): Promise<void> {
        await startRun(message);
      },
      async steer(): Promise<void> {
        throw new NotSupportedError('sameTurnSteer', {
          supported: false,
          reason: 'not-implemented',
          message: 'TrueForge follow-ups start a new turn.',
        });
      },
      async abort(): Promise<void> {
        if (!currentRun) return;
        streamAbort?.abort();
        let cancelFailed = false;
        const cancellation = client.sessions
          .cancel(sessionId, undefined, { timeoutInSeconds: 5, maxRetries: 0 })
          .then(() => undefined)
          .catch((error) => {
            // A timed-out cancel may still reach the service later. Poison this handle so a
            // delayed session-scoped cancel can never terminate a newly-started turn.
            cancelFailed = true;
            closed = true;
            logger.warn('trueforge cancel failed after local abort', {
              message: errorMessage(error),
            });
          });
        cancelSettlement = cancellation;
        await cancellation;
        if (cancelSettlement === cancellation) cancelSettlement = null;
        if (cancelFailed) {
          await currentRun?.catch(() => undefined);
          queue.end();
        }
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        if (currentRun) {
          streamAbort?.abort();
          void client.sessions
            .cancel(sessionId, undefined, {
              timeoutInSeconds: 5,
              maxRetries: 0,
            })
            .catch(() => undefined);
          await currentRun.catch(() => undefined);
        }
        queue.end();
      },
      events(): AsyncIterable<AgentEvent> {
        return queue;
      },
      getUsageSnapshot(): UsageSnapshot {
        return { ...state.usage };
      },
      setInteractionResolver(next: InteractionResolver): void {
        resolver = next;
      },
      async setPermissionMode(mode: PermissionMode): Promise<void> {
        if (mode !== 'ask') {
          throw new NotSupportedError('setPermissionMode', {
            supported: false,
            reason: 'not-implemented',
            message: 'TrueForge approval policy is configured on the server.',
          });
        }
      },
    };
    return handle;
  }
}
