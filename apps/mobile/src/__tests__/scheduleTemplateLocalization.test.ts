import { describe, expect, it } from 'vitest';

import {
  buildMobileTemplateOverrides,
  isLocalizedBuiltinTemplate,
} from '@/scheduler/scheduleTemplateLocalization';
import type { RemoteScheduleTemplate, RemoteScheduleWriteInput } from '@/scheduler/types';

const input: RemoteScheduleWriteInput = {
  name: 'Nightly test repair',
  prompt: 'Run the test suite and repair clear failures.',
  kind: 'cron',
  cronExpr: '0 2 * * *',
  timezone: 'Asia/Shanghai',
  recurring: true,
  agentKind: 'codex',
  useWorktree: true,
  notify: { desktop: true, feishu: false },
};

function template(patch: Partial<RemoteScheduleTemplate> = {}): RemoteScheduleTemplate {
  return {
    id: 'nightly-test-heal',
    name: 'Nightly Test Repair',
    description: 'Run tests and repair clear failures.',
    category: 'dev-automation',
    source: 'builtin',
    prompt: '运行测试套件并修复明确的失败。',
    ...patch,
  };
}

describe('mobile schedule template localization', () => {
  it('persists the prompt reviewed in the form for localized built-in templates', () => {
    const builtin = template();

    expect(isLocalizedBuiltinTemplate(builtin)).toBe(true);
    expect(buildMobileTemplateOverrides(input, builtin)).toEqual(input);
  });

  it('keeps the existing desktop-canonical prompt behavior for other templates', () => {
    const overrides = buildMobileTemplateOverrides(input, template({ id: 'custom', source: 'user' }));

    expect(overrides).not.toHaveProperty('prompt');
    expect(overrides).toMatchObject({ name: input.name, cronExpr: input.cronExpr });
  });
});
