import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { LearnRunPublic } from '../../../shared/learnTypes';
import {
  LearnController,
  LearnError,
  type LearnControllerDeps,
  type LearnRunStoreLike,
  type LearnSessionLike,
  type LearnSessionSendResult,
} from '../controller';
import type { ScanStagingResult } from '../staging';
import { computeProposalFingerprint } from '../stagingValidation.pure';
import { tryAcquireSkillInstallLock } from '../../skillhub/installLock';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ── 内存 fakes ───────────────────────────────────────────────────────────────

class FakeStore implements LearnRunStoreLike {
  runs = new Map<string, LearnRunPublic>();
  async load(): Promise<void> {}
  list(): LearnRunPublic[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  get(runId: string): LearnRunPublic | undefined {
    return this.runs.get(runId);
  }
  async put(run: LearnRunPublic): Promise<void> {
    this.runs.set(run.runId, run);
  }
}

class FakeSession implements LearnSessionLike {
  id = 'fake-session-1';
  listeners: Array<(ev: { type: string; data?: unknown }) => void> = [];
  sent: string[] = [];
  aborted = false;
  sendResult: LearnSessionSendResult = { accepted: true };
  callOnAcceptedBeforeRejected = false;
  async send(
    message: { type: 'user'; content: string },
    opts?: { onAccepted?: () => Promise<void> | void },
  ): Promise<LearnSessionSendResult> {
    this.sent.push(message.content);
    if (this.sendResult.accepted || this.callOnAcceptedBeforeRejected) {
      await opts?.onAccepted?.();
    }
    return this.sendResult;
  }
  onEvent(listener: (ev: { type: string; data?: unknown; turnContinuationId?: number }) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  emit(ev: { type: string; data?: unknown; turnContinuationId?: number }): void {
    for (const l of [...this.listeners]) l(ev);
  }
}

const SKILL_MD = '---\nname: my-skill\ndescription: A test skill.\nversion: "0.1.0"\n---\n\n# T\n\nBody.\n';

interface Harness {
  controller: LearnController;
  store: FakeStore;
  session: FakeSession;
  cleanupCalls: string[];
  applyCalls: unknown[];
  freezeCalls: Array<{ runId: string; dirName: string }>;
  unfreezeCalls: string[];
  setScan: (result: ScanStagingResult) => void;
  setBeforeScan: (hook: (() => Promise<void>) | null) => void;
  waitForStatus: (runId: string, status: LearnRunPublic['status']) => Promise<LearnRunPublic>;
}

type HarnessOverrides = Omit<Partial<LearnControllerDeps>, 'staging'> & {
  staging?: Partial<LearnControllerDeps['staging']>;
};

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const store = new FakeStore();
  const session = new FakeSession();
  const cleanupCalls: string[] = [];
  const applyCalls: unknown[] = [];
  const freezeCalls: Array<{ runId: string; dirName: string }> = [];
  const unfreezeCalls: string[] = [];
  let scanResult: ScanStagingResult = { candidates: [] };
  let beforeScan: (() => Promise<void>) | null = null;
  const stagingRoot = path.join('/', 'fake-staging');
  const { staging: stagingOverrides, ...depOverrides } = overrides;

  const deps: LearnControllerDeps = {
    createSession: async () => session,
    isTerminalErrorEvent: (ev) => ev.type === 'error',
    getAppLocale: () => 'zh-CN',
    getCurrentDataOwnerId: () => 'u1',
    collectProfile: async () => ({ block: '--- Chris (user) ---\nprefers concise answers', used: true }),
    getSessionWorkdir: async () => null,
    getConversationBlock: async () => 'User: run pnpm test first\n\nAssistant: done, 53 passed',
    getInstalledSkillsIndex: async () => '- xdmaker-dev: XDMaker 开发规则 [/skills/xdmaker-dev]',
    search: async () => ({
      hits: [
        {
          messageId: 'm1',
          sessionId: 's1',
          role: 'user',
          createdAt: 1750000000000,
          snippet: null,
          score: 1,
          ftsRank: 1,
          vectorRank: null,
          vectorDistance: null,
          context: [
            {
              id: 'm1',
              sessionId: 's1',
              role: 'user',
              content: 'this is how I usually deploy',
              toolUseId: null,
              agentMeta: null,
              createdAt: 1750000000000,
              rewindAt: null,
              isHit: true,
            },
          ],
        },
      ],
      sessions: {},
      nextCursor: null,
      vectorUsed: false,
    } as never),
    store,
    broadcast: vi.fn(),
    staging: {
      create: async (runId) => path.join(stagingRoot, runId),
      scan: async () => {
        const captured = scanResult;
        await beforeScan?.();
        return captured;
      },
      cleanup: async (runId) => {
        cleanupCalls.push(runId);
      },
      renameProposalDir: async (absPath, newName) => path.join(path.dirname(absPath), newName),
      // 冻结 fake:返回冻结区路径;collectProposal 以"当前 scanResult"为冻结副本
      // 内容(测试用 setScan 表达点击时刻/冻结时刻的真实文件集)。
      freezeProposal: async (runId, dirName) => {
        freezeCalls.push({ runId, dirName });
        return path.join(stagingRoot, `${runId}.apply`, dirName);
      },
      collectProposal: async () => {
        const c = scanResult.candidates[0];
        return c ? { files: c.files, violations: c.violations } : { files: [], violations: [] };
      },
      unfreezeProposal: async (frozenAbsPath) => {
        unfreezeCalls.push(frozenAbsPath);
      },
      dirForRun: (runId) => path.join(stagingRoot, runId),
      writeReferenceFiles: async (runId, slug) => path.join(stagingRoot, runId, '_reference', slug),
      ...stagingOverrides,
    },
    applyProposal: async (params) => {
      applyCalls.push(params);
      return { name: params.skillName, absolutePath: `/skills/${params.skillName}` };
    },
    computeDiff: async () => [],
    computeTargetFingerprint: async (dir) => `hash:${dir}`,
    resolveInstalledSkillDir: (name) => path.join('/', 'installed', name),
    dirExists: async (dir) => dir.startsWith(stagingRoot),
    readFileText: async () => null,
    persistUserMessage: vi.fn(async () => {}),
    backfillSessionMeta: vi.fn(async () => {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...depOverrides,
  };

  const controller = new LearnController(deps);
  return {
    controller,
    store,
    session,
    cleanupCalls,
    applyCalls,
    freezeCalls,
    unfreezeCalls,
    setScan: (r) => {
      scanResult = r;
    },
    setBeforeScan: (hook) => {
      beforeScan = hook;
    },
    waitForStatus: async (runId, status) => {
      await vi.waitFor(() => {
        expect(store.get(runId)?.status).toBe(status);
      }, { interval: 1 });
      return store.get(runId)!;
    },
  };
}

const goodScan = (dirName = 'my-skill'): ScanStagingResult => ({
  candidates: [
    {
      dirName,
      absPath: path.join('/', 'fake-staging', 'x', dirName),
      files: [{ relPath: 'SKILL.md', size: SKILL_MD.length, text: SKILL_MD }],
      violations: [],
    },
  ],
});

describe('LearnController 状态机', () => {
  it('freetext 全流程:collecting → distilling → awaiting-review', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'learn my deploy flow', sourceKind: 'freetext' });

    await h.waitForStatus(runId, 'distilling');
    // 证据实际命中 → usedSessionEvidence
    expect(h.store.get(runId)!.usedSessionEvidence).toBe(true);
    // 发给模型的是完整 prompt,落库的是干净 /learn 文案
    expect(h.session.sent[0]).toContain('LOCAL USAGE EVIDENCE');
    expect(h.session.sent[0]).toContain('USER PROFILE');
    expect(h.session.sent[0]).toContain('prefers concise answers');
    expect(h.session.sent[0]).toContain('INSTALLED SKILLS INDEX');
    expect(h.session.sent[0]).toContain('learn my deploy flow');
    // freetext 模式不注入当前会话块
    expect(h.session.sent[0]).not.toContain('THE CURRENT CONVERSATION');

    h.session.emit({ type: 'text', data: { text: 'created my-skill', isFinal: true } });
    h.session.emit({ type: 'done', turnContinuationId: 1 });
    expect(h.store.get(runId)!.status).toBe('distilling');
    h.session.emit({ type: 'done' });

    const run = await h.waitForStatus(runId, 'awaiting-review');
    expect(run.skillName).toBe('my-skill');
    expect(run.proposalFiles).toEqual(['SKILL.md']);
    expect(run.assistantText).toBe('created my-skill');
  });

