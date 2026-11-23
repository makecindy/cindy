import { describe, it, expect } from 'vitest';

import { formToProjectConfig, projectAutomationConfigPath, scheduleToProjectConfig } from '../projectAutomationConfig';
import type { Schedule } from '@cindy/maker-scheduler';
import type { ScheduleFormState } from '../scheduleFormLogic';

describe('projectAutomationConfigPath', () => {
  it('posix workingDir 拼出 .cindy/automations/schedules.json', () => {
    expect(projectAutomationConfigPath('/home/user/repo')).toBe(
      '/home/user/repo/.cindy/automations/schedules.json',
    );
  });

  it('windows workingDir 用反斜杠拼接', () => {
    expect(projectAutomationConfigPath('C:\\Users\\admin\\repo\\')).toBe(
      'C:\\Users\\admin\\repo\\.cindy\\automations\\schedules.json',
    );
  });
});

function makeForm(overrides: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    name: 'follow-up',
    prompt: 'check the PR',
    cronExpr: '*/10 * * * *',
    intervalMs: undefined,
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    model: '',
    providerId: '',
    effort: '',
    fastMode: false,
    workspaceKind: 'project',
    workingDir: '/repo/project',
    useWorktree: true,
    targetSessionId: '',
    persistentSession: false,
    silentWhenIdle: false,
    preRunHookEnabled: false,
    preRunHookCommand: '',
    preRunHookTimeoutSec: '',
    notifyDesktop: true,
    notifyFeishu: false,
    ...overrides,
  } as ScheduleFormState;
}

describe('formToProjectConfig fastMode', () => {
  it('serializes fastMode for codex and pi, omits it for claude-code (codex review)', () => {
    // runner.ts:665:fastMode 对 Codex / Pi 生效,claude-code 忽略。
    expect(formToProjectConfig(makeForm({ agentKind: 'codex', fastMode: true }), 'c1').fastMode).toBe(true);
    expect(formToProjectConfig(makeForm({ agentKind: 'pi', fastMode: true }), 'p1').fastMode).toBe(true);
    expect(formToProjectConfig(makeForm({ agentKind: 'claude-code', fastMode: true }), 'cc1').fastMode).toBeUndefined();
  });
});

// PR #11881 review r4651177664, unit: the project form is what writes schedules.json. Gap: only the schedule→config
// path carried the mode, so saving the form dropped it and the next load removed it from the database too.
// Minimal input: a form with a mode, the same form as a script, and a saved schedule with a mode.
describe('project automation model group', () => {
  it('keeps the mode when the form saves and when a schedule is promoted; script tasks have none', () => {
    expect(formToProjectConfig(makeForm({ agentKind: 'codex', model: 'gpt-saved', modelGroup: 'daily' }), 'm1').modelGroup).toBe('daily');
    expect(formToProjectConfig(makeForm({ executionMode: 'script', modelGroup: 'daily' }), 'm2').modelGroup).toBeUndefined();
    expect(scheduleToProjectConfig({ id: 's1', name: 'Daily', prompt: 'Check', cronExpr: '0 9 * * *', timezone: 'UTC',
      agentKind: 'codex', model: 'gpt-saved', modelGroup: 'daily' } as Schedule).modelGroup).toBe('daily');
  });
});

describe('project automation providerId serialization', () => {
  // PR #6832: promotion and subsequent edits must keep the provider's device.
  // Unit: both production projections cross JSON, which previously lost it.
  it('preserves the runtime location through promotion and form edits', () => {
    const route = { model: 'remote-model', providerId: 'remote-provider', agentDeviceId: 'studio' };
    const promoted = JSON.parse(JSON.stringify(scheduleToProjectConfig({
      id: 's1', name: 'n', prompt: 'p', cronExpr: '0 9 * * *', ...route,
    } as Schedule, 'daily')));
    expect(promoted).toMatchObject(route);
    const form = makeForm(route);
    expect(JSON.parse(JSON.stringify(formToProjectConfig(form, 'daily')))).toMatchObject(route);
    expect(JSON.parse(JSON.stringify(formToProjectConfig({ ...form, agentDeviceId: undefined }, 'daily'))))
      .not.toHaveProperty('agentDeviceId');
  });

  it('preserves an explicit provider from the form', () => {
    expect(formToProjectConfig(makeForm({ providerId: 'openai' }), 'auto-provider').providerId).toBe(
      'openai',
    );
    expect(formToProjectConfig(makeForm({ providerId: '' }), 'auto-default').providerId).toBeUndefined();
  });

  it('preserves an explicit provider when converting an existing schedule', async () => {
    const { scheduleToProjectConfig } = await import('../projectAutomationConfig');
    const config = scheduleToProjectConfig(
      {
        id: 's1',
        name: 'n',
        prompt: 'p',
        cronExpr: '0 9 * * *',
        providerId: 'openai',
      } as never,
      'auto-provider',
    );
    expect(config.providerId).toBe('openai');
  });
});

describe('project automation explicit Harness serialization', () => {
  // User decision 2026-11-16 / unit: a newly supplied default must not need an ID allowlist
  // to clear a stale route when the owner selects buddy inheritance.
  it('serializes buddy inheritance for a new default task ID without retaining its old route', () => {
    const config = JSON.parse(JSON.stringify(formToProjectConfig(makeForm({
      followTeammateModel: true, agentKind: 'codex', modelAgentKind: 'codex',
      model: 'old-model', providerId: 'old-provider', modelAgentDeviceId: 'remote',
      agentDeviceId: 'remote', effort: 'high', fastMode: 'ultrafast',
    }), 'future-default-task')));
    expect(config.followTeammateModel).toBe(true);
    for (const key of ['model', 'agentKind', 'modelAgentKind', 'modelAgentDeviceId',
      'providerId', 'agentDeviceId', 'effort', 'fastMode']) expect(config).not.toHaveProperty(key);
  });

  it('preserves the selection through JSON and omits its marker when following', () => {
    const form = makeForm({ agentKind: 'pi', modelAgentKind: 'pi', model: 'test-model',
      providerId: 'custom', effort: 'medium', fastMode: true, persistentSession: true,
      targetSessionId: 'bound-codex' });
    expect(JSON.parse(JSON.stringify(formToProjectConfig(form, 'daily')))).toMatchObject({
      agentKind: 'pi', modelAgentKind: 'pi', model: 'test-model', providerId: 'custom',
      effort: 'medium', fastMode: true, persistentSession: true,
    });
    const followed = JSON.parse(JSON.stringify(formToProjectConfig({ ...form,
      agentKind: 'codex', modelAgentKind: undefined, model: '', providerId: '', effort: '', fastMode: false,
    }, 'daily')));
    expect(followed.agentKind).toBe('codex');
    expect(followed).not.toHaveProperty('modelAgentKind');
    expect(followed).not.toHaveProperty('model');
    expect(followed).not.toHaveProperty('fastMode');
  });

  it('preserves the explicit Harness when exporting an existing schedule', () => {
    const config = scheduleToProjectConfig({
      id: 's1', name: 'n', prompt: 'p', cronExpr: '0 9 * * *',
      agentKind: 'codex', modelAgentKind: 'pi', model: 'test-model', persistentSession: true,
    } as Schedule, 'daily');
    expect(JSON.parse(JSON.stringify(config))).toMatchObject({
      agentKind: 'codex', modelAgentKind: 'pi', model: 'test-model', persistentSession: true,
    });
  });
});
