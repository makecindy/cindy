import { describe, it, expect } from 'vitest';

import { formToProjectConfig, projectAutomationConfigPath } from '../projectAutomationConfig';
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

describe('project automation providerId serialization', () => {
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
