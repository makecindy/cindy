import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { acquireWindowsPackagedInstanceBarrier } from '../windowsPackagedInstanceBarrier.js';

// Real PowerShell startup and Add-Type compilation must not compete with the unit worker pool.
describe('windowsPackagedInstanceBarrier native integration', () => {
  it.runIf(process.platform === 'win32')(
    'holds the packaged startup mutex until release and allows a later retry',
    async () => {
      const programName = `CindyBarrierTest${process.pid}`;
      const userDataDir = path.join(os.tmpdir(), programName);
      const first = await acquireWindowsPackagedInstanceBarrier({
        userDataDir,
        programName,
        timeoutMs: 1_000,
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
        timeoutMs: 1_000,
      });
      expect(retry.isHeld()).toBe(true);
      await retry.release();
    },
  );
});
