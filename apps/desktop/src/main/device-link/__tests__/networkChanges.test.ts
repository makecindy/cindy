import { afterEach, expect, it, vi } from 'vitest';
import { networkInterfaces } from 'node:os';
import { watchNetworkChanges } from '../networkChanges';
vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }));
afterEach(() => vi.useRealTimers());
it('ignores stable/reordered interfaces and stops on teardown', () => {
  vi.useFakeTimers();
  const read = vi.mocked(networkInterfaces);
  const wifi = {
    internal: false,
    family: 'IPv4' as const,
    address: '192.0.2.1',
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: '192.0.2.1/24',
  };
  const vpn = { ...wifi, address: '192.0.2.2', cidr: '192.0.2.2/24' };
  read.mockReturnValue({ en0: [wifi], utun: [vpn] });
  const changed = vi.fn();
  const stop = watchNetworkChanges(changed);
  read.mockReturnValue({ utun: [vpn], en0: [wifi] });
  vi.advanceTimersByTime(2_000);
  expect(changed).not.toHaveBeenCalled();
  read.mockReturnValue({ en0: [wifi] });
  vi.advanceTimersByTime(2_000);
  expect(changed).toHaveBeenCalledTimes(1);
  read.mockImplementation(() => {
    throw new Error('OS unavailable');
  });
  vi.advanceTimersByTime(2_000);
  expect(changed).toHaveBeenCalledTimes(1);
  stop();
  vi.advanceTimersByTime(2_000);
  expect(read).toHaveBeenCalledTimes(4);
});
