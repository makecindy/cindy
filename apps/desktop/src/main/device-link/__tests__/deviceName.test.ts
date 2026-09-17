import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: query }));
vi.mock('node:util', () => ({ promisify: () => query }));
vi.mock('node:os', () => ({ default: { hostname: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.mocked(os.hostname).mockReturnValue('DashdeMacBook-Pro.local');
});
afterEach(() => vi.restoreAllMocks());

describe('deviceName', () => {
  it('shares the pending lookup and reuses its result across reads and initialization', async () => {
    let finish!: (result: { stdout: string }) => void;
    query.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { deviceName, initializeDeviceName } = await import('../deviceName');
    const ready = initializeDeviceName();
    expect(initializeDeviceName()).toBe(ready);
    expect(deviceName()).toBe('DashdeMacBook-Pro');
    finish({ stdout: '  Dash的 MacBook Pro.local\n' });
    await ready;
    await initializeDeviceName();
    expect(deviceName()).toBe('Dash的 MacBook Pro.local');
    expect(deviceName()).toBe('Dash的 MacBook Pro.local');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: 500,
      maxBuffer: 16 * 1024,
      killSignal: 'SIGKILL',
    });
  });

  it.each(['throw', 'reject'])('caches fallback when the OS lookup fails via %s', async (mode) => {
    const error = Object.assign(new Error('scutil timed out'), { code: 'ETIMEDOUT' });
    if (mode === 'reject') query.mockRejectedValue(error);
    else
      query.mockImplementation(() => {
        throw error;
      });
    const { deviceName, initializeDeviceName } = await import('../deviceName');
    await initializeDeviceName();
    await initializeDeviceName();
    expect(deviceName()).toBe('DashdeMacBook-Pro');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('falls back when ComputerName is blank', async () => {
    query.mockResolvedValue({ stdout: ' \n' });
    const { deviceName, initializeDeviceName } = await import('../deviceName');
    await initializeDeviceName();
    expect(deviceName()).toBe('DashdeMacBook-Pro');
  });

  it.each(['win32', 'linux'] as const)('does not run scutil on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.mocked(os.hostname).mockReturnValue('  WORK-PC  ');
    const { deviceName, initializeDeviceName } = await import('../deviceName');
    await initializeDeviceName();
    expect(deviceName()).toBe('WORK-PC');
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    [' Mac.LOCAL. ', 'Mac'],
    ['Mac.local.example', 'Mac.local.example'],
    ['Mac.example.com', 'Mac.example.com'],
    [' ', 'Unknown Device'],
    ['.local', 'Unknown Device'],
  ])('normalizes fallback hostname %j to %j', async (hostname, expected) => {
    query.mockResolvedValue({ stdout: '' });
    vi.mocked(os.hostname).mockReturnValue(hostname);
    const { deviceName, initializeDeviceName } = await import('../deviceName');
    await initializeDeviceName();
    expect(deviceName()).toBe(expected);
  });
});