  it('distillation 直发路径注入 pending handoff,但落库仍保留干净 /learn 文案', async () => {
    const peekPendingHandoff = vi.fn(async () => 'HANDOFF');
    const consumePendingHandoff = vi.fn();
    const persistUserMessage = vi.fn(async () => {});
    const h = makeHarness({ peekPendingHandoff, consumePendingHandoff, persistUserMessage });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'learn my deploy flow', sourceKind: 'freetext' });

    await h.waitForStatus(runId, 'distilling');
    expect(h.session.sent[0]?.startsWith('HANDOFF\n\n')).toBe(true);
    expect(h.session.sent[0]).toContain('learn my deploy flow');
    expect(persistUserMessage).toHaveBeenCalledWith('fake-session-1', '/learn learn my deploy flow');
    expect(consumePendingHandoff).toHaveBeenCalledWith('fake-session-1');

    h.session.emit({ type: 'text', data: { text: 'created my-skill', isFinal: true } });
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
  });

  it('蒸馏 send 未接受时回滚 git baseline 并失败收口', async () => {
    const order: string[] = [];
    const beforeDispatchUserTurn = vi.fn(async () => undefined);
    beforeDispatchUserTurn.mockImplementation(async () => {
      order.push('baseline');
    });
    const onUndispatchedUserTurn = vi.fn(() => {
      order.push('abort');
    });
    const h = makeHarness({
      persistUserMessage: vi.fn(async () => {
        order.push('persist');
      }),
      beforeDispatchUserTurn,
      onUndispatchedUserTurn,
    });
    h.session.sendResult = { accepted: false, reason: 'cancelled-before-dispatch' };
    h.session.callOnAcceptedBeforeRejected = true;

    const { runId } = await h.controller.startLearn({ input: 'learn my deploy flow', sourceKind: 'freetext' });

    const run = await h.waitForStatus(runId, 'failed');
    expect(run.error).toContain('cancelled-before-dispatch');
    expect(beforeDispatchUserTurn).toHaveBeenCalledWith('fake-session-1');
    expect(onUndispatchedUserTurn).toHaveBeenCalledWith('fake-session-1');
    expect(h.session.sent).toHaveLength(1);
    expect(order).toEqual(['persist', 'baseline', 'abort']);
  });

  it('蒸馏 send 已接受后终态错误不按 undispatched 回滚 baseline', async () => {
    const beforeDispatchUserTurn = vi.fn(async () => undefined);
    const onUndispatchedUserTurn = vi.fn();
    const h = makeHarness({
      beforeDispatchUserTurn,
      onUndispatchedUserTurn,
    });

    const { runId } = await h.controller.startLearn({ input: 'learn my deploy flow', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'error', data: { isTerminal: true, message: 'model failed' } });

    const run = await h.waitForStatus(runId, 'failed');
    expect(run.error).toContain('model failed');
    expect(beforeDispatchUserTurn).toHaveBeenCalledWith('fake-session-1');
    expect(onUndispatchedUserTurn).not.toHaveBeenCalled();
  });

  it('空输入 freetext 拒 INVALID_PARAMS;活跃期间第二个 startLearn 拒 LEARN_BUSY', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    await expect(h.controller.startLearn({ input: '  ', sourceKind: 'freetext' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });

    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    await expect(h.controller.startLearn({ input: 'y', sourceKind: 'freetext' })).rejects.toMatchObject({
      code: 'LEARN_BUSY',
    });
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
  });

  it('startLearn 等待启动 resume+sweep 完成后才创建 run/staging', async () => {
    let releaseStartup: (() => void) | undefined;
    const h = makeHarness({
      waitForStartupSweep: () =>
        new Promise<void>((resolve) => {
          releaseStartup = resolve;
        }),
    });
    const starting = h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await vi.waitFor(() => {
      expect(releaseStartup).toBeDefined();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.store.list()).toHaveLength(0);

    releaseStartup!();
    const { runId } = await starting;
    await h.waitForStatus(runId, 'distilling');
  });

  it('agent 空产出 → failed(带 assistantText)+ staging 清理', async () => {
    const h = makeHarness();
    h.setScan({ candidates: [] });
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'text', data: { text: 'what exactly do you want?', isFinal: true } });
    h.session.emit({ type: 'done' });
    const run = await h.waitForStatus(runId, 'failed');
    expect(run.error).toContain('no skill directory');
    expect(run.assistantText).toContain('what exactly');
    expect(h.cleanupCalls).toContain(runId);
  });

  it('校验不过(frontmatter 缺 description)→ failed', async () => {
    const h = makeHarness();
    h.setScan({
      candidates: [
        {
          dirName: 'bad',
          absPath: '/fake-staging/x/bad',
          files: [{ relPath: 'SKILL.md', size: 10, text: '---\nname: bad\n---\n\nBody.\n' }],
          violations: [],
        },
      ],
    });
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    const run = await h.waitForStatus(runId, 'failed');
    expect(run.error).toContain('frontmatter invalid');
  });

  it('终态错误事件 → failed', async () => {
    const h = makeHarness();
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'error', data: { message: 'model exploded' } });
    const run = await h.waitForStatus(runId, 'failed');
    expect(run.error).toContain('model exploded');
  });

  it('超时 → abort + failed', async () => {
    const h = makeHarness({ turnTimeoutMs: 30 });
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    // 30ms 超时可能先于状态轮询,不断言中间态,直接等终态。
    const run = await h.waitForStatus(runId, 'failed');
    expect(run.error).toContain('timed out');
    expect(h.session.aborted).toBe(true);
  });

  it('cancel(distilling)→ cancelled,不被后续 done 覆盖', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    await h.controller.cancel(runId);
    expect(h.store.get(runId)!.status).toBe('cancelled');
    expect(h.session.aborted).toBe(true);
    h.session.emit({ type: 'done' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.store.get(runId)!.status).toBe('cancelled');
  });

  it('apply:provenance 按 usedSessionEvidence 落 personal,状态转 applied', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const result = await h.controller.apply(runId);
    expect(result.name).toBe('my-skill');
    expect(h.applyCalls[0]).toMatchObject({
      skillName: 'my-skill',
      provenance: {
        method: 'learn',
        sourceKind: 'freetext',
        usedSessionEvidence: true,
        personal: true,
        runId,
      },
    });
    expect(h.store.get(runId)!.status).toBe('applied');
    expect(h.cleanupCalls).toContain(runId);
  });

  it('discard → discarded + 清理;非 awaiting-review 调 apply/discard 拒 LEARN_INVALID_STATE', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    await expect(h.controller.apply(runId)).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
    await h.controller.discard(runId);
    expect(h.store.get(runId)!.status).toBe('discarded');
    await expect(h.controller.discard(runId)).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });
  });

  it('目录名 ≠ frontmatter name → 重命名并以 frontmatter 为准', async () => {
    const h = makeHarness();
    h.setScan({
      candidates: [
        {
          dirName: 'wrong-dir',
          absPath: path.join('/', 'fake-staging', 'x', 'wrong-dir'),
          files: [{ relPath: 'SKILL.md', size: SKILL_MD.length, text: SKILL_MD }],
      violations: [],
        },
      ],
    });
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    const run = await h.waitForStatus(runId, 'awaiting-review');
    expect(run.skillName).toBe('my-skill');
  });

  it('对话即迭代:提案就绪后会话再完成一轮 → 重扫更新提案', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
    expect(h.store.get(runId)!.proposalFiles).toEqual(['SKILL.md']);

    // 用户在蒸馏会话里继续说话,模型改完(又一轮 done)→ watcher 重扫
    h.setScan({
      candidates: [
        {
          dirName: 'my-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'my-skill'),
          files: [
            { relPath: 'SKILL.md', size: SKILL_MD.length, text: SKILL_MD },
            { relPath: 'scripts/run.sh', size: 10, text: 'echo hi' },
          ],
          violations: [],
        },
      ],
    });
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(h.store.get(runId)!.proposalFiles).toEqual(['SKILL.md', 'scripts/run.sh']);
    });
    expect(h.store.get(runId)!.status).toBe('awaiting-review');
    expect(h.cleanupCalls).not.toContain(runId);
  });

  it('对话迭代:claimed SDK done 不会提前清活跃态或扫描未完成提案', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    const internals = h.controller as unknown as { revisionTurnActive: Set<string> };
    let rescanStarts = 0;
    h.setBeforeScan(async () => {
      rescanStarts += 1;
    });
    h.session.emit({ type: 'text', data: { text: 'still revising' } });
    expect(internals.revisionTurnActive.has(runId)).toBe(true);

    h.session.emit({ type: 'done', turnContinuationId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rescanStarts).toBe(0);
    expect(internals.revisionTurnActive.has(runId)).toBe(true);

    h.session.emit({ type: 'done' });
    await vi.waitFor(() => expect(rescanStarts).toBe(1));
    expect(internals.revisionTurnActive.has(runId)).toBe(false);
  });

  it('对话迭代:rescan 未结束时收到后续 done 会排队补扫,不丢最新提案', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    let releaseFirstRescan: (() => void) | undefined;
    h.setScan({
      candidates: [
        {
          dirName: 'my-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'my-skill'),
          files: [
            { relPath: 'SKILL.md', size: SKILL_MD.length, text: SKILL_MD },
            { relPath: 'scripts/v1.sh', size: 2, text: 'v1' },
          ],
          violations: [],
        },
      ],
    });
    h.setBeforeScan(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstRescan = () => {
            h.setBeforeScan(null);
            resolve();
          };
        }),
    );
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(releaseFirstRescan).toBeDefined();
    });

    h.setScan({
      candidates: [
        {
          dirName: 'my-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'my-skill'),
          files: [
            { relPath: 'SKILL.md', size: SKILL_MD.length, text: SKILL_MD },
            { relPath: 'scripts/v2.sh', size: 2, text: 'v2' },
          ],
          violations: [],
        },
      ],
    });
    h.session.emit({ type: 'done' });
    releaseFirstRescan!();

    await vi.waitFor(() => {
      expect(h.store.get(runId)!.proposalFiles).toEqual(['SKILL.md', 'scripts/v2.sh']);
    });
  });

  it('对话改坏了提案:重扫失效保留旧版 + error;再改好后 error 清除', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    h.setScan({ candidates: [] });
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(h.store.get(runId)!.error).toContain('previous proposal kept');
    });
    expect(h.store.get(runId)!.skillName).toBe('my-skill');

    h.setScan(goodScan());
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(h.store.get(runId)!.error).toBeUndefined();
    });
  });

  it('discard 后 watcher 解绑:后续 done 不再动 run', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
    await h.controller.discard(runId);
    const snapshot = h.store.get(runId)!;
    h.session.emit({ type: 'done' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.store.get(runId)).toEqual(snapshot);
  });

  it('discard 中止修订会话并等待已启动 rescan 后再清理 staging', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    let releaseRescan: (() => void) | undefined;
    h.setBeforeScan(
      () =>
        new Promise<void>((resolve) => {
          releaseRescan = () => {
            h.setBeforeScan(null);
            resolve();
          };
        }),
    );
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(releaseRescan).toBeDefined();
    });

    const discarding = h.controller.discard(runId);
    await vi.waitFor(() => {
      expect(h.session.aborted).toBe(true);
    });
    expect(h.session.listeners).toHaveLength(0);
    expect(h.cleanupCalls).not.toContain(runId);

    releaseRescan!();
    await discarding;

    expect(h.cleanupCalls).toContain(runId);
    const snapshot = h.store.get(runId)!;
    expect(snapshot.status).toBe('discarded');
    h.session.emit({ type: 'done' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.store.get(runId)).toEqual(snapshot);
  });

  it('collecting 阶段 cancel:不创建蒸馏会话,过期快照不复活 run(Codex review 竞态)', async () => {
    let releaseSearch: (() => void) | undefined;
    const h = makeHarness({
      search: () =>
        new Promise((resolve) => {
          releaseSearch = () =>
            resolve({ hits: [], sessions: {}, nextCursor: null, vectorUsed: false } as never);
        }),
      collectProfile: async () => ({ block: '', used: false }),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    // 管线卡在证据检索上 → 此刻 cancel(collecting 阶段,无活跃 session)
    await vi.waitFor(() => {
      expect(releaseSearch).toBeDefined();
    });
    await h.controller.cancel(runId);
    expect(h.store.get(runId)!.status).toBe('cancelled');
    // 放行检索,管线继续跑 —— 不得创建会话、不得改写终态
    releaseSearch!();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.session.sent).toHaveLength(0);
    expect(h.store.get(runId)!.status).toBe('cancelled');
  });

  it('apply 前重扫重校验:staging 被后续对话改坏时拒绝落盘,恢复后可应用', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    // 点击 apply 时 staging 已被改坏(比如上一轮对话删了 SKILL.md)
    h.setScan({ candidates: [] });
    await expect(h.controller.apply(runId)).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });
    expect(h.applyCalls).toHaveLength(0);
    expect(h.store.get(runId)!.status).toBe('awaiting-review');

    // 提案含 symlink 违规同样拒绝
    h.setScan({
      candidates: [
        {
          dirName: 'my-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'my-skill'),
          files: [{ relPath: 'SKILL.md', size: SKILL_MD.length, text: SKILL_MD }],
          violations: ['scripts/evil-link'],
        },
      ],
    });
    await expect(h.controller.apply(runId)).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });

    // 恢复有效后正常落盘
    h.setScan(goodScan());
    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const result = await h.controller.apply(runId);
    expect(result.name).toBe('my-skill');
  });

  it('apply 冻结提案(TOCTOU 防线):落盘走冻结副本,失败时放回 staging', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    // 冻结后校验失败(冻结副本含 symlink 违规)→ 拒绝 + unfreeze 放回
    h.setScan({
      candidates: [
        {
          dirName: 'my-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'my-skill'),
          files: [{ relPath: 'SKILL.md', size: SKILL_MD.length, text: SKILL_MD }],
          violations: ['scripts/evil-link'],
        },
      ],
    });
    await expect(h.controller.apply(runId)).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });
    expect(h.freezeCalls).toEqual([{ runId, dirName: 'my-skill' }]);
    expect(h.unfreezeCalls).toHaveLength(1);

    // 成功路径:applyProposal 收到的是冻结区路径(蒸馏会话可写范围之外),
    // 且成功后不 unfreeze(目录已 final-switch 落盘)
    h.setScan(goodScan());
    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    await h.controller.apply(runId);
    const lastApply = h.applyCalls.at(-1) as { proposalDir: string };
    expect(lastApply.proposalDir).toBe(path.join('/', 'fake-staging', `${runId}.apply`, 'my-skill'));
    expect(h.unfreezeCalls).toHaveLength(1);
  });

  it('dispose 与 apply 并发:落盘副作用开始前拒绝并放回冻结提案', async () => {
    let releaseCollect: (() => void) | undefined;
    const h = makeHarness({
      staging: {
        collectProposal: () =>
          new Promise((resolve) => {
            releaseCollect = () => {
              const c = goodScan().candidates[0];
              resolve({ files: c.files, violations: c.violations });
            };
          }),
      },
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const applying = h.controller.apply(runId);
    await vi.waitFor(() => {
      expect(releaseCollect).toBeDefined();
    });
    const disposing = h.controller.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseCollect!();

    await expect(applying).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });
    await disposing;
    expect(h.applyCalls).toHaveLength(0);
    expect(h.unfreezeCalls).toHaveLength(1);
    expect(h.store.get(runId)!.status).toBe('awaiting-review');
  });

  it('run 按 data owner 隔离:其它 owner 的 run 不可见、不可 apply', async () => {
    const h = makeHarness({ getCurrentDataOwnerId: () => 'u2' });
    await h.store.put({
      runId: 'r-other',
      status: 'awaiting-review',
      sourceKind: 'freetext',
      dataOwnerId: 'u1',
      input: 'x',
      skillName: 'my-skill',
      usedSessionEvidence: false,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await h.controller.listRuns()).toEqual([]);
    await expect(h.controller.apply('r-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 缺 owner 的历史 run 不过滤(兼容)
    await h.store.put({
      runId: 'r-legacy',
      status: 'failed',
      sourceKind: 'freetext',
      input: 'y',
      usedSessionEvidence: false,
      createdAt: 2,
      updatedAt: 2,
    });
    expect((await h.controller.listRuns()).map((r) => r.runId)).toEqual(['r-legacy']);
  });

  it('本地模式 run 带 local data owner,其它 owner 的在途 run 不触发 LEARN_BUSY', async () => {
    const h = makeHarness({ getCurrentDataOwnerId: () => 'local-v1' });
    await h.store.put({
      runId: 'cloud-in-flight',
      status: 'collecting',
      sourceKind: 'freetext',
      dataOwnerId: 'cloud-a',
      input: 'cloud task',
      usedSessionEvidence: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const { runId } = await h.controller.startLearn({ input: 'local task', sourceKind: 'freetext' });

    expect(h.store.get(runId)?.dataOwnerId).toBe('local-v1');
  });

  it('修订把提案改名到本地已装 skill ⇒ personal(rescan 路径同责)', async () => {
    const h = makeHarness({
      search: async () => ({ hits: [], sessions: {}, nextCursor: null, vectorUsed: false }) as never,
      collectProfile: async () => ({ block: '', used: false }),
      dirExists: async (dir) =>
        dir.startsWith(path.join('/', 'fake-staging')) || dir === path.join('/', 'installed', 'renamed-skill'),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
    expect(h.store.get(runId)!.usedSessionEvidence).toBe(false);

    // 用户在会话里让模型改名 → rescan 后新名命中已装 skill
    const renamedMd = SKILL_MD.replace('name: my-skill', 'name: renamed-skill');
    h.setScan({
      candidates: [
        {
          dirName: 'renamed-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'renamed-skill'),
          files: [{ relPath: 'SKILL.md', size: renamedMd.length, text: renamedMd }],
          violations: [],
        },
      ],
    });
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(h.store.get(runId)!.skillName).toBe('renamed-skill');
    });
    expect(h.store.get(runId)!.usedSessionEvidence).toBe(true);
  });

  it('getProposalDiff 排除路径语义:提案侧噪声不展示,旧目录侧的删除必须展示', async () => {
    const h = makeHarness({
      dirExists: async (dir) =>
        dir.startsWith(path.join('/', 'fake-staging')) || dir === path.join('/', 'installed', 'my-skill'),
      computeDiff: async () => [
        { path: 'SKILL.md', kind: 'added', isBinary: false, oldContent: '', newContent: 'x' },
        // 仅提案侧的噪声:装不进去,不展示
        { path: '.claude/settings.json', kind: 'added', isBinary: false, oldContent: '', newContent: '{}' },
        { path: '.env', kind: 'added', isBinary: false, oldContent: '', newContent: 'SECRET=1' },
        // 仅旧目录侧:整目录替换会把它删掉 → 必须以 removed 展示
        { path: 'AGENTS.md', kind: 'removed', isBinary: false, oldContent: 'old agents rules', newContent: '' },
        // 两侧都有:提案侧剥除后最终效果是删除旧文件 → 转 removed 展示
        { path: 'node_modules/x.js', kind: 'modified', isBinary: false, oldContent: 'v1', newContent: 'v2', newSize: 2 },
      ] as never,
      computeExcludedOldSideRemovals: async () => [
        { path: 'CLAUDE.md', kind: 'removed', isBinary: false, oldContent: 'same', newContent: '', oldSize: 4, newSize: 0 },
        { path: '.env', kind: 'removed', isBinary: false, oldContent: 'SECRET=old', newContent: '', oldSize: 10, newSize: 0 },
      ],
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    const { changes } = await h.controller.getProposalDiff(runId);
    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual([
      'removed:.env',
      'removed:AGENTS.md',
      'removed:CLAUDE.md',
      'removed:node_modules/x.js',
      'added:SKILL.md',
    ]);
    const converted = changes.find((c) => c.path === 'node_modules/x.js')!;
    expect(converted.newContent).toBe('');
  });

  it('dispose 中止活跃蒸馏 turn(登出/切账号不留 bypass 会话空跑)', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    await h.controller.dispose();
    expect(h.session.aborted).toBe(true);
    expect(h.store.get(runId)!.status).toBe('cancelled');
    expect(h.cleanupCalls).toContain(runId);
  });

  it('dispose 中止 awaiting-review 的修订会话并解绑 watcher', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    h.session.emit({ type: 'text', data: { text: 'rewriting' } });
    await h.controller.dispose();
    expect(h.session.aborted).toBe(true);
    expect(h.session.listeners).toHaveLength(0);
  });

  it('dispose 等待进行中的 revision rescan 收口后再返回', async () => {
    let releaseRescan: (() => void) | undefined;
    let disposed = false;
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    h.setBeforeScan(
      () =>
        new Promise<void>((resolve) => {
          releaseRescan = resolve;
        }),
    );
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(releaseRescan).toBeDefined();
    });

    const disposing = h.controller.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    h.setBeforeScan(null);
    releaseRescan!();
    await disposing;
    expect(disposed).toBe(true);
  });

  it('审查动作互斥:apply 进行中 discard 拒 LEARN_BUSY(不产生"已放弃却已安装")', async () => {
    let releaseApply: (() => void) | undefined;
    const h = makeHarness({
      applyProposal: (params) =>
        new Promise((resolve) => {
          releaseApply = () => resolve({ name: params.skillName, absolutePath: `/skills/${params.skillName}` });
        }),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const applying = h.controller.apply(runId);
    await vi.waitFor(() => {
      expect(releaseApply).toBeDefined();
    });
    await expect(h.controller.discard(runId)).rejects.toMatchObject({ code: 'LEARN_BUSY' });
    releaseApply!();
    await applying;
    expect(h.store.get(runId)!.status).toBe('applied');
  });

  it('dispose 等待进行中的 apply 收口后再返回', async () => {
    let releaseApply: (() => void) | undefined;
    let disposed = false;
    const h = makeHarness({
      applyProposal: (params) =>
        new Promise((resolve) => {
          releaseApply = () => resolve({ name: params.skillName, absolutePath: `/skills/${params.skillName}` });
        }),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const applying = h.controller.apply(runId);
    await vi.waitFor(() => {
      expect(releaseApply).toBeDefined();
    });
    const disposing = h.controller.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    releaseApply!();
    await applying;
    await disposing;
    expect(disposed).toBe(true);
  });

  it('同名 skill 的多个 awaiting-review run 不能并发 apply', async () => {
    let releaseApply: (() => void) | undefined;
    let applyStarts = 0;
    const h = makeHarness({
      applyProposal: (params) => {
        applyStarts++;
        return new Promise((resolve) => {
          releaseApply = () => resolve({ name: params.skillName, absolutePath: `/skills/${params.skillName}` });
        });
      },
    });
    h.setScan(goodScan());
    await h.store.put({
      runId: 'r1',
      status: 'awaiting-review',
      sourceKind: 'freetext',
      input: 'x',
      skillName: 'my-skill',
      proposalFingerprint: computeProposalFingerprint(goodScan().candidates[0].files),
      usedSessionEvidence: false,
      createdAt: 1,
      updatedAt: 1,
    });
    await h.store.put({
      runId: 'r2',
      status: 'awaiting-review',
      sourceKind: 'freetext',
      input: 'y',
      skillName: 'my-skill',
      proposalFingerprint: computeProposalFingerprint(goodScan().candidates[0].files),
      usedSessionEvidence: false,
      createdAt: 2,
      updatedAt: 2,
    });

    await h.controller.getProposalDiff('r1'); // 登记 reviewed 基线(apply 前置门)
    const applying = h.controller.apply('r1');
    await vi.waitFor(() => {
      expect(releaseApply).toBeDefined();
    });

    await expect(h.controller.apply('r2')).rejects.toMatchObject({ code: 'LEARN_BUSY' });
    expect(applyStarts).toBe(1);
    expect(h.store.get('r2')!.status).toBe('awaiting-review');
    expect(h.unfreezeCalls).toHaveLength(1);

    releaseApply!();
    await applying;
    expect(h.store.get('r1')!.status).toBe('applied');
  });

  it('市场安装/卸载持共享锁期间 apply 拒 LEARN_BUSY 并放回提案;不同名不受影响', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    await h.store.put({
      runId: 'r1',
      status: 'awaiting-review',
      sourceKind: 'freetext',
      input: 'x',
      skillName: 'my-skill',
      proposalFingerprint: computeProposalFingerprint(goodScan().candidates[0].files),
      usedSessionEvidence: false,
      createdAt: 1,
      updatedAt: 1,
    });
    await h.controller.getProposalDiff('r1'); // 登记 reviewed 基线(apply 前置门)

    // 市场安装占住同名共享锁 → apply fail-fast,提案放回 staging、run 仍可重试
    const releaseMarket = tryAcquireSkillInstallLock('my-skill', 'market-install')!;
    try {
      await expect(h.controller.apply('r1')).rejects.toMatchObject({ code: 'LEARN_BUSY' });
      expect(h.applyCalls).toHaveLength(0);
      expect(h.unfreezeCalls).toHaveLength(1);
      expect(h.store.get('r1')!.status).toBe('awaiting-review');
    } finally {
      releaseMarket();
    }

    // 不同名的市场安装不阻塞;同名锁释放后重试成功
    const releaseUnrelated = tryAcquireSkillInstallLock('unrelated-skill', 'market-install')!;
    try {
      const result = await h.controller.apply('r1');
      expect(result.name).toBe('my-skill');
      expect(h.store.get('r1')!.status).toBe('applied');
    } finally {
      releaseUnrelated();
    }
  });

  it('修订回合进行中 apply 拒 LEARN_BUSY;done 后可正常应用', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    // 用户发了修订,模型开工(text 事件)但尚未 done —— staging 可能已被改写,
    // 而 diff 面板展示的还是旧内容
    h.session.emit({ type: 'text', data: { text: 'rewriting…' } });
    await expect(h.controller.apply(runId)).rejects.toMatchObject({ code: 'LEARN_BUSY' });
    expect(h.applyCalls).toHaveLength(0);

    h.session.emit({ type: 'done' });
    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const result = await h.controller.apply(runId);
    expect(result.name).toBe('my-skill');
  });

  it('account_usage 等非 turn 事件不应阻塞 apply', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    h.session.emit({ type: 'account_usage', data: { remainingPercent: 50 } });

    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const result = await h.controller.apply(runId);
    expect(result.name).toBe('my-skill');
  });

  it('apply 等待已启动的 revision rescan 完成后再 freeze,避免并发 rename', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    const renamedMd = SKILL_MD.replace('name: my-skill', 'name: renamed-skill');
    h.setScan({
      candidates: [
        {
          dirName: 'renamed-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'renamed-skill'),
          files: [{ relPath: 'SKILL.md', size: renamedMd.length, text: renamedMd }],
          violations: [],
        },
      ],
    });
    let releaseRescan: (() => void) | undefined;
    let scanCallsWhileBlocked = 0;
    h.setBeforeScan(() => {
      scanCallsWhileBlocked += 1;
      if (scanCallsWhileBlocked === 1) {
        return new Promise<void>((resolve) => {
          releaseRescan = resolve;
        });
      }
      return Promise.resolve();
    });

    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(releaseRescan).toBeDefined();
    });
    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const applying = h.controller.apply(runId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scanCallsWhileBlocked).toBe(1);
    expect(h.freezeCalls).toHaveLength(0);

    h.setBeforeScan(null);
    releaseRescan!();
    // rescan 落定后提案指纹已变(renamed-skill)—— 等待中的 apply 装的将是用户
    // 没审查过的内容,按 reviewed 基线门拒绝;重新打开审查后才可落盘。
    await expect(applying).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });

    await h.controller.getProposalDiff(runId);
    const result = await h.controller.apply(runId);
    expect(result.name).toBe('renamed-skill');
    expect(h.freezeCalls.at(-1)).toEqual({ runId, dirName: 'renamed-skill' });
  });

  it('审查后内容被改动且未经重扫:apply 按指纹拒绝落盘', async () => {
    const h = makeHarness();
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    // staging 内容变了但没有 done(watcher 未重扫,指纹还是旧的)
    const tampered = `${SKILL_MD}\nEXTRA LINE NOT REVIEWED\n`;
    h.setScan({
      candidates: [
        {
          dirName: 'my-skill',
          absPath: path.join('/', 'fake-staging', 'x', 'my-skill'),
          files: [{ relPath: 'SKILL.md', size: tampered.length, text: tampered }],
          violations: [],
        },
      ],
    });
    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    await expect(h.controller.apply(runId)).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });
    expect(h.applyCalls).toHaveLength(0);

    // 走完一轮 done → 重扫更新指纹 → 同内容可应用
    const fpBefore = h.store.get(runId)!.proposalFingerprint;
    h.session.emit({ type: 'done' });
    await vi.waitFor(() => {
      expect(h.store.get(runId)!.proposalFingerprint).not.toBe(fpBefore);
    });
    await h.controller.getProposalDiff(runId); // 登记 reviewed 基线(apply 前置门)
    const result = await h.controller.apply(runId);
    expect(result.name).toBe('my-skill');
  });

  it('collecting 阶段 dispose(切账号):管线不再创建蒸馏会话', async () => {
    let releaseSearch: (() => void) | undefined;
    const h = makeHarness({
      search: () =>
        new Promise((resolve) => {
          releaseSearch = () =>
            resolve({ hits: [], sessions: {}, nextCursor: null, vectorUsed: false } as never);
        }),
      collectProfile: async () => ({ block: '', used: false }),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await vi.waitFor(() => {
      expect(releaseSearch).toBeDefined();
    });
    await h.controller.dispose();
    releaseSearch!();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.session.sent).toHaveLength(0);
    expect(h.store.get(runId)!.status).toBe('cancelled');
    expect(h.cleanupCalls).toContain(runId);
  });

  it('组合目标指纹覆盖全部候选目录:第二候选审查后被改,apply 拒;重看后可应用', async () => {
    const installedDir = path.join('/', 'installed', 'my-skill');
    const claudeDir = path.join('/', 'claude', 'skills', 'my-skill');
    const fps = new Map<string, string>([
      [installedDir, 'A1'],
      [claudeDir, 'B1'],
    ]);
    const h = makeHarness({
      search: async () => ({ hits: [], sessions: {}, nextCursor: null, vectorUsed: false }) as never,
      collectProfile: async () => ({ block: '', used: false }),
      resolveInstalledSkillDirs: () => [installedDir, claudeDir],
      dirExists: async (dir) => dir.startsWith(path.join('/', 'fake-staging')) || fps.has(dir),
      computeTargetFingerprint: async (dir) => fps.get(dir) ?? 'none',
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    await h.controller.getProposalDiff(runId);
    // 只 fingerprint 第一个候选的话,这次改动检测不到(Codex review 场景)
    fps.set(claudeDir, 'B2');
    await expect(h.controller.apply(runId)).rejects.toMatchObject({ code: 'LEARN_INVALID_STATE' });
    // 重新审查后基线刷新,可正常应用
    await h.controller.getProposalDiff(runId);
    const result = await h.controller.apply(runId);
    expect(result.name).toBe('my-skill');
  });

  it('审查登记为静默写:getProposalDiff 不广播、不 bump updatedAt(防面板自触发循环)', async () => {
    const broadcasts: unknown[] = [];
    const h = makeHarness({
      broadcast: (payload) => {
        broadcasts.push(payload);
      },
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');

    const before = h.store.get(runId)!.updatedAt;
    const count = broadcasts.length;
    await h.controller.getProposalDiff(runId);
    const after = h.store.get(runId)!;
    expect(after.updatedAt).toBe(before);
    expect(broadcasts.length).toBe(count);
    expect(after.reviewedProposalFingerprint).toBe(after.proposalFingerprint);
  });

  it('hub 源命中同名本地 skill:本地 SKILL.md 注入 prompt 前过 redaction', async () => {
    const secret = 'sk-abcdef1234567890abcdef1234567890';
    const h = makeHarness({
      fetchHubSkill: async () => ({
        name: 'my-skill',
        description: 'upstream',
        content: '# upstream skill',
      }),
      dirExists: async (dir) =>
        dir.startsWith(path.join('/', 'fake-staging')) || dir === path.join('/', 'installed', 'my-skill'),
      readFileText: async () => `# local skill\napi key: ${secret}\n`,
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: '', sourceKind: 'hub', hubSlug: 'my-skill' });
    await h.waitForStatus(runId, 'distilling');
    expect(h.session.sent[0]).toContain('# local skill');
    expect(h.session.sent[0]).not.toContain(secret);
  });

  it('Claude-only 本地 skill 也算已装:注入原文、diff 有基线、标记 personal', async () => {
    const claudeDir = path.join('/', 'claude', 'skills', 'my-skill');
    let diffOldDir: string | null | undefined;
    const h = makeHarness({
      fetchHubSkill: async () => ({
        name: 'my-skill',
        description: 'upstream',
        content: '# upstream skill',
      }),
      search: async () => ({ hits: [], sessions: {}, nextCursor: null, vectorUsed: false }) as never,
      collectProfile: async () => ({ block: '', used: false }),
      resolveInstalledSkillDirs: (name) => [path.join('/', 'installed', name), path.join('/', 'claude', 'skills', name)],
      dirExists: async (dir) => dir.startsWith(path.join('/', 'fake-staging')) || dir === claudeDir,
      readFileText: async (filePath) => (filePath === path.join(claudeDir, 'SKILL.md') ? '# local Claude skill' : null),
      computeDiff: async (oldDir) => {
        diffOldDir = oldDir;
        return [];
      },
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: '', sourceKind: 'hub', hubSlug: 'my-skill' });
    await h.waitForStatus(runId, 'distilling');
    expect(h.session.sent[0]).toContain('# local Claude skill');
    expect(h.store.get(runId)!.usedSessionEvidence).toBe(true);

    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
    const diff = await h.controller.getProposalDiff(runId);
    expect(diff.targetExists).toBe(true);
    expect(diff.targetPath).toBe(claudeDir);
    expect(diffOldDir).toBe(claudeDir);
  });

  it('产物名命中本地已装 skill ⇒ personal(freetext 改进本地资产也计个人上下文)', async () => {
    const h = makeHarness({
      search: async () => ({ hits: [], sessions: {}, nextCursor: null, vectorUsed: false }) as never,
      collectProfile: async () => ({ block: '', used: false }),
      dirExists: async (dir) => dir.startsWith(path.join('/', 'fake-staging')) || dir === path.join('/', 'installed', 'my-skill'),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    expect(h.store.get(runId)!.usedSessionEvidence).toBe(false);
    h.session.emit({ type: 'done' });
    const run = await h.waitForStatus(runId, 'awaiting-review');
    expect(run.usedSessionEvidence).toBe(true);
  });

  it('createSession await 窗口内 cancel:中止新会话,不发送 prompt', async () => {
    let releaseCreate: (() => void) | undefined;
    const session = new FakeSession();
    const h = makeHarness({
      createSession: () =>
        new Promise((resolve) => {
          releaseCreate = () => resolve(session);
        }),
      collectProfile: async () => ({ block: '', used: false }),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await vi.waitFor(() => {
      expect(releaseCreate).toBeDefined();
    });
    await h.controller.cancel(runId);
    releaseCreate!();
    await new Promise((r) => setTimeout(r, 30));
    expect(session.sent).toHaveLength(0);
    expect(session.aborted).toBe(true);
    expect(h.store.get(runId)!.status).toBe('cancelled');
  });

  it('resume:中断态转 failed,超龄 awaiting-review 转 expired', async () => {
    const h = makeHarness({ dirExists: async () => true });
    const now = Date.now();
    await h.store.put({
      runId: 'r-interrupted',
      status: 'distilling',
      sourceKind: 'freetext',
      input: 'x',
      usedSessionEvidence: false,
      createdAt: now,
      updatedAt: now,
    });
    await h.store.put({
      runId: 'r-stale',
      status: 'awaiting-review',
      sourceKind: 'freetext',
      input: 'y',
      skillName: 'old-skill',
      usedSessionEvidence: false,
      createdAt: now - 8 * 24 * 3600 * 1000,
      updatedAt: now - 8 * 24 * 3600 * 1000,
    });
    await h.store.put({
      runId: 'r-fresh',
      status: 'awaiting-review',
      sourceKind: 'freetext',
      input: 'z',
      skillName: 'fresh-skill',
      usedSessionEvidence: false,
      createdAt: now,
      updatedAt: now,
    });
    const keep = await h.controller.resume();
    expect(h.store.get('r-interrupted')!.status).toBe('failed');
    expect(h.store.get('r-stale')!.status).toBe('expired');
    expect(h.store.get('r-fresh')!.status).toBe('awaiting-review');
    expect([...keep]).toEqual(['r-fresh']);
  });

  it('hub 源未注入 fetchHubSkill 时拒 INVALID_PARAMS', async () => {
    const h = makeHarness();
    await expect(
      h.controller.startLearn({ input: '', sourceKind: 'hub', hubSlug: 'some-skill' }),
    ).rejects.toBeInstanceOf(LearnError);
  });

  it('session 源(无参 /learn):注入当前会话全文,跳过主题检索,personal 恒真', async () => {
    const searchSpy = vi.fn();
    const h = makeHarness({
      search: async (args) => {
        searchSpy(args);
        return { hits: [], sessions: {}, nextCursor: null, vectorUsed: false } as never;
      },
      collectProfile: async () => ({ block: '', used: false }),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({
      input: '',
      sourceKind: 'session',
      originSessionId: 'origin-1',
    });
    await h.waitForStatus(runId, 'distilling');
    expect(h.session.sent[0]).toContain('THE CURRENT CONVERSATION');
    expect(h.session.sent[0]).toContain('run pnpm test first');
    // 会话全文即个人上下文 ⇒ personal(即使检索/画像都空)
    expect(h.store.get(runId)!.usedSessionEvidence).toBe(true);
    // 空 query 不触发主题检索
    expect(searchSpy).not.toHaveBeenCalled();
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
  });

  it('session 源缺 originSessionId 拒 INVALID_PARAMS', async () => {
    const h = makeHarness();
    await expect(h.controller.startLearn({ input: '', sourceKind: 'session' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('证据检索抛错 → 无证据继续(不整轮失败)', async () => {
    const h = makeHarness({
      search: async () => {
        throw new Error('db not ready');
      },
      collectProfile: async () => ({ block: '', used: false }),
    });
    h.setScan(goodScan());
    const { runId } = await h.controller.startLearn({ input: 'x', sourceKind: 'freetext' });
    await h.waitForStatus(runId, 'distilling');
    expect(h.store.get(runId)!.usedSessionEvidence).toBe(false);
    expect(h.session.sent[0]).not.toContain('LOCAL USAGE EVIDENCE');
    h.session.emit({ type: 'done' });
    await h.waitForStatus(runId, 'awaiting-review');
  });
});
