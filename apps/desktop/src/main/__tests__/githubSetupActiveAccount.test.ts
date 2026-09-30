import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => mocks);
vi.mock('../git-context/ghBinary', () => ({ resolveGhBinary: async () => 'gh' }));
vi.mock('../managed-tools/installer', () => ({ installTool: vi.fn() }));
import { createGithubSetup } from '../git-context/githubSetup';
import { createGhCliTokenSource } from '../git-context/ghCliTokenSource';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each(['GH_TOKEN', 'GITHUB_TOKEN', 'gh_token'])(
  'ignores %s throughout saved-account login and reads',
  async (key) => {
    vi.stubEnv(key, 'invalid-test-override');
    vi.stubEnv('HTTPS_PROXY', 'http://example.test:8080');
    let loggedIn = false;
    const checkEnv = (env: NodeJS.ProcessEnv) => {
      expect(
        Object.keys(env).some((name) => ['GH_TOKEN', 'GITHUB_TOKEN'].includes(name.toUpperCase())),
      ).toBe(false);
      expect(env.HTTPS_PROXY).toBe('http://example.test:8080');
    };
    mocks.execFile.mockImplementation((_binary, args, options, callback) => {
      checkEnv(options.env);
      callback(
        args[0] === 'api' && !loggedIn ? new Error('not logged in') : null,
        args[0] === 'auth' ? 'saved-test-token' : '',
        '',
      );
    });
    mocks.spawn.mockImplementation((_binary, _args, options) => {
      checkEnv(options.env);
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        stdout: { resume: vi.fn() },
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('one-time code: ABCD-EFGH'));
        loggedIn = true;
        child.emit('close', 0);
      });
      return child;
    });
    const setup = createGithubSetup('unused', vi.fn());
    setup.start();
    await vi.waitFor(() => expect(setup.snapshot().phase).toBe('connected'));
    expect(mocks.spawn).toHaveBeenCalledOnce();
    const source = createGhCliTokenSource({
      execFileFn: mocks.execFile,
      resolveBinary: async () => 'gh',
    });
    expect(await source.probeAvailability()).toBe(true);
    expect(await source.readToken()).toBe('saved-test-token');
    expect(process.env[key]).toBe('invalid-test-override');
  },
);

it('connects with a valid active account even when a secondary account has expired', async () => {
  mocks.execFile.mockImplementation((_binary, args, _options, callback) => {
    const failure = args.includes('--active')
      ? 'unknown flag: --active'
      : args[0] === 'auth'
        ? 'secondary account expired'
        : null;
    callback(failure ? new Error(failure) : null, '', '');
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
    ['api', '--hostname', 'github.com', 'user', '--silent'],
    expect.any(Object),
    expect.any(Function),
  );
});
