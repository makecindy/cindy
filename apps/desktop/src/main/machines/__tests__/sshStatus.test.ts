import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { parseSshStatus, parseVmStatAvailableBytes, SSH_STATUS_COMMAND } from '../sshStatus.js';

describe('macOS available memory', () => {
  it('counts reclaimable pages, not only completely free ones', () => {
    expect(parseVmStatAvailableBytes([
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               1000.',
      'Pages active:                             9000.',
      'Pages inactive:                           2000.',
      'Pages speculative:                         500.',
    ].join('\n'))).toBe(3500 * 16384);
  });

  it('reports unknown rather than a wrong number when the output changes', () => {
    expect(parseVmStatAvailableBytes('unexpected')).toBeNull();
  });
});

// /bin/sh differs across systems: macOS's rejected a nested-quote form that worked on Linux, which lost the disk reading.
describe.skipIf(process.platform === 'win32')('SSH status command', () => {
  it('reads every fact when run by the real shell', () => {
    const parsed = parseSshStatus(execFileSync('/bin/sh', ['-c', SSH_STATUS_COMMAND], { encoding: 'utf8' }));
    expect(parsed?.status.memory.availableBytes).toBeGreaterThan(0);
    expect(parsed?.status.cpu.loadAverage1m).not.toBeNull();
    expect(parsed?.status.disk?.totalBytes).toBeGreaterThan(0);
  });
});
