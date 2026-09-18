import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { PtySpawnFn } from '../../terminal/ptyFactory';
const h = vi.hoisted(() => ({ links: new Set<string>(), files: new Set<string>(), git: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  lstat: async (file: string) => ({
    isSymbolicLink: () => h.links.has(file),
    isDirectory: () => !h.files.has(file),
    isFile: () => h.files.has(file),
  }),
  realpath: async (file: string) => file,
}));
vi.mock('../sourceGit.js', () => ({ runSourceGit: h.git }));
import { launchMakeTest, makeTestEnvironment, verifyMakeTestWorkspace } from '../testRunner';
import { makeSourceCheckoutPath, makeTaskWorktreePath } from '../sourcePaths';

const profile = path.join(os.tmpdir(), 'cindy-preview-test');
const task = {
  userData: profile,
  workingDir: makeTaskWorktreePath(profile, 'abcd-test'),
  runId: 'abcd-test',
  commit: 'a'.repeat(40),
};
function processHarness() {
  let data: (value: string) => void = () => {};
  let exit: () => void = () => {};
  const kill = vi.fn(() => exit());
  const spawn = vi.fn<PtySpawnFn>(
    () =>
      ({
        onData: (fn: (value: string) => void) => {
          data = fn;
          return { dispose() {} };
        },
        onExit: (fn: (event: { exitCode: number }) => void) => {
          exit = () => fn({ exitCode: 0 });
          return { dispose() {} };
        },
        kill,
      }) as unknown as IPty,
  );
  const controller = new AbortController();
  const process = launchMakeTest(
    task,
    path.join(profile, 'node'),
    { PATH: '/tools', XDT_USER_DATA_DIR: '/host' },
    'global',
    controller.signal,
    spawn,
  );
  void process.ready.catch(() => {});
  const verdict = (extra: Partial<Record<string, string>> = {}) => {
    const sandbox = spawn.mock.calls[0][1]
      .find((arg) => arg.startsWith('--isolated='))!
      .split('=')[1];
    return [
      'DESKTOP_DEV_VERDICT=ready',
      ...Object.entries({
        mode: 'isolated',
        sandbox,
        root: task.workingDir,
        commit: task.commit,
        pid: '4242',
        region: 'global',
        ...extra,
      }).map(([key, value]) => key + '=' + value),
      '',
    ].join('\r\n');
  };
  return {
    process,
    spawn,
    kill,
    controller,
    emit: (value: string) => data(value),
    exit: () => exit(),
    verdict,
  };
}

beforeEach(() => {
  h.links.clear();
  h.files.clear();
  h.git.mockReset();
  h.files.add(path.join(task.workingDir, '.git'));
  h.files.add(path.join(task.workingDir, 'scripts', 'desktop-restart-runner.mjs'));
  h.git.mockImplementation(async (_env, args) => {
    if (args.includes('--git-common-dir'))
      return path.join(makeSourceCheckoutPath(profile), '.git');
    if (args.includes('--abbrev-ref')) return 'cindy-make/abcd-test';
    if (args[0] === 'status') return '';
    return task.commit;
  });
});
afterEach(() => vi.useRealTimers());

describe('isolated Make test runner', () => {
  it('keeps OS/tool paths while dropping host profiles, auth and Node injection', () => {
    expect(
      makeTestEnvironment({
        PATH: '/tools',
        HOME: '/user',
        XDT_USER_DATA_DIR: '/host',
        CINDY_AUTH_REGION: 'cn',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require bad',
        ANTHROPIC_API_KEY: 'fake-secret',
        OPENAI_API_KEY: 'fake-secret',
        CODEX_HOME: '/host/codex',
      }),
    ).toEqual({ PATH: '/tools', HOME: '/user', TERM: 'xterm-256color', FORCE_COLOR: '0' });
  });
  it('uses the existing wrapper, explicit isolation and a real PTY without a shell command', async () => {
    const h = processHarness();
    expect(h.spawn.mock.calls[0][1]).toEqual([
      path.join(task.workingDir, 'scripts', 'desktop-restart-runner.mjs'),
      '--wait-ready',
      '--region=global',
      expect.stringMatching(/^--isolated=make-[0-9a-f]{20}$/),
      '--passive',
    ]);
    expect(h.spawn.mock.calls[0][2].cwd).toBe(task.workingDir);
    expect(h.spawn.mock.calls[0][2].env).not.toHaveProperty('XDT_USER_DATA_DIR');
    const text = h.verdict();
    h.emit(text.slice(0, 17));
    h.emit(text.slice(17));
    await expect(h.process.ready).resolves.toBeUndefined();
    h.exit();
    await h.process.closed;
  });
  it.each([{ root: profile }, { commit: 'b'.repeat(40) }, { mode: 'shared' }, { region: 'cn' }])(
    'rejects a ready verdict for the wrong launch %j',
    async (extra) => {
      const h = processHarness();
      h.emit(h.verdict(extra));
      await expect(h.process.ready).rejects.toMatchObject({ code: 'launchFailed' });
      expect(h.kill).toHaveBeenCalledOnce();
    },
  );
  it('fails on an early exit and aborts only its own process', async () => {
    const h = processHarness();
    h.exit();
    await expect(h.process.ready).rejects.toMatchObject({ code: 'launchFailed' });
    const next = processHarness();
    next.controller.abort();
    await expect(next.process.ready).rejects.toMatchObject({ code: 'interrupted' });
    expect(next.kill).toHaveBeenCalledOnce();
  });
  it('bounds startup even if the wrapper never returns a verdict', async () => {
    vi.useFakeTimers();
    const h = processHarness();
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    await expect(h.process.ready).rejects.toMatchObject({ code: 'timeout' });
    expect(h.kill).toHaveBeenCalledOnce();
  });
});

describe('test workspace validation', () => {
  it('accepts the managed branch at the completed commit without changing files', async () => {
    await expect(
      verifyMakeTestWorkspace(task, {}, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(h.git.mock.calls.every(([, args]) => ['rev-parse', 'status'].includes(args[0]))).toBe(
      true,
    );
  });
  it('rejects a replaced managed root or source Git directory', async () => {
    h.links.add(path.join(makeSourceCheckoutPath(profile), '.git'));
    await expect(
      verifyMakeTestWorkspace(task, {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.git).not.toHaveBeenCalled();
  });
  it('rejects an outside worktree before accessing Git', async () => {
    await expect(
      verifyMakeTestWorkspace({ ...task, workingDir: profile }, {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.git).not.toHaveBeenCalled();
  });
  it.each(['dirty', 'new-head'])('requires fresh completion after %s changes', async (change) => {
    const original = h.git.getMockImplementation()!;
    h.git.mockImplementation(async (env, args) => {
      if (change === 'dirty' && args[0] === 'status') return ' M code.ts';
      if (change === 'new-head' && args.length === 2 && args[1] === 'HEAD') return 'b'.repeat(40);
      return original(env, args);
    });
    await expect(
      verifyMakeTestWorkspace(task, {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'changed' });
  });
});
