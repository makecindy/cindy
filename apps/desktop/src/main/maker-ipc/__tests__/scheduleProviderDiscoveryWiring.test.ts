import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const scheduleSource = readFileSync(resolve(__dirname, '..', 'schedule.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('schedule provider discovery IPC trust boundary', () => {
  it('gates provider claim and discovery side effects on the trusted caller', () => {
    const start = scheduleSource.indexOf(
      'ipcMain.handle(MAKER_INVOKE.SCHEDULE_GENERATE_PRE_RUN_HOOK',
    );
    const end = scheduleSource.indexOf(
      '  // 表单「测试运行」:立即执行一次前置检查脚本并回显结果',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = scheduleSource.slice(start, end);

    expect(handler).toContain('async (event, payload: unknown)');
    expect(handler).toContain('isDeviceLinkInvoke() || isTrustedAppRendererEvent(event)');
    expect(handler).toContain('allowSideEffects: trustedCaller');
    expect(handler).toContain('waitForDiscovery: trustedCaller');
  });
});
