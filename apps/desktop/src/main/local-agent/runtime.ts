/** Adapt existing Maker sessions, without importing a second agent loop or transcript store. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  LOCAL_AGENT_CLIENT,
  assertSendDispatched,
  type Maker,
  type AgentEvent,
  type Session,
  type StartSessionOptions,
  type UserContentBlock,
  type UserMessage,
} from '@cindy/maker-core';
import { LocalAgentError, type LocalAgentOpen, type LocalAgentRuntime } from './server.js';

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const string = (v: unknown) => (typeof v === 'string' ? v : '');

/** How long a usage-less terminal error waits for its paired done before ending the turn. */
const ERROR_USAGE_GRACE_MS = 250;

/** Final snapshots must not repeat already-streamed text/thinking. */
export function createEventProjection(
  emit: (event: unknown) => void,
  mcpName = 'client',
  message = (_code: string, fallback: string) => fallback,
) {
  let textSeen = false;
  let ended = true;
  let usageReported = false;
  let usage = { input: 0, cached: 0, output: 0 };
  const addUsage = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const u = object(value);
    const input = Number(u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? 0);
    const cached = Number(u.cacheReadTokens ?? u.cachedTokens ?? u.cache_read_input_tokens ?? 0);
    const created = Number(
      u.cacheCreateTokens ?? u.cacheCreationTokens ?? u.cache_creation_input_tokens ?? 0,
    );
    const output = Number(u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? 0);
    if ([input, cached, created, output].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      usage.input += input + cached + created;
      usage.cached += cached;
      usage.output += output;
    }
  };
  const addEventUsage = (data: Record<string, unknown>) => {
    // Claude's raw result usage can be cumulative over several turns. Its
    // translated request segments are already deltas and include cache writes.
    if (Array.isArray(data.usageSegments)) {
      for (const segment of data.usageSegments) addUsage(segment);
    } else addUsage(data.usage);
  };
  const reportUsage = () => {
    if (!usageReported) {
      usageReported = true;
      emit({ type: 'usage', data: { ...usage } });
    }
  };
  const ignoredTools = new Set<string>();
  const streamed = new Map<string, string>();
  let failure: string | undefined;
  let pendingError: string | undefined;
  let errorGrace: ReturnType<typeof setTimeout> | undefined;
  const settleError = () => {
    clearTimeout(errorGrace);
    const failed = pendingError;
    pendingError = undefined;
    if (failed === undefined || ended) return;
    ended = true;
    emit({ type: 'turn_end', data: { status: 'failed', message: failed } });
  };
  return {
    begin() {
      settleError();
      textSeen = false;
      failure = undefined;
      streamed.clear();
      ended = false;
      usageReported = false;
      usage = { input: 0, cached: 0, output: 0 };
      ignoredTools.clear();
    },
    accept(event: AgentEvent, terminal = true) {
      const d = object(event.data);
      // The normal Session owns stale-tail and continuation attribution. Background child
      // events cannot settle this product turn or become the application's final answer.
      if (event.turnScope === 'background' || event.agentMeta?.parentUuid) return;
      if (ended) {
        if (event.type === 'done' && !usageReported && d.usage) {
          addEventUsage(d);
          reportUsage();
        }
        return;
      }
      if (event.type === 'text') {
        const text = string(d.text),
          key = string(d.agentMessageId);
        if (d.isFinal !== true) {
          if (text) {
            streamed.set(key, (streamed.get(key) ?? '') + text);
            textSeen = true;
            emit({ type: 'text', data: text });
          }
        } else {
          // The wire is append-only: a final snapshot can only supply the tail that
          // was never streamed (held citation boundary, final-only notices).
          const sent = streamed.get(key) ?? '';
          streamed.delete(key);
          if (text.length > sent.length && text.startsWith(sent)) {
            textSeen = true;
            emit({ type: 'text', data: text.slice(sent.length) });
          }
        }
      } else if (event.type === 'thinking') {
        if (d.stage !== 'final' && string(d.text)) emit({ type: 'thinking', data: d.text });
      } else if (event.type === 'tool_use') {
        const name = string(d.toolName ?? d.name),
          id = string(d.toolUseId ?? d.id);
        if (
          name.startsWith(`mcp__${mcpName}__`) ||
          name.startsWith(`mcp:${mcpName}:`) ||
          ['cindy_mcp_call_tool', 'cindy_mcp_list_tools'].includes(name)
        )
          ignoredTools.add(id);
        else if (id) emit({ type: 'tool_started', data: { id, name, arguments: d.input ?? {} } });
      } else if (event.type === 'tool_result_full') {
        const id = string(d.toolUseId ?? d.id);
        if (id && !ignoredTools.has(id))
          emit({
            type: 'tool_finished',
            data: { id, output: string(d.fullText ?? d.text), isError: d.isError === true },
          });
      } else if (
        event.type === 'error' &&
        (typeof d.isTerminal === 'boolean' ? d.isTerminal : d.willRetry !== true) &&
        !ended
      ) {
        const failed = string(d.message) || message('EXECUTION_FAILED', 'Cindy 执行未完成。');
        if (d.usage) {
          addEventUsage(d);
          reportUsage();
        } else if (pendingError === undefined) {
          // Claude reports a failed result as error then a paired done carrying the usage;
          // other engines may stop at the error, so the wait is bounded.
          pendingError = failed;
          errorGrace = setTimeout(settleError, ERROR_USAGE_GRACE_MS);
          errorGrace.unref?.();
          return;
        }
        ended = true;
        emit({ type: 'turn_end', data: { status: 'failed', message: failed } });
      } else if (event.type === 'done' && pendingError !== undefined) {
        addEventUsage(d);
        reportUsage();
        settleError();
      } else if (event.type === 'done' && !ended) {
        if (!textSeen && string(d.result)) emit({ type: 'text', data: d.result });
        addEventUsage(d);
        if (!terminal) {
          textSeen = false;
          streamed.clear();
          return;
        }
        reportUsage();
        ended = true;
        const interrupted = ['cancelled', 'aborted', 'interrupted'].includes(string(d.status));
        emit({
          type: 'turn_end',
          data: {
            status: interrupted
              ? 'interrupted'
              : failure !== undefined ||
                  d.is_error === true ||
                  d.status === 'error' ||
                  d.status === 'failed'
                ? 'failed'
                : 'completed',
            message: (!interrupted && failure) || string(d.error),
          },
        });
      }
    },
    /** Fail this turn at its real native boundary, after the engine has settled. */
    failAtEnd(message: string) {
      if (!ended) failure ??= message;
    },
    fail(message: string, status: 'failed' | 'interrupted' = 'failed') {
      settleError();
      if (!ended) {
        ended = true;
        emit({ type: 'turn_end', data: { status, message } });
      }
    },
  };
}

