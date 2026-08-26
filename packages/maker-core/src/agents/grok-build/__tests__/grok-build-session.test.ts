import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GrokBuildAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const fakeGrok = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-grok-acp.mjs');

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function buildAgent(env: NodeJS.ProcessEnv = {}) {
  const registered: Array<{ pid: number; kind: string; role: string }> = [];
  const deps: AgentDeps = {
    auth: {
      getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => env,
    },
    runtimeConfig: {},
    binaryPath: fakeGrok,
    logger: noopLogger,
    registerLocalAgentProcess: (info) => {
      registered.push(info);
    },
  };
  return { agent: new GrokBuildAgent(deps), registered };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectUntil(
  events: AsyncIterable<{ type: string; data?: { message?: string } }>,
  predicate: (seen: Array<{ type: string; data?: { message?: string } }>) => boolean,
  timeoutMs = 3_000,
): Promise<Array<{ type: string; data?: { message?: string } }>> {
  const seen: Array<{ type: string; data?: { message?: string } }> = [];
  const iter = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      iter.next(),
      delay(remaining).then(() => ({ done: true as const, value: undefined })),
    ]);
    if (next.done || next.value == null) break;
    seen.push(next.value);
    if (predicate(seen)) return seen;
  }
  return seen;
}

describe('GrokBuildAgent startSession / send lifetime', () => {
  it('registers the child via onProcessSpawned once and closes ACP if initialize fails', async () => {
    const { agent, registered } = buildAgent({ FAKE_GROK_FAIL_INIT: '1' });
    await expect(agent.startSession({ workingDir: process.cwd(), model: 'grok-build' }))
      .rejects.toThrow(/initialize failed/);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ kind: 'grok-build', role: 'task-host' });
    expect(registered[0]?.pid).toBeGreaterThan(0);
    await delay(50);
    expect(() => process.kill(registered[0]!.pid, 0)).toThrow();
  });

  it('returns send() once the first session/update arrives, keeping prompt in-flight for abort', async () => {
    const { agent, registered } = buildAgent({ FAKE_GROK_PROMPT_DELAY_MS: '2000' });
    const handle = await agent.startSession({ workingDir: process.cwd(), model: 'grok-build' });
    expect(registered).toHaveLength(1);

    const sending = handle.send({ content: 'hello' });
    const seen = await collectUntil(handle.events(), (events) => events.some((e) => e.type === 'text'));
    expect(seen.some((e) => e.type === 'text')).toBe(true);
    await expect(sending).resolves.toBeUndefined();

    await handle.abort();
    await handle.close();
  });

  it('throws from send() when session/prompt errors before any update', async () => {
    const { agent } = buildAgent({ FAKE_GROK_FAIL_PROMPT: '1' });
    const handle = await agent.startSession({ workingDir: process.cwd(), model: 'grok-build' });
    await expect(handle.send({ content: 'hello' })).rejects.toThrow(/prompt rejected/);
    await handle.close();
  });

  it('does not throw from send() when session/prompt errors after a turn update', async () => {
    const { agent } = buildAgent({
      FAKE_GROK_FAIL_PROMPT: '1',
      FAKE_GROK_UPDATE_BEFORE_ERROR: '1',
    });
    const handle = await agent.startSession({ workingDir: process.cwd(), model: 'grok-build' });
    const sending = handle.send({ content: 'hello' });
    await expect(sending).resolves.toBeUndefined();
    const seen = await collectUntil(
      handle.events(),
      (events) => events.some((e) => e.type === 'error' && Boolean(e.data?.message?.includes('late failure'))),
    );
    expect(seen.some((e) => e.type === 'error' && e.data?.message?.includes('late failure'))).toBe(true);
    await handle.close();
  });
});
