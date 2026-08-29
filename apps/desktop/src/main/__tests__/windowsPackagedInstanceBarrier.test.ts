import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  acquireWindowsPackagedInstanceBarrier,
  __testing,
} from '../windowsPackagedInstanceBarrier.js';

describe('windowsPackagedInstanceBarrier', () => {
  it('parses only complete helper statuses', () => {
    expect(__testing.parseBarrierStatus('{"status":"acquired"}')).toEqual({
      status: 'acquired',
    });
    expect(__testing.parseBarrierStatus('{"status":"busy"}')).toEqual({ status: 'busy' });
    expect(__testing.parseBarrierStatus('{"status":"occupied","pid":4242}')).toEqual({
      status: 'occupied',
      pid: 4242,
    });
    expect(() => __testing.parseBarrierStatus('{"status":"occupied","pid":0}')).toThrow(
      'invalid status',
    );
  });

  it('uses Electron ProcessSingleton names and a message-only-window probe', () => {
    expect(__testing.processSingletonNames('Cindy')).toEqual({
      mutexName: 'Local\\CindyProcessSingletonStartup',
      windowClass: 'Chrome_MessageWindow',
    });
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain('FindWindowEx');
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain(
      'CINDY_SINGLETON_WINDOW_CLASS',
    );
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain(
      'CINDY_SINGLETON_WINDOW_TITLE',
    );
  });

  it.runIf(process.platform === 'win32')(
    'holds the packaged startup mutex until release and allows a later retry',
    async () => {
      const programName = `CindyBarrierTest${process.pid}`;
      const userDataDir = path.join(os.tmpdir(), programName);
      // timeoutMs 是 mutex WaitOne; waitForFirstLine 另加 HELPER_STARTUP_SLACK
      // 等 PowerShell Add-Type。Windows CI 负载高时编译常超过 2s。
      const first = await acquireWindowsPackagedInstanceBarrier({
        userDataDir,
        programName,
        timeoutMs: 15_000,
      });
      try {
        expect(first.isHeld()).toBe(true);
        await expect(
          acquireWindowsPackagedInstanceBarrier({
            userDataDir,
            programName,
            timeoutMs: 50,
          }),
        ).rejects.toThrow('startup barrier is busy');
      } finally {
        await first.release();
      }
      expect(first.isHeld()).toBe(false);

      const retry = await acquireWindowsPackagedInstanceBarrier({
        userDataDir,
        programName,
        timeoutMs: 15_000,
      });
      expect(retry.isHeld()).toBe(true);
      await retry.release();
    },
  );
});