export async function openLocalAgentRuntime(
  maker: Pick<Maker, 'startLocalAgentSession'>,
  directory: string,
  input: LocalAgentOpen,
  bridge: { url: string; token: string; emit(event: unknown): void },
  localize = (_code: string, fallback: string) => fallback,
): Promise<LocalAgentRuntime> {
  let instructions = input.instructions;
  // The effort last applied by send.effort survives an instructions rebuild.
  let effort = input.effort;
  const sessionId = `local-agent-${randomUUID()}`;
  let handle: Session;
  let closed = false,
    busy = false,
    preparing = false,
    resumed = false;
  // Instructions are read when a Session starts; only that applied version is clean.
  let instructionsVersion = 0,
    appliedInstructions = 0;
  let epoch = 0,
    turn = 0;
  const assertCurrent = (expected: number) => {
    if (closed) throw new LocalAgentError('SESSION_UNAVAILABLE', 'Cindy 会话已关闭。');
    if (epoch !== expected)
      throw new LocalAgentError('INTERRUPTED', '本次发送已停止，未继续提交消息。');
  };
  const applicationDirectory = path.join(directory, 'clients', input.isolationKey);
  await fs.mkdir(applicationDirectory, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(applicationDirectory, 'input-'));
  const projection = createEventProjection(bridge.emit, input.mcpName, localize);
  const start = async (resume?: string, expected = epoch) => {
    assertCurrent(expected);
    const opts: StartSessionOptions = {
      sessionId,
      workingDir: input.cwd,
      providerId: input.model.provider,
      model: input.model.model,
      effort: effort as StartSessionOptions['effort'],
      userPrompt: instructions,
      makerMemoryEnabled: false,
      permissionMode: 'bypassPermissions',
      resumeSessionId: resume,
      [LOCAL_AGENT_CLIENT]: {
        url: bridge.url,
        token: bridge.token,
        hostToolsOnly: input.access === 'none',
        mcpName: input.mcpName,
        ...(input.legacyRuntime
          ? {}
          : { storageDirectory: path.join(applicationDirectory, input.model.engine) }),
      },
      onInvalidResumeSession: async () => {
        resumed = false;
        return false;
      },
    };
    resumed = Boolean(resume);
    const next = await maker.startLocalAgentSession(input.model.engine, opts);
    try {
      assertCurrent(expected);
    } catch (error) {
      await next.close({ reason: 'account-boundary' });
      throw error;
    }
    if (resume && !resumed) {
      await next.close();
      throw new LocalAgentError(
        'RESUME_UNAVAILABLE',
        'Cindy 原会话已不存在，请在调用应用中开始新的任务。未重放旧消息。',
      );
    }
    handle = next;
    next.setInteractionListener(async (request) => {
      if (request.kind === 'permission') {
        const hostTool = input.tools.some((tool) =>
          [`mcp__${input.mcpName}__${tool.name}`, `mcp:${input.mcpName}:${tool.name}`].includes(
            request.toolName,
          ),
        );
        return {
          kind: 'permission',
          behavior: input.access === 'full' || hostTool ? 'allow' : 'deny',
          reason: 'The authorized client controls this session tool surface.',
        };
      }
      // Native interactive prompts cannot be answered on behalf of the user. The dismissal
      // goes back to the engine first; the turn fails once it actually settles.
      projection.failAtEnd(
        localize('INTERACTION_UNAVAILABLE', 'Cindy 引擎需要交互确认，当前应用无法接收。'),
      );
      if (request.kind === 'ask_user_question')
        return { kind: 'ask_user_question', answers: {}, dismissed: true };
      return {
        kind: 'plan_review',
        behavior: 'deny',
        dismissed: true,
        reason: 'host_interaction_unavailable',
      };
    });
    const unsubscribe = next.onEvent((event) => {
      if (handle !== next || closed) return;
      const claimed =
        event.type === 'done' && next.beginTurnContinuationWait(event.turnContinuationId) !== null;
      projection.accept(event, !claimed);
      if (!preparing && !claimed && next.getObservedCurrentTurnTerminal().kind !== 'none') {
        busy = false;
        releaseInputs();
      }
    });
    next.onStatusChange((status) => {
      if (status === 'closed') unsubscribe();
      if (!closed && handle === next && !preparing && (status === 'closed' || status === 'error')) {
        busy = false;
        projection.fail(localize('SESSION_UNAVAILABLE', 'Cindy 执行连接已结束。'));
      }
    });
    return next;
  };
  try {
    handle = await start(input.resume);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  // Images are written per message; a message the engine never took must not leave them behind.
  const discard = async (content: UserMessage) => {
    if (Array.isArray(content.content))
      await Promise.all(
        content.content.map((block) =>
          block.type === 'image' ? fs.rm(block.path, { force: true }) : undefined,
        ),
      ).catch(() => {});
  };
  // Inputs the engine took during the current turn; it no longer reads them once the turn settles.
  let turnInputs: UserMessage[] = [];
  const releaseInputs = () => {
    for (const content of turnInputs.splice(0)) void discard(content);
  };
  const message = async (params: Record<string, unknown>): Promise<UserMessage> => {
    if (!Array.isArray(params.parts) || !params.parts.length || params.parts.length > 64)
      throw new LocalAgentError('INVALID_INPUT', '消息内容无效。');
    const blocks: UserContentBlock[] = [];
    try {
      await collect(params.parts, blocks);
    } catch (error) {
      await discard({ type: 'user', content: blocks });
      throw error;
    }
    return { type: 'user', content: blocks };
  };
  const collect = async (parts: unknown[], blocks: UserContentBlock[]) => {
    for (const raw of parts) {
      const part = object(raw);
      if (part.type === 'text' && typeof part.text === 'string') {
        // A tool policy is not an input blacklist: paths and slash-prefixed text
        // remain usable. Escape the CLI command prefix only for client-only calls.
        blocks.push({
          type: 'text',
          text: input.access === 'none' && part.text.startsWith('/') ? ` ${part.text}` : part.text,
        });
      } else if (
        part.type === 'image' &&
        input.model.images &&
        typeof part.data === 'string' &&
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(string(part.mimeType))
      ) {
        const bytes = Buffer.from(part.data, 'base64');
        if (!bytes.length || bytes.length > 10 * 1024 * 1024)
          throw new LocalAgentError('INVALID_IMAGE', '图片超过接入限制。');
        const file = path.join(
          temporary,
          randomUUID() +
            ({
              'image/png': '.png',
              'image/jpeg': '.jpg',
              'image/webp': '.webp',
              'image/gif': '.gif',
            }[string(part.mimeType)] ?? ''),
        );
        blocks.push({
          type: 'image',
          path: file,
          mimeType: string(part.mimeType),
          pathOrigin: 'desktop-host',
        });
        await fs.writeFile(file, bytes, { mode: 0o600 });
      } else throw new LocalAgentError('INVALID_INPUT', '所选 Cindy 模型不支持这类输入。');
    }
  };
  return {
    get id() {
      return handle.sdkSessionId;
    },
    get resumed() {
      return resumed;
    },
    async call(method, params) {
      if (closed) throw new LocalAgentError('SESSION_UNAVAILABLE', 'Cindy 会话已关闭。');
      if (method === 'interrupt') {
        const interrupted = ++epoch;
        busy = true;
        try {
          await handle.abort();
        } finally {
          if (epoch === interrupted) {
            busy = false;
            preparing = false;
          }
        }
        return {};
      }
      if (method === 'instructions') {
        instructions = typeof params.instructions === 'string' ? params.instructions : undefined;
        instructionsVersion += 1;
        return {};
      }
      if (method !== 'send' && method !== 'steer')
        throw new LocalAgentError('METHOD_UNSUPPORTED', '不支持此会话操作。');
      if (params.model !== undefined && params.model !== input.model.id)
        throw new LocalAgentError('MODEL_CHANGED', '模型已更改，请在新会话边界重新连接。');
      if (params.effort !== undefined && !input.model.efforts.includes(string(params.effort)))
        throw new LocalAgentError('INVALID_EFFORT', '思考力度不可用。');
      if (method === 'steer') {
        const current = epoch;
        if (!busy || preparing)
          throw new LocalAgentError('NOT_RUNNING', '当前没有正在运行的回答。');
        const content = await message(params);
        try {
          assertCurrent(current);
          if (!busy) throw new LocalAgentError('NOT_RUNNING', '当前没有正在运行的回答。');
          await handle.steer(content);
          turnInputs.push(content);
        } catch (error) {
          await discard(content);
          throw error;
        }
        return {};
      }
      if (busy) throw new LocalAgentError('BUSY', '当前回答尚未结束。');
      const current = ++epoch;
      busy = true;
      preparing = true;
      let content: UserMessage | undefined;
      try {
        content = await message(params);
        assertCurrent(current);
        if (appliedInstructions !== instructionsVersion) {
          const previous = handle;
          await previous.close();
          assertCurrent(current);
          const applying = instructionsVersion;
          handle = await start(previous.sdkSessionId, current);
          appliedInstructions = applying;
        }
        if (params.effort !== undefined) {
          await handle.setEffort(params.effort as Parameters<Session['setEffort']>[0]);
          effort = string(params.effort);
        }
        assertCurrent(current);
        preparing = false;
        const generation = ++turn;
        projection.begin();
        // Some harnesses await the entire turn; acceptance must not block tool delivery/control RPCs.
        const sending = content;
        releaseInputs();
        turnInputs.push(sending);
        void (async () => {
          const result = await handle.send(sending);
          if (!result.accepted) await discard(sending);
          assertSendDispatched(result, 'local-agent/send');
        })().catch(() => {
          if (closed || turn !== generation) return;
          if (epoch === current) {
            busy = false;
            projection.fail(localize('EXECUTION_FAILED', 'Cindy 未能完成本次发送。'));
          } else {
            // An interrupt cancelled the turn before the supplier saw it: no native terminal follows.
            projection.fail('', 'interrupted');
          }
        });
        return {};
      } catch (error) {
        if (epoch === current) {
          busy = false;
          preparing = false;
        }
        if (content) await discard(content);
        throw error;
      }
    },
    async close() {
      closed = true;
      ++epoch;
      busy = false;
      await handle.close({ reason: 'account-boundary' });
      // The engine is confirmed closed; leftover input files must not report it as still running.
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    },
  };
}
