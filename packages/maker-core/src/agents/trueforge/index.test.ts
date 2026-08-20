import { describe, expect, it, vi } from 'vitest';

import { TrueForgeAgent } from './index.js';

function makeStream(events: unknown[]) {
  return {
    async *withMetadata() {
      for (const data of events) yield { data };
    },
  };
}

function makeClient() {
  return {
    fetch: vi.fn(async () => ({ ok: true })),
    sessions: {
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ data: { id: 'tf-session' } })),
      createTurnStream: vi.fn(async (_id: string, _body: unknown, _options?: unknown) =>
        makeStream([
          { type: 'turn.created', id: 'turn-1' },
          { type: 'model.message.delta', id: 'message-1', content: 'ok' },
          {
            type: 'turn.done',
            id: 'turn-1',
            state: {
              status: 'done',
              metrics: {
                totalInputTokens: 2,
                totalOutputTokens: 1,
                totalTokens: 3,
              },
            },
          },
        ]),
      ),
      cancel: vi.fn(async () => ({})),
    },
  };
}

function makeAgent(client: ReturnType<typeof makeClient>) {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };
  return new TrueForgeAgent(
    {
      auth: {
        async getState() {
          return { authenticated: true };
        },
        async triggerLogin() {
          return { authenticated: true };
        },
        async logout() {},
        async getAuthEnv() {
          return {};
        },
      },
      runtimeConfig: {},
      binaryPath: '',
      runtimeKind: 'service',
      logger,
    } as never,
    {
      baseUrl: 'http://127.0.0.1:8787',
      model: 'openai/gpt-5',
      contextWindow: 128_000,
      client,
    },
  );
}

async function start(agent: TrueForgeAgent, overrides: Record<string, unknown> = {}) {
  return agent.startSession({
    workingDir: '',
    model: 'openai/gpt-5',
    permissionMode: 'ask',
    ...overrides,
  } as never);
}

describe('TrueForgeAgent', () => {
  it('creates a session with dynamic subagents disabled and streams a turn', async () => {
    const client = makeClient();
    const handle = await start(makeAgent(client));
    const events = handle.events()[Symbol.asyncIterator]();
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'session_id', source: 'trueforge', data: 'tf-session' },
    });
    await handle.send({ type: 'user', content: 'hello' });
    await vi.waitFor(() => expect(client.sessions.createTurnStream).toHaveBeenCalledTimes(1));

    expect(client.sessions.create).toHaveBeenCalledWith({
      agent: {
        spec: {
          model: { name: 'openai/gpt-5' },
          config: { dynamicSubAgents: { enabled: false } },
        },
      },
    });
    expect(client.sessions.createTurnStream).toHaveBeenCalledWith(
      'tf-session',
      { input: [{ type: 'user.message', content: 'hello' }] },
      { abortSignal: expect.any(AbortSignal) },
    );
    await handle.close();
  });

  it('poisons the handle when a cancel cannot be confirmed', async () => {
    const client = makeClient();
    client.sessions.createTurnStream.mockImplementationOnce(async (_id, _body, options) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    client.sessions.cancel.mockRejectedValueOnce(new Error('cancel timeout'));
    const handle = await start(makeAgent(client));
    const first = handle.send({ type: 'user', content: 'first' });
    await vi.waitFor(() => expect(client.sessions.createTurnStream).toHaveBeenCalledTimes(1));

    await handle.abort();
    await expect(first).rejects.toThrow(/aborted/);
    await expect(handle.send({ type: 'user', content: 'second' })).rejects.toThrow(/closed/);
  });

  it('only clears a resume id after an explicit 404', async () => {
    const authFailure = makeClient();
    authFailure.sessions.get.mockRejectedValueOnce({ statusCode: 401 });
    const invalidAuthResume = vi.fn(async () => true);
    await expect(
      start(makeAgent(authFailure), {
        resumeSessionId: 'persisted',
        onInvalidResumeSession: invalidAuthResume,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(invalidAuthResume).not.toHaveBeenCalled();

    const missing = makeClient();
    missing.sessions.get.mockRejectedValueOnce({ statusCode: 404 });
    const clearMissingResume = vi.fn(async () => true);
    const handle = await start(makeAgent(missing), {
      resumeSessionId: 'missing',
      onInvalidResumeSession: clearMissingResume,
    });
    expect(clearMissingResume).toHaveBeenCalledWith('missing');
    expect(missing.sessions.create).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('gates concurrent sends during the HTTP handshake and aborts locally first', async () => {
    const client = makeClient();
    let observedSignal: AbortSignal | undefined;
    client.sessions.createTurnStream.mockImplementationOnce(async (_id, _body, options) => {
      observedSignal = (options as { abortSignal: AbortSignal }).abortSignal;
      return await new Promise((_, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    });
    const handle = await start(makeAgent(client));
    const first = handle.send({ type: 'user', content: 'first' });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await expect(handle.send({ type: 'user', content: 'second' })).rejects.toThrow(/already has/);
    await handle.abort();
    expect(observedSignal?.aborted).toBe(true);
    await expect(first).rejects.toThrow(/aborted/);
    expect(client.sessions.cancel).toHaveBeenCalledWith('tf-session', undefined, {
      timeoutInSeconds: 5,
      maxRetries: 0,
    });
    await handle.close();
  });
});
