import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const scheduleSource = readFileSync(new URL('../maker-ipc/schedule.ts', import.meta.url), 'utf8');

function handlerBody(channel: string): string {
  const start = scheduleSource.indexOf(`ipcMain.handle(MAKER_INVOKE.${channel}`);
  const end = scheduleSource.indexOf('\n  });', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return scheduleSource.slice(start, end);
}

describe('Codex automation migration IPC security contract', () => {
  it('guards preview before reading Codex files or opening the scheduler', () => {
    const handler = handlerBody('SCHEDULE_CODEX_AUTOMATION_PREVIEW');
    const guard = handler.indexOf('assertTrustedAppRendererEvent(event);');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(handler.indexOf('withScheduler('));
    expect(guard).toBeLessThan(handler.indexOf('.preview()'));
  });

  it('guards import before validating payload or mutating schedules', () => {
    const handler = handlerBody('SCHEDULE_CODEX_AUTOMATION_IMPORT');
    const guard = handler.indexOf('assertTrustedAppRendererEvent(event);');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(handler.indexOf('requireObject('));
    expect(guard).toBeLessThan(handler.indexOf('withScheduler('));
    expect(handler).toContain('async (event, payload: unknown)');
  });
});
