import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { acquireWindowsPackagedInstanceBarrier } from '../windowsPackagedInstanceBarrier.js';

// windows-resource: the real PowerShell helper and Win32 mutex cannot share the
// unit file's process mocks. Windows CI runs this tier serially and requires it.
it.runIf(process.platform === 'win32')('holds the packaged startup mutex until release and allows a later retry', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-barrier-test-'));
  const programName = path.basename(userDataDir);
  try {
    const first = await acquireWindowsPackagedInstanceBarrier({ userDataDir, programName, timeoutMs: 1_000 });
    try {
      expect(first.isHeld()).toBe(true);
      await expect(acquireWindowsPackagedInstanceBarrier({ userDataDir, programName, timeoutMs: 50 }))
        .rejects.toThrow('startup barrier is busy');
    } finally {
      await first.release();
    }
    expect(first.isHeld()).toBe(false);

    const retry = await acquireWindowsPackagedInstanceBarrier({ userDataDir, programName, timeoutMs: 1_000 });
    try {
      expect(retry.isHeld()).toBe(true);
    } finally {
      await retry.release();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
