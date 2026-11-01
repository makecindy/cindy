import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ powerMonitor: {} }));
const { parseVmStatAvailableBytes } = await import('../localStatus.js');

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
