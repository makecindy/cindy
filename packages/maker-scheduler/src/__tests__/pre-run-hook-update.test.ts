import { describe, expect, it, vi } from 'vitest';

import {
  stabilizePreRunHookForCreate,
  stabilizePreRunHookForUpdate,
} from '../pre-run-hook-update.js';
import type { CreateScheduleInput, Schedule, UpdateScheduleInput } from '../types.js';

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'check',
    prompt: 'run',
    kind: 'cron',
    cronExpr: '0 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    workspaceKind: 'project',
    workingDir: '/project-a',
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    preRunHook: { command: 'node scripts/check.mjs', timeoutMs: 5_000 },
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('stabilizePreRunHookForUpdate', () => {
  it('改绑时用改绑前 cwd 固化未修改的相对命令', async () => {
    const stabilizeCommand = vi.fn(async ({ command, workingDir }) => `${command}@${workingDir}`);
    const patch: UpdateScheduleInput = {
      targetSessionId: 'session-b',
      preRunHook: { command: 'node scripts/check.mjs', timeoutMs: 5_000 },
    };
    const result = await stabilizePreRunHookForUpdate(schedule(), patch, {
      resolveSessionWorkDir: async (sessionId) =>
        sessionId === 'session-b' ? '/project-b' : undefined,
      stabilizeCommand,
    });

    expect(stabilizeCommand).toHaveBeenCalledWith({
      command: 'node scripts/check.mjs',
      workingDir: '/project-a',
    });
    expect(result.preRunHook?.command).toBe('node scripts/check.mjs@/project-a');
  });

  it('同时换命令时用改绑后的会话 cwd 解析新命令', async () => {
    const stabilizeCommand = vi.fn(async ({ command, workingDir }) => `${command}@${workingDir}`);
    const result = await stabilizePreRunHookForUpdate(
      schedule(),
      {
        targetSessionId: 'session-b',
        preRunHook: { command: 'node scripts/new-check.mjs' },
      },
      {
        resolveSessionWorkDir: async () => '/project-b',
        stabilizeCommand,
      },
    );

    expect(stabilizeCommand).toHaveBeenCalledWith({
      command: 'node scripts/new-check.mjs',
      workingDir: '/project-b',
    });
    expect(result.preRunHook?.command).toBe('node scripts/new-check.mjs@/project-b');
  });

  it('patch 没带 hook 时仍可迁移旧相对命令并保留 timeout', async () => {
    const result = await stabilizePreRunHookForUpdate(
      schedule(),
      { name: 'renamed' },
      {
        resolveSessionWorkDir: async () => undefined,
        stabilizeCommand: async ({ command }) => `absolute:${command}`,
      },
    );

    expect(result).toMatchObject({
      name: 'renamed',
      preRunHook: {
        command: 'absolute:node scripts/check.mjs',
        timeoutMs: 5_000,
      },
    });
  });

  it('关闭 hook 时不调用稳定化服务', async () => {
    const stabilizeCommand = vi.fn(async ({ command }) => command);
    const patch = { preRunHook: null } as UpdateScheduleInput;
    await expect(
      stabilizePreRunHookForUpdate(schedule(), patch, {
        resolveSessionWorkDir: async () => undefined,
        stabilizeCommand,
      }),
    ).resolves.toBe(patch);
    expect(stabilizeCommand).not.toHaveBeenCalled();
  });
});

describe('stabilizePreRunHookForCreate', () => {
  it('绑定会话创建时按会话 cwd 固化命令', async () => {
    const input = {
      name: 'check',
      prompt: 'run',
      kind: 'cron',
      cronExpr: '0 * * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'codex',
      workspaceKind: 'project',
      useWorktree: false,
      targetSessionId: 'session-b',
      preRunHook: { command: 'node scripts/check.mjs' },
      notify: { desktop: true, feishu: false },
    } satisfies CreateScheduleInput;
    const result = await stabilizePreRunHookForCreate(input, {
      resolveSessionWorkDir: async () => '/project-b',
      stabilizeCommand: async ({ command, workingDir }) => `${command}@${workingDir}`,
    });

    expect(result.preRunHook?.command).toBe('node scripts/check.mjs@/project-b');
  });
});


describe('script lifecycle bindings keep hook cwd independent', () => {
  it.each([undefined, 'agent'] as const)(
    'resolves retained relative hooks in the new script project when switching from %s',
    async (executionMode) => {
      const existing = schedule({ executionMode, targetSessionId: 'owner' });
      const resolveSessionWorkDir = vi.fn(async () => '/owner-project');
      // MCP may omit the hook; the desktop editor resubmits its unchanged value.
      for (const hookPatch of [{}, { preRunHook: existing.preRunHook }]) {
        const result = await stabilizePreRunHookForUpdate(existing, {
          executionMode: 'script', workingDir: '/script-project', ...hookPatch,
        }, {
          resolveSessionWorkDir,
          stabilizeCommand: async ({ command, workingDir }) => `${command}@${workingDir}`,
        });
        expect(result.preRunHook).toEqual({
          command: 'node scripts/check.mjs@/script-project', timeoutMs: 5_000,
        });
      }
      expect(resolveSessionWorkDir).not.toHaveBeenCalled();
    },
  );

  it('resolves create and update hooks in the script project', async () => {
    const deps = { resolveSessionWorkDir: vi.fn(async () => '/owner'),
      stabilizeCommand: vi.fn(async ({ command, workingDir }) => `${command}@${workingDir}`) };
    const bound = schedule({ executionMode: 'script', targetSessionId: 'owner' });
    const created = await stabilizePreRunHookForCreate(bound, deps);
    expect(created.preRunHook?.command).toBe('node scripts/check.mjs@/project-a');
    const unchanged = await stabilizePreRunHookForUpdate(bound, { workingDir: '/project-b' }, deps);
    expect(unchanged.preRunHook?.command).toBe('node scripts/check.mjs@/project-a');
    const changed = await stabilizePreRunHookForUpdate(bound, { workingDir: '/project-b',
      preRunHook: { command: 'node new.mjs' } }, deps);
    expect(changed.preRunHook?.command).toBe('node new.mjs@/project-b');
    expect(deps.resolveSessionWorkDir).not.toHaveBeenCalled();
  });
});
