import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app', getPath: () => '/fake/profile' },
  exec: vi.fn(),
  access: vi.fn(),
}));
vi.mock('electron', () => ({ app: mocks.app, screen: {} }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => mocks.exec }));
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: async () => 'source',
    access: mocks.access,
    mkdir: vi.fn(),
    rename: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.app.isPackaged = false;
  mocks.exec.mockReset().mockResolvedValue({ stdout: '{"available":true}' });
  mocks.access.mockReset().mockResolvedValue(undefined);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});
afterEach(() => vi.restoreAllMocks());

it('probes an existing binary once across concurrent capability requests', async () => {
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await Promise.all([viewerDisplaySupported(), viewerDisplaySupported()])).toEqual([
    true,
    true,
  ]);
  expect(mocks.exec).toHaveBeenCalledTimes(1);
  expect(mocks.exec).toHaveBeenCalledWith(
    expect.stringContaining('cindy-viewer-display'),
    ['--probe'],
    { timeout: 5000 },
  );
});
it('does not advertise support after a failed SPI probe', async () => {
  mocks.exec.mockRejectedValue(new Error('unsupported SPI'));
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await viewerDisplaySupported()).toBe(false);
  expect(mocks.exec).toHaveBeenCalledTimes(1);
});
it('does not advertise support when compilation fails', async () => {
  mocks.access.mockRejectedValue(new Error('missing'));
  mocks.exec.mockRejectedValue(new Error('clang unavailable'));
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await viewerDisplaySupported()).toBe(false);
  expect(mocks.exec).toHaveBeenCalledWith('clang', expect.any(Array), expect.any(Object));
});
it.each(['packaged', 'windows'] as const)('does no helper work for %s builds', async (kind) => {
  if (kind === 'packaged') mocks.app.isPackaged = true;
  else vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const { viewerDisplaySupported } = await import('../viewerDisplay');
  expect(await viewerDisplaySupported()).toBe(false);
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.access).not.toHaveBeenCalled();
});
