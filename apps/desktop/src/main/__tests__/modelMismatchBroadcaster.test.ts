/**
 * modelMismatchBroadcaster.test.ts
 * ---------------------------------------------------------------------------
 * 模型降级标记挂载(AssistantMessage 降级提示行)的 main 侧业务体:
 *   - recordModelMismatchOnMessage:patch 成功才广播;patch false(行不存在,
 *     典型 rewind 已删)不广播;selected / actual 缺失直接跳过;patch 抛错只吞
 *     不传播。
 *
 * 默认 deps(BrowserWindow / enqueueDurableWrite / patchMessageAgentMeta)走
 * 依赖注入替换,测试不触达 Electron / sqlite。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/ipc/messages.js', () => ({
  patchMessageAgentMeta: vi.fn(async () => true),
}));
vi.mock('../messagePersistBroadcaster.desktop.js', () => ({
  enqueueDurableWrite: vi.fn((_label: string, fn: () => unknown) => Promise.resolve(fn())),
}));

import {
  recordModelMismatchOnMessage,
  type ModelMismatchDeps,
  type MessageModelMismatchPayload,
} from '../modelMismatchBroadcaster.js';

function makeDeps(patchResult: boolean | Error = true) {
  const broadcasts: MessageModelMismatchPayload[] = [];
  const patchCalls: Array<{ sessionId: string; clientId: string; patch: Record<string, unknown> }> = [];
  const deps: ModelMismatchDeps = {
    patchAgentMeta: vi.fn(async (sessionId, clientId, patch) => {
      patchCalls.push({ sessionId, clientId, patch });
      if (patchResult instanceof Error) throw patchResult;
      return patchResult;
    }),
    enqueue: (_label, fn) => Promise.resolve(fn()),
    broadcast: (payload) => {
      broadcasts.push(payload);
    },
  };
  return { deps, broadcasts, patchCalls };
}

const MISMATCH = { selected: 'claude-fable-5', actual: 'claude-opus-4-8' };
const ARGS = { sessionId: 's1', clientId: 'm1', mismatch: MISMATCH };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordModelMismatchOnMessage', () => {
  it('patch 成功 → 写入 agent_meta.modelMismatch 并广播同值', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(true);
    await recordModelMismatchOnMessage(ARGS, deps);
    expect(patchCalls).toEqual([
      { sessionId: 's1', clientId: 'm1', patch: { modelMismatch: MISMATCH } },
    ]);
    expect(broadcasts).toEqual([
      { sessionId: 's1', clientId: 'm1', modelMismatch: MISMATCH },
    ]);
  });

  it('patch 返回 false(行不存在,典型 rewind 已删)→ 不广播', async () => {
    const { deps, broadcasts, patchCalls } = makeDeps(false);
    await recordModelMismatchOnMessage(ARGS, deps);
    expect(patchCalls).toHaveLength(1);
    expect(broadcasts).toHaveLength(0);
  });

  it('sessionId / clientId / selected / actual 任一缺失 → 跳过', async () => {
    const { deps, patchCalls } = makeDeps(true);
    await recordModelMismatchOnMessage({ ...ARGS, sessionId: '' }, deps);
    await recordModelMismatchOnMessage({ ...ARGS, clientId: '' }, deps);
    await recordModelMismatchOnMessage(
      { ...ARGS, mismatch: { selected: '', actual: 'claude-opus-4-8' } },
      deps,
    );
    await recordModelMismatchOnMessage(
      { ...ARGS, mismatch: { selected: 'claude-fable-5', actual: '' } },
      deps,
    );
    expect(patchCalls).toHaveLength(0);
  });

  it('patch 抛错 → 吞掉不传播、不广播', async () => {
    const { deps, broadcasts } = makeDeps(new Error('db locked'));
    await expect(recordModelMismatchOnMessage(ARGS, deps)).resolves.toBeUndefined();
    expect(broadcasts).toHaveLength(0);
  });
});
