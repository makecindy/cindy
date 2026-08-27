import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GrokBuildAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const fakeGrokScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-grok-acp.mjs');

/**
 * 被控端把 grok 当普通可执行文件 spawn(不过 shell),所以这里不能直接把 .mjs 当
 * binaryPath —— CI runner 上没有 bun / node 未必在 PATH。跟 Pi 侧同款做法:写一个
 * sh wrapper 显式 exec 当前 node 去跑假 grok。Windows 上 spawn 不过 shell 起不了
 * .cmd(Node ≥18.20 直接 EINVAL),整组按仓库既有约定跳过。
 */
let fakeGrok = '';
let wrapperDir = '';

beforeAll(async () => {
  wrapperDir = await mkdtemp(path.join(tmpdir(), 'grok-build-fake-'));
  fakeGrok = path.join(wrapperDir, 'grok');
  await writeFile(fakeGrok, `#!/bin/sh\nexec "${process.execPath}" "${fakeGrokScript}" "$@"\n`);
  await chmod(fakeGrok, 0o700);
});

afterAll(async () => {
  if (wrapperDir) await rm(wrapperDir, { force: true, recursive: true });
});

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function buildAgent(env: Record<string, string> = {}) {
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

/** AgentEvent 的 data 是按 type 分叉的联合;测试只关心 error 上的 message。 */
function eventMessage(event: AgentEvent): string {
  const data: unknown = (event as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return '';
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

async function collectUntil(
  events: AsyncIterable<AgentEvent>,
  predicate: (seen: AgentEvent[]) => boolean,
  timeoutMs = 3_000,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
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

describe.skipIf(process.platform === 'win32')('GrokBuildAgent startSession / send lifetime', () => {
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

    const sending = handle.send({ type: 'user', content: 'hello' });
    const seen = await collectUntil(handle.events(), (events) => events.some((e) => e.type === 'text'));
    expect(seen.some((e) => e.type === 'text')).toBe(true);
    await expect(sending).resolves.toBeUndefined();

    await handle.abort();
    await handle.close();
  });

  it('throws from send() when session/prompt errors before any update', async () => {
    const { agent } = buildAgent({ FAKE_GROK_FAIL_PROMPT: '1' });
    const handle = await agent.startSession({ workingDir: process.cwd(), model: 'grok-build' });
    await expect(handle.send({ type: 'user', content: 'hello' })).rejects.toThrow(/prompt rejected/);
    await handle.close();
  });

  it('does not throw from send() when session/prompt errors after a turn update', async () => {
    const { agent } = buildAgent({
      FAKE_GROK_FAIL_PROMPT: '1',
      FAKE_GROK_UPDATE_BEFORE_ERROR: '1',
    });
    const handle = await agent.startSession({ workingDir: process.cwd(), model: 'grok-build' });
    const sending = handle.send({ type: 'user', content: 'hello' });
    await expect(sending).resolves.toBeUndefined();
    const seen = await collectUntil(
      handle.events(),
      (events) => events.some((e) => e.type === 'error' && eventMessage(e).includes('late failure')),
    );
    expect(seen.some((e) => e.type === 'error' && eventMessage(e).includes('late failure'))).toBe(true);
    await handle.close();
  });
});
