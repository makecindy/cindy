/*
 * 测试价值
 * - 生产入口与可观察结果：retireLegacyTeammateMemoryReviews / isUntouchedBundledMemoryReview（启动时
 *   经 botV2Migration → globalMemoryTidyRuntime 调用），验证旧版每伙伴每日 `teammate-memory-review`
 *   自动化、纯自动 review 会话、默认检查脚本、多余空伙伴工作区 recentWorkdirs 条目的清理结果与回执幂等。
 * - 规则依据：伙伴记忆 v3 迁移设计——只清理未改动过的默认 bundled 清理任务与纯自动会话，保留用户自定义任务、
 *   有真人对话或主对话/群聊绑定的会话、以及仍有活跃任务的项目目录；升级后写一次性回执避免重复扫描。
 * - 现有覆盖缺口：新增的一次性迁移清理逻辑，尚无既有覆盖。
 * - 最小失败输入：1 个默认 review 伙伴（含 1 个纯自动会话 + 1 个受保护会话 + 空项目）+ 1 个用户改过脚本的伙伴
 *   + 1 个仍有活跃任务的伙伴，运行两次核对清理结果与幂等跳过。
 * - tier：unit（临时目录真实文件 I/O，DB/scheduler 依赖经显式注入的轻量内存替身，耗时 < 200ms）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isUntouchedBundledMemoryReview,
  LEGACY_REVIEW_RETIREMENT_RECEIPT,
  retireLegacyTeammateMemoryReviews,
  type LegacyReviewScheduleRow,
} from '../botMemoryTidyMigration.js';
import {
  ensureMemoryReviewHook,
  MEMORY_REVIEW_CHECK_FILENAME,
  MEMORY_REVIEW_HOOK_COMMAND,
  MEMORY_REVIEW_STATE_FILENAME,
} from '../botProjectMemoryReview.js';
import { botProjectMemoryReview } from '../botProjectMode.js';
import type { ProjectScheduleConfig } from '../../scheduler-host/project-automation-loader.js';

describe('botMemoryTidyMigration', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tidy-migration-'));
  });

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('distinguishes untouched bundled reviews from owner-customized reviews', async () => {
    const workspace = path.join(root, 'bots', 'bot-a', 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    await ensureMemoryReviewHook({ botId: 'bot-a', workingDir: workspace, databasePath: path.join(root, 'db.sqlite') });
    const bundledScript = await fs.readFile(path.join(workspace, '..', MEMORY_REVIEW_CHECK_FILENAME), 'utf8');
    const bundledConfig = {
      ...botProjectMemoryReview({ botId: 'bot-a', displayName: 'Mimi', timezone: 'UTC', title: '{{name}} · Review' }),
      preRunHook: { command: MEMORY_REVIEW_HOOK_COMMAND },
    };

    expect(isUntouchedBundledMemoryReview(bundledConfig, bundledScript)).toBe(true);

    // Owner edited the check script (even keeping similar strings) => must preserve.
    expect(isUntouchedBundledMemoryReview(bundledConfig, `${bundledScript}\n// custom`)).toBe(false);

    // Owner edited cronExpr, prompt, or model while keeping the bundled hook => must preserve.
    expect(isUntouchedBundledMemoryReview({ ...bundledConfig, cronExpr: '0 9 * * *' }, bundledScript)).toBe(false);
    expect(isUntouchedBundledMemoryReview({ ...bundledConfig, prompt: 'Custom review instructions' }, bundledScript)).toBe(false);
    expect(isUntouchedBundledMemoryReview({ ...bundledConfig, model: 'claude-opus-4-6' }, bundledScript)).toBe(false);

    // Owner replaced the hook command => must preserve.
    expect(isUntouchedBundledMemoryReview(
      { ...bundledConfig, preRunHook: { command: 'node custom.js' } },
      null,
    )).toBe(false);

    // Unrelated schedule id => never touched.
    expect(isUntouchedBundledMemoryReview({ ...bundledConfig, id: 'daily-standup' }, bundledScript)).toBe(false);
  });

  it('retires untouched bundled reviews, archives only safe auto sessions, cleans empty recentWorkdirs, preserves custom reviews, and is idempotent', async () => {
    // 1. Buddy A: untouched bundled review + 1 pure auto session + 1 protected session + empty project
    const wsA = path.join(root, 'bots', 'bot-a', 'workspace');
    await fs.mkdir(wsA, { recursive: true });
    await ensureMemoryReviewHook({ botId: 'bot-a', workingDir: wsA, databasePath: path.join(root, 'db.sqlite') });
    await fs.writeFile(path.join(wsA, '..', MEMORY_REVIEW_STATE_FILENAME), '{"lastFileCheckedAt":1}\n');

    // 2. Buddy B: owner-customized check script + still has active project task
    const wsB = path.join(root, 'bots', 'bot-b', 'workspace');
    await fs.mkdir(wsB, { recursive: true });
    await fs.writeFile(path.join(wsB, '..', MEMORY_REVIEW_CHECK_FILENAME), '/* custom check kept by owner */');

    const bundledA: ProjectScheduleConfig = {
      ...botProjectMemoryReview({ botId: 'bot-a', displayName: 'A', timezone: 'UTC', title: '{{name}} · Review' }),
      preRunHook: { command: MEMORY_REVIEW_HOOK_COMMAND },
    };
    const projectConfigs = new Map<string, ProjectScheduleConfig[]>([
      [wsA, [bundledA]],
      [wsB, [{ id: 'teammate-memory-review', name: 'B · Custom', prompt: 'Custom', cronExpr: '0 4 * * *', preRunHook: { command: MEMORY_REVIEW_HOOK_COMMAND } }]],
    ]);
    const dbRows: LegacyReviewScheduleRow[] = [
      { id: 'sched-a', workingDir: wsA, targetSessionId: 'sess-auto-1', projectConfigId: 'teammate-memory-review' },
      { id: 'sched-b', workingDir: wsB, targetSessionId: 'sess-custom', projectConfigId: 'teammate-memory-review' },
    ];

    const removedProjectSchedules: Array<[string, string]> = [];
    const deletedSchedules: string[] = [];
    const archivedSessions: string[] = [];
    const removedRecentWorkdirs: string[] = [];
    const notifiedWorkdirs: string[] = [];

    const deps = {
      ownerRoot: root,
      assertCurrent: () => {},
      listLocalTeammateWorkspaces: async () => [wsA, wsB],
      loadProjectSchedules: async (dir: string) => projectConfigs.get(dir) ?? null,
      removeProjectSchedule: async (dir: string, id: string) => { removedProjectSchedules.push([dir, id]); },
      listLegacyReviewSchedules: async () => dbRows,
      listRunSessionIds: async (scheduleId: string) => (scheduleId === 'sched-a' ? ['sess-auto-1', 'sess-protected'] : ['sess-custom']),
      deleteSchedule: async (id: string) => { deletedSchedules.push(id); },
      isSafeAutoReviewSession: async (sessionId: string) => sessionId === 'sess-auto-1',
      archiveSession: async (sessionId: string) => { archivedSessions.push(sessionId); return true; },
      hasActiveProjectTasks: async (dir: string) => dir === wsB,
      removeRecentWorkdir: async (dir: string) => { removedRecentWorkdirs.push(dir); return true; },
      notifyRecentWorkdirsChanged: (dir: string) => { notifiedWorkdirs.push(dir); },
    };

    const first = await retireLegacyTeammateMemoryReviews(deps);
    expect(first).toEqual({
      skipped: false,
      schedulesRemoved: 1,
      sessionsArchived: 1,
      checkFilesRemoved: 1,
      recentWorkdirsRemoved: 1,
      preservedCustom: 1,
    });

    expect(removedProjectSchedules).toEqual([[wsA, 'teammate-memory-review']]);
    expect(deletedSchedules).toEqual(['sched-a']);
    expect(archivedSessions).toEqual(['sess-auto-1']);
    expect(removedRecentWorkdirs).toEqual([wsA]);
    expect(notifiedWorkdirs).toEqual([wsA]);

    // Untouched bundled check + state files removed for Buddy A; custom check preserved for Buddy B.
    await expect(fs.stat(path.join(wsA, '..', MEMORY_REVIEW_CHECK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(wsA, '..', MEMORY_REVIEW_STATE_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(wsB, '..', MEMORY_REVIEW_CHECK_FILENAME), 'utf8')).toBe('/* custom check kept by owner */');

    // Receipt written and second run skips immediately.
    const receipt = JSON.parse(await fs.readFile(path.join(root, LEGACY_REVIEW_RETIREMENT_RECEIPT), 'utf8'));
    expect(receipt.version).toBe(1);
    const listSpy = vi.fn(deps.listLocalTeammateWorkspaces);
    const second = await retireLegacyTeammateMemoryReviews({ ...deps, listLocalTeammateWorkspaces: listSpy });
    expect(second.skipped).toBe(true);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('defers the permanent receipt when a required cleanup step fails so the next startup retries', async () => {
    const ws = path.join(root, 'bots', 'bot-retry', 'workspace');
    await fs.mkdir(ws, { recursive: true });
    const bundled: ProjectScheduleConfig = {
      ...botProjectMemoryReview({ botId: 'bot-retry', displayName: 'Retry', timezone: 'UTC', title: '{{name}} · Review' }),
      preRunHook: { command: MEMORY_REVIEW_HOOK_COMMAND },
    };
    await retireLegacyTeammateMemoryReviews({
      ownerRoot: root,
      assertCurrent: () => {},
      listLocalTeammateWorkspaces: async () => [ws],
      loadProjectSchedules: async () => [bundled],
      removeProjectSchedule: async () => {},
      listLegacyReviewSchedules: async () => [
        { id: 'sched-retry', workingDir: ws, targetSessionId: null, projectConfigId: 'teammate-memory-review' },
      ],
      listRunSessionIds: async () => [],
      deleteSchedule: async () => { throw new Error('DB locked'); },
      isSafeAutoReviewSession: async () => false,
      archiveSession: async () => false,
      hasActiveProjectTasks: async () => true,
      removeRecentWorkdir: async () => false,
    });
    await expect(fs.stat(path.join(root, LEGACY_REVIEW_RETIREMENT_RECEIPT))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
