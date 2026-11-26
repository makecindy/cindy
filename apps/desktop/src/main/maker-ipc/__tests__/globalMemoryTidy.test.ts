/*
 * 测试价值
 * - 生产入口与可观察结果：evaluateGlobalMemoryTidyPlan / buildGlobalMemoryTidyPrompt /
 *   createGlobalMemoryTidyCoordinator（全局记忆与技能定期/手动整理主入口），核对频率节制、
 *   记忆开关严格遵守、无积压零调用、每次最多 4 伙伴上限、全局技能/跨伙伴摘要注入、自动归档、
 *   Git 快照与失败不推进水位。
 * - 规则依据：伙伴记忆 v3 设计——以单一宿主管控的低频（默认 weekly、可调 biweekly/monthly/off）
 *   整理取代每伙伴每日定时任务；关闭记忆开关的伙伴绝不扫描或修改；无积压不调模型；出错不吞积压。
 * - 现有覆盖缺口：新增的全局整理编排器，无既有覆盖。
 * - 最小失败输入：包含 memoryEnabled=false、0 积压、超 30 条人类消息、MEMORY.md 超过 2KB、
 *   5 个有积压伙伴（验证 4 上限）、cadence=off、成功/NO_CHANGES/失败三类执行回报。
 * - tier：unit（临时目录真实文件 I/O，LLM 执行器与消息计数经显式依赖注入，无真实等待，耗时 < 200ms）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGlobalMemoryTidyPrompt,
  createGlobalMemoryTidyCoordinator,
  DEFAULT_MEMORY_TIDY_CADENCE,
  defaultTidyState,
  evaluateGlobalMemoryTidyPlan,
  readGlobalMemoryTidyState,
  TIDY_CORE_INDEX_SOFT_BYTES,
  TIDY_MAX_BOTS_PER_RUN,
  TIDY_MIN_HUMAN_MESSAGES,
  type TidyTeammateInput,
} from '../globalMemoryTidy.js';
import { teammateProjectMemoryDir } from '../botProjectMemory.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('globalMemoryTidy', () => {
  let root = '';
  let globalSkillsDir = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'global-memory-tidy-'));
    globalSkillsDir = path.join(root, 'global-skills');
    await fs.mkdir(globalSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function makeBot(botId: string, displayName: string, memoryEnabled = true): Promise<TidyTeammateInput> {
    const workspace = path.join(root, 'bots', botId, 'workspace');
    await fs.mkdir(teammateProjectMemoryDir(workspace), { recursive: true });
    return { botId, displayName, workspace, memoryEnabled };
  }

  it('skips memory-disabled buddies, gates idle runs to zero LLM calls, caps to top 4, and gathers global context', async () => {
    const disabled = await makeBot('bot-off', 'Silent', false);
    const idle = await makeBot('bot-idle', 'Idle', true);
    const activeBots: TidyTeammateInput[] = [];
    for (let i = 1; i <= 5; i++) {
      const bot = await makeBot(`bot-${i}`, `Buddy${i}`, true);
      await fs.writeFile(
        path.join(teammateProjectMemoryDir(bot.workspace), 'MEMORY.md'),
        i === 1 ? `# Core\n${'x'.repeat(TIDY_CORE_INDEX_SOFT_BYTES + 128)}\n` : `# Core for Buddy${i}\n- concise\n`,
      );
      activeBots.push(bot);
    }

    // Add a global skill to verify cross-skill reference injection.
    const skillFolder = path.join(globalSkillsDir, 'pdf-helper');
    await fs.mkdir(skillFolder, { recursive: true });
    await fs.writeFile(
      path.join(skillFolder, 'SKILL.md'),
      '---\nname: pdf-helper\ndescription: Extract tables from PDF files\n---\nInstructions\n',
    );

    const countHumanMessages = vi.fn(async (botId: string) => {
      if (botId === 'bot-idle') return 5;
      if (botId === 'bot-1') return 40;
      if (botId.startsWith('bot-')) return TIDY_MIN_HUMAN_MESSAGES + 2;
      return 0;
    });

    // 1. Only disabled + idle => no backlog, zero scan of disabled buddy.
    const idlePlan = await evaluateGlobalMemoryTidyPlan({
      teammates: [disabled, idle],
      state: defaultTidyState(),
      now: Date.now(),
      manual: false,
      globalSkillsDir,
      countHumanMessages,
    });
    expect(idlePlan.shouldRun).toBe(false);
    expect(idlePlan.reason).toBe('no-backlog');
    expect(countHumanMessages).not.toHaveBeenCalledWith('bot-off', expect.any(Number));

    // 2. Five active buddies => capped to TIDY_MAX_BOTS_PER_RUN (4), bot-1 ranked #1 (messages + oversized MEMORY.md).
    const activePlan = await evaluateGlobalMemoryTidyPlan({
      teammates: [disabled, idle, ...activeBots],
      state: defaultTidyState(),
      now: Date.now(),
      manual: false,
      globalSkillsDir,
      countHumanMessages,
    });
    expect(activePlan.shouldRun).toBe(true);
    expect(activePlan.candidates).toHaveLength(TIDY_MAX_BOTS_PER_RUN);
    expect(activePlan.omittedCount).toBe(1);
    expect(activePlan.candidates[0]!.botId).toBe('bot-1');
    expect(activePlan.installedGlobalSkills).toEqual([
      { name: 'pdf-helper', description: 'Extract tables from PDF files' },
    ]);

    const prompt = buildGlobalMemoryTidyPrompt(activePlan);
    expect(prompt).toContain('Buddy1');
    expect(prompt).toContain('pdf-helper');
    expect(prompt).not.toContain('Silent');
    expect(prompt).toContain('MEMORY.md');
  });

  it('enforces cadence, auto-archives sessions, snapshots only on updates, and preserves watermarks on error', async () => {
    const bot = await makeBot('bot-main', 'Mimi', true);
    await fs.writeFile(
      path.join(teammateProjectMemoryDir(bot.workspace), 'MEMORY.md'),
      '# Core\n- concise\n',
    );

    let clock = 1_800_000_000_000;
    const executeTidyPrompt = vi.fn<
      (input: { prompt: string; workingDir: string; extraDirs: string[]; writableDirs: string[] }) =>
        Promise<{ ok: boolean; output: string; sessionId?: string }>
    >(async () => ({ ok: true, output: 'Merged duplicate release notes for Mimi.', sessionId: 'tidy-sess-1' }));
    const archiveSession = vi.fn(async (_sessionId: string) => {});
    const snapshotTeammate = vi.fn(async () => {});

    const coordinator = createGlobalMemoryTidyCoordinator({
      readOwnerRoot: () => root,
      assertCurrent: () => {},
      listLocalTeammates: async () => [bot],
      countHumanMessages: async () => TIDY_MIN_HUMAN_MESSAGES + 5,
      executeTidyPrompt,
      archiveSession,
      snapshotTeammate,
      globalSkillsDir,
      now: () => clock,
    });

    // Default cadence is weekly.
    expect((await coordinator.getStatus()).cadence).toBe(DEFAULT_MEMORY_TIDY_CADENCE);

    // 1. First automatic run executes, archives session, snapshots teammate, advances watermark.
    const first = await coordinator.run({ manual: false });
    expect(first.outcome).toBe('updated');
    expect(first.touchedBots).toEqual(['Mimi']);
    expect(executeTidyPrompt).toHaveBeenCalledOnce();
    expect(archiveSession).toHaveBeenCalledWith('tidy-sess-1');
    expect(snapshotTeammate).toHaveBeenCalledWith('bot-main', bot.workspace, 'Tidy teammate memory and skills');

    // 2. One day later => weekly cadence not due yet => zero LLM calls.
    clock += DAY_MS;
    const tooSoon = await coordinator.run({ manual: false });
    expect(tooSoon.outcome).toBe('skipped');
    expect(tooSoon.summary).toBe('cadence-not-due');
    expect(executeTidyPrompt).toHaveBeenCalledOnce();

    // 3. Switch cadence to off => even after 30 days, automatic run skips, manual still works.
    await coordinator.setCadence('off');
    clock += 30 * DAY_MS;
    expect((await coordinator.run({ manual: false })).summary).toBe('cadence-off');

    // 4. Manual run returning NO_CHANGES => skips snapshot, marks idle.
    executeTidyPrompt.mockResolvedValueOnce({ ok: true, output: 'NO_CHANGES', sessionId: 'tidy-sess-2' });
    const quiet = await coordinator.run({ manual: true });
    expect(quiet.outcome).toBe('idle');
    expect(snapshotTeammate).toHaveBeenCalledOnce();
    expect(archiveSession).toHaveBeenCalledWith('tidy-sess-2');

    // 5. Failed run => marks error and does NOT advance bot reviewedAt watermark.
    const beforeError = await readGlobalMemoryTidyState(root);
    const prevReviewedAt = beforeError.bots['bot-main']!.reviewedAt;
    clock += 10 * DAY_MS;
    executeTidyPrompt.mockResolvedValueOnce({ ok: false, output: 'rate limited', sessionId: 'tidy-sess-3' });
    const failed = await coordinator.run({ manual: true });
    expect(failed.outcome).toBe('error');
    expect(archiveSession).toHaveBeenCalledWith('tidy-sess-3');
    const afterError = await readGlobalMemoryTidyState(root);
    expect(afterError.bots['bot-main']!.reviewedAt).toBe(prevReviewedAt);
  });

  it('preserves concurrent setCadence during an in-flight run, guards concurrent file edits, and stabilizes baselineAt', async () => {
    const bot = await makeBot('bot-race', 'Race', true);
    let clock = 1_900_000_000_000;
    const seenSince: number[] = [];
    let releaseRun!: () => void;
    let enteredRun!: () => void;
    const runEntered = new Promise<void>((r) => { enteredRun = r; });

    const coordinator = createGlobalMemoryTidyCoordinator({
      readOwnerRoot: () => root,
      assertCurrent: () => {},
      listLocalTeammates: async () => [bot],
      countHumanMessages: async (_botId, sinceMs) => {
        seenSince.push(sinceMs);
        return seenSince.length === 1 ? 5 : TIDY_MIN_HUMAN_MESSAGES + 1;
      },
      executeTidyPrompt: async () => {
        enteredRun();
        await new Promise<void>((r) => { releaseRun = r; });
        clock += 60_000;
        return { ok: true, output: 'Updated notes.', sessionId: 'tidy-race' };
      },
      hasConcurrentActivity: async () => true,
      globalSkillsDir,
      now: () => clock,
    });

    // First skipped run establishes a stable baselineAt that does NOT slide forward 20 days later.
    expect((await coordinator.run({ manual: false })).outcome).toBe('skipped');
    const firstSince = seenSince[0]!;
    clock += 20 * DAY_MS;

    // Start second run and flip cadence to 'off' while LLM execution is in flight.
    const runStartClock = clock;
    const inFlight = coordinator.run({ manual: false });
    await runEntered;
    expect(seenSince[1]).toBe(firstSince);
    await coordinator.setCadence('off');
    releaseRun();
    const res = await inFlight;
    expect(res.outcome).toBe('updated');

    const finalState = await readGlobalMemoryTidyState(root);
    // Cadence change made during run() MUST NOT be overwritten back to 'weekly'.
    expect(finalState.cadence).toBe('off');
    // Because hasConcurrentActivity returned true, filesSince stays at runStartClock (not runStartClock + 60_000).
    expect(finalState.bots['bot-race']!.filesSince).toBe(runStartClock);
  });
});
