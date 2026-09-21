import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { Schedule } from '@cindy/maker-scheduler';

import {
  __testing,
  ProjectAutomationLoader,
  schedulesDiffer,
  type ProjectScheduleConfig,
} from '../project-automation-loader';
import { scheduleCreateToRow, schedulePatchToRow, scheduleToCamel } from '../../localDb/mapper';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../../shared/projectAutomationPaths';

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

describe('project automation explicit Harness reconciliation', () => {
  it('detects marker-only changes, persists them, and clears them without losing the bound task', () => {
    const current: Schedule = { ...projectSchedule({ desktop: true, feishu: false }),
      agentKind: 'pi', model: 'test-model', persistentSession: true, targetSessionId: 'bound-codex' };
    const config = projectConfig({ agentKind: 'pi', modelAgentKind: 'pi', model: 'test-model', persistentSession: true });
    expect(schedulesDiffer(current, config, workingDir)).toBe(true);
    const input = __testing.scheduleConfigToUpdateInput(config, workingDir);
    expect(input.modelAgentKind).toBe('pi');
    const saved = scheduleToCamel({ ...scheduleCreateToRow(current),
      ...schedulePatchToRow({ modelAgentKind: input.modelAgentKind }),
    } as Parameters<typeof scheduleToCamel>[0]);
    expect(saved).toMatchObject({ modelAgentKind: 'pi', persistentSession: true, targetSessionId: 'bound-codex' });
    expect(schedulesDiffer(saved, config, workingDir)).toBe(false);

    const legacy = { ...config, modelAgentKind: undefined };
    expect(schedulesDiffer(saved, legacy, workingDir)).toBe(true);
    const clearInput = __testing.scheduleConfigToUpdateInput(legacy, workingDir);
    expect(clearInput).toHaveProperty('modelAgentKind', undefined);
    const cleared = scheduleToCamel({ ...scheduleCreateToRow(saved),
      ...schedulePatchToRow({ modelAgentKind: clearInput.modelAgentKind }),
    } as Parameters<typeof scheduleToCamel>[0]);
    expect(cleared.modelAgentKind).toBeUndefined();
    expect(cleared.targetSessionId).toBe('bound-codex');
    expect(schedulesDiffer(cleared, legacy, workingDir)).toBe(false);
  });

  it.each([
    { override: {}, valid: true },
    { override: { modelAgentKind: 'pi', model: 'test-model' }, valid: true },
    { override: { modelAgentKind: 'invalid', model: 'test-model' }, valid: false },
    { override: { modelAgentKind: 'pi' }, valid: false },
  ])('loads version 1 project files with compatible Harness validation: %j', async ({ override, valid }) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'cindy-project-harness-'));
    try {
      const file = path.join(dir, ...PROJECT_AUTOMATION_REL_SEGMENTS);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const config = { ...projectConfig(), ...override };
      await fs.writeFile(file, JSON.stringify({ version: 1, schedules: [config] }));
      // File loading must not access the scheduler or database.
      const loader = new ProjectAutomationLoader({
        get scheduler(): never { throw new Error('file loading must not access the scheduler'); },
        get storage(): never { throw new Error('file loading must not access storage'); },
        getDb(): never { throw new Error('file loading must not access the database'); },
        logger: { warn: vi.fn(), debug: vi.fn() },
      });
      expect(await loader.loadProjectSchedules(dir)).toEqual(valid ? [config] : null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
