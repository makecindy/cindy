import { describe, expect, it, vi } from 'vitest';

import { projectSessionActivity } from '@cindy/maker-shared/session-activity';
import {
  createSessionActivityReader,
  type PersistedSessionActivityFacts,
} from '../sessionActivityProjection.js';

function facts(
  patch: Partial<PersistedSessionActivityFacts> = {},
): PersistedSessionActivityFacts {
  return {
    status: 'active',
    title: '任务',
    startedAt: null,
    endedAt: null,
    clearedAt: null,
    ...patch,
  };
}

function setup(opts?: {
  live?: ReturnType<typeof projectSessionActivity> | null;
  persisted?: PersistedSessionActivityFacts | null;
  terminal?: { status: 'error'; createdAt?: number };
  turnRunning?: boolean;
}) {
  const deps = {
    getLiveSnapshot: vi.fn(() => opts?.live ?? null),
    getPersistedFacts: vi.fn(async () =>
      opts && 'persisted' in opts ? (opts.persisted ?? null) : facts(),
    ),
    getLatestTerminal: vi.fn(async () => opts?.terminal),
    isTurnRunning: vi.fn(() => opts?.turnRunning === true),
  };
  return { deps, read: createSessionActivityReader(deps) };
}

describe('canonical session activity reader', () => {
  it('uses the live Agent Island snapshot without consulting cold storage', async () => {
    const live = projectSessionActivity({
      sessionId: 'live',
      recordStatus: 'active',
      source: 'live',
      livePhase: 'needs-interaction',
      startedAtMs: 10,
      lastActivityAtMs: 20,
      currentActionSummary: '等待用户确认',
      attention: true,
    });
    const { deps, read } = setup({ live });

    await expect(read('live')).resolves.toBe(live);
    expect(deps.getPersistedFacts).not.toHaveBeenCalled();
    expect(deps.getLatestTerminal).not.toHaveBeenCalled();
  });

  it('projects a durable normal completion, record lifecycle and title workflow', async () => {
    const { read } = setup({
      persisted: facts({
        status: 'archived',
        title: '🚧#2804 会话控制面 · 待bot',
        startedAt: 100,
        endedAt: 200,
      }),
    });

    await expect(read('completed')).resolves.toMatchObject({
      sessionId: 'completed',
      recordStatus: 'archived',
      phase: 'completed',
      source: 'persisted',
      startedAtMs: 100,
      lastActivityAtMs: 200,
      currentActionSummary: '上次运行已正常结束',
      attention: false,
      workflow: {
        key: 'awaiting-bot',
        label: '待bot',
        waitingOn: 'automation',
      },
    });
  });

  it('projects an error terminal without exposing its persisted body', async () => {
    const { deps, read } = setup({
      persisted: facts({ startedAt: 100, endedAt: 150, clearedAt: 80 }),
      terminal: { status: 'error', createdAt: 175 },
    });

    await expect(read('failed')).resolves.toMatchObject({
      phase: 'error',
      lastActivityAtMs: 175,
      currentActionSummary: '上次运行出错',
      attention: true,
    });
    expect(deps.getLatestTerminal).toHaveBeenCalledWith('failed', 80);
  });

  it('marks a started turn beyond every durable close boundary as interrupted', async () => {
    const { read } = setup({
      persisted: facts({ startedAt: 300, endedAt: 200, clearedAt: 250 }),
    });

    await expect(read('interrupted')).resolves.toMatchObject({
      phase: 'error',
      startedAtMs: 300,
      lastActivityAtMs: 300,
      currentActionSummary: '上次运行未正常结束',
      attention: true,
    });
  });

  // 依据:#13394 与 src/main/localDb/sessionActiveTurn.ts 的规则——「疑似中断」要求会话空闲。
  // 最小失败输入:起过新 turn(startedAt > endedAt)但这一轮仍在跑。
  it('does not read a turn that is still running as an interrupted one', async () => {
    const { read } = setup({
      persisted: facts({ startedAt: 300, endedAt: 200, clearedAt: 250 }),
      turnRunning: true,
    });

    await expect(read('working')).resolves.toMatchObject({
      phase: 'running',
      currentTurnActive: true,
      currentActionSummary: null,
      attention: false,
    });
  });

  // 上一轮的错误是历史:相位可以仍是 error(错误在右侧优先),但当前这一轮在跑要能读出来,
  // 摘要据此报 running 而不是 errored。
  it('keeps the durable error in phase while the newer turn is active', async () => {
    const { read } = setup({
      persisted: facts({ startedAt: 300, endedAt: 200, clearedAt: 250 }),
      terminal: { status: 'error', createdAt: 260 },
      turnRunning: true,
    });

    await expect(read('working')).resolves.toMatchObject({
      phase: 'error',
      currentTurnActive: true,
      currentActionSummary: '上次运行出错',
    });
  });

  it('does not resurrect terminal state from before the clear boundary', async () => {
    const { deps, read } = setup({
      persisted: facts({
        status: 'deleted',
        title: '任务 · 等待外部系统',
        startedAt: 100,
        endedAt: 150,
        clearedAt: 200,
      }),
    });

    await expect(read('cleared')).resolves.toMatchObject({
      recordStatus: 'deleted',
      phase: 'idle',
      attention: false,
      currentActionSummary: null,
      workflow: { key: 'title:等待外部系统' },
    });
    expect(deps.getLatestTerminal).toHaveBeenCalledWith('cleared', 200);
  });

  it('fails closed to an idle fallback when the session row disappears', async () => {
    const { read } = setup({ persisted: null });
    await expect(read('missing')).resolves.toMatchObject({
      sessionId: 'missing',
      phase: 'idle',
      source: 'fallback',
    });
  });
});
