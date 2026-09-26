import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => mocks);
vi.mock('../git-context/ghBinary', () => ({ resolveGhBinary: async () => 'gh' }));
vi.mock('../managed-tools/installer', () => ({ installTool: vi.fn() }));
import { createGithubSetup } from '../git-context/githubSetup';
import { createGhCliTokenSource } from '../git-context/ghCliTokenSource';

it('connects with a valid active account even when a secondary account has expired', async () => {
  mocks.execFile.mockImplementation((_binary, args, _options, callback) => {
    const secondaryFailed = args[0] === 'auth' && !args.includes('--active');
    callback(secondaryFailed ? new Error('secondary account expired') : null, '', '');
  });
  mocks.spawn.mockImplementation(() => {
    throw new Error('unexpected login');
  });
  const connected = vi.fn();
  const setup = createGithubSetup('unused', connected);
  setup.start();
  await vi.waitFor(() => expect(setup.snapshot().phase).toBe('connected'));
  expect(connected).toHaveBeenCalledOnce();
  expect(mocks.spawn).not.toHaveBeenCalled();
  const source = createGhCliTokenSource({
    execFileFn: mocks.execFile,
    resolveBinary: async () => 'gh',
  });
  expect(await source.probeAvailability()).toBe(true);
  expect(mocks.execFile).toHaveBeenCalledWith(
    'gh',
    ['auth', 'status', '--active', '--hostname', 'github.com'],
    expect.any(Object),
    expect.any(Function),
  );
});
