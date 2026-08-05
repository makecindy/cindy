import { describe, it, expect } from 'vitest';

import { projectAutomationConfigPath } from '../projectAutomationConfig';

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
