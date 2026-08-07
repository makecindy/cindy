import { describe, expect, it } from 'vitest';

import type { Schedule } from '@cindy/maker-scheduler';

import {
  __testing,
  schedulesDiffer,
  type ProjectScheduleConfig,
} from '../project-automation-loader';

const workingDir = 'C:\\project';

function projectConfig(overrides: Partial<ProjectScheduleConfig> = {}): ProjectScheduleConfig {
  return {
    id: 'daily',
    name: 'Daily',
    prompt: 'Run checks',
    cronExpr: '0 9 * * *',
    notify: { desktop: true, feishu: false },
    ...overrides,
  };
}

function projectSchedule(notify: Schedule['notify']): Schedule {
  return {
    id: 'schedule-1',
    name: 'Daily',
    prompt: 'Run checks',
    source: 'project',
    projectConfigId: 'daily',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir,
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    notify,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('project automation WeCom group notification reconciliation', () => {
  it('emits an explicit false update when the project disables the channel', () => {
    const input = __testing.scheduleConfigToUpdateInput(
      projectConfig({ notify: { desktop: true, feishu: false, wecomGroup: false } }),
      workingDir,
    );

    expect(input.notify).toEqual({
      desktop: true,
      feishu: false,
      wecomGroup: false,
    });
  });

  it('updates a previously enabled channel and stays stable after it is disabled', () => {
    const config = projectConfig();

    expect(
      schedulesDiffer(
        projectSchedule({ desktop: true, feishu: false, wecomGroup: true }),
        config,
        workingDir,
      ),
    ).toBe(true);
    expect(
      schedulesDiffer(projectSchedule({ desktop: true, feishu: false }), config, workingDir),
    ).toBe(false);
  });
});

describe('project automation provider reconciliation', () => {
  it('passes an explicit provider through the loader input and detects changes', () => {
    const config = projectConfig({ providerId: 'openai' });
    const input = __testing.scheduleConfigToUpdateInput(config, workingDir);
    expect(input.providerId).toBe('openai');
    expect(
      schedulesDiffer(projectSchedule({ desktop: true, feishu: false }), config, workingDir),
    ).toBe(true);
  });
});
