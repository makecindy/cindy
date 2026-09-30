import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { GithubSetup, deviceCodeFromOutput } from '../git-context/githubSetup';
import { systemGhBinary } from '../git-context/ghBinary';
import { ghArtifact } from '../git-context/ghArtifact';
import { createGhCliTokenSource } from '../git-context/ghCliTokenSource';
import { PrStatusService } from '../git-context/prStatusService';

function fixture() {
  const deps = {
    resolveBinary: vi.fn(async () => '/existing/gh'),
    available: vi.fn(async () => true),
    authenticated: vi.fn(async () => true),
    install: vi.fn(async (_signal: AbortSignal, _update: unknown) => '/managed/gh'),
    login: vi.fn(async (_binary: string, _signal: AbortSignal, _update: unknown) => {}),
    connected: vi.fn(),
  };
  return { deps, setup: new GithubSetup(deps) };
}
describe('GitHub setup', () => {
  it('reuses existing authentication and refreshes consumers without installing or logging in', async () => {
    const { setup, deps } = fixture();
    setup.start();
    await vi.waitFor(() => expect(setup.snapshot().phase).toBe('connected'));
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
    expect(deps.connected).toHaveBeenCalledOnce();
  });
  it('installs once, authorizes the selected binary and verifies before publishing success', async () => {
    const { setup, deps } = fixture();
    deps.available.mockResolvedValue(false);
    deps.authenticated.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    setup.start();
    setup.start();
    await vi.waitFor(() => expect(setup.snapshot().phase).toBe('connected'));
    expect(deps.install).toHaveBeenCalledOnce();
    expect(deps.login.mock.calls[0][0]).toBe('/managed/gh');
    expect(deps.authenticated).toHaveBeenCalledTimes(2);
  });
  it('never treats successful process exit with unusable auth as connected', async () => {
    const { setup, deps } = fixture();
    deps.authenticated.mockResolvedValue(false);
    setup.start();
    await vi.waitFor(() => expect(setup.snapshot()).toEqual({ phase: 'error', error: 'login' }));
    expect(deps.connected).not.toHaveBeenCalled();
  });
  it('sanitizes install errors and permits retry', async () => {
    const { setup, deps } = fixture();
    deps.available.mockResolvedValue(false);
    deps.install.mockRejectedValueOnce(new Error('/private/path?token=secret'));
    setup.start();
    await vi.waitFor(() => expect(setup.snapshot()).toEqual({ phase: 'error', error: 'install' }));
    setup.start();
    await vi.waitFor(() => expect(setup.snapshot().phase).toBe('connected'));
  });
  it('cancellation prevents a late installer from starting login', async () => {
    const { setup, deps } = fixture();
    deps.available.mockResolvedValue(false);
    let finish!: (binary: string) => void;
    deps.install.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    setup.start();
    await vi.waitFor(() => expect(deps.install).toHaveBeenCalledOnce());
    const cancelled = setup.cancel();
    let settled = false;
    void cancelled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    setup.start();
    finish('/managed/gh');
    await vi.waitFor(() => expect(setup.snapshot().phase).toBe('cancelled'));
    expect(deps.login).not.toHaveBeenCalled();
    expect(deps.connected).not.toHaveBeenCalled();
    await cancelled;
    deps.available.mockResolvedValue(true);
    setup.start();
    await vi.waitFor(() => expect(setup.snapshot().phase).toBe('connected'));
  });
  it('reads only a complete device code, including the clipboard configuration variant', () => {
    expect(deviceCodeFromOutput('! First copy your one-time code: ABCD-123')).toBeUndefined();
    expect(deviceCodeFromOutput('! First copy your one-time code: ABCD-1234\n')).toBe('ABCD-1234');
    expect(deviceCodeFromOutput('! One-time code (ABCD-1234) copied to clipboard')).toBe(
      'ABCD-1234',
    );
    expect(deviceCodeFromOutput('secret gho_test')).toBeUndefined();
  });
  it.each(['darwin', 'linux', 'win32'])(
    'finds home-local gh on %s even when the GUI PATH is stale',
    (platform) => {
      const home = path.resolve('test-home');
      const expected = path.join(home, '.local', 'bin', platform === 'win32' ? 'gh.exe' : 'gh');
      expect(systemGhBinary(platform, (p) => p === expected, home)).toBe(expected);
    },
  );
  it('supports pinned macOS, Windows and Linux archives, rejects unknown hosts', () => {
    for (const os of ['darwin', 'win32', 'linux'])
      for (const arch of ['arm64', 'x64']) {
        expect(ghArtifact(os, arch)?.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    expect(ghArtifact('linux', 'ia32')).toBeUndefined();
  });
  it('invalidates negative token reads without letting an old flight re-poison the cache', async () => {
    const callbacks: Array<(err: Error | null, stdout: string, stderr: string) => void> = [];
    const source = createGhCliTokenSource({
      existsFn: () => false,
      execFileFn: (_f, _a, _o, cb) => {
        callbacks.push(cb);
      },
    });
    const old = source.readToken();
    source.invalidate();
    const fresh = source.readToken();
    callbacks[1](null, 'new', '');
    expect(await fresh).toBe('new');
    callbacks[0](new Error('not logged in'), '', '');
    await old;
    expect(await source.readToken()).toBe('new');
    expect(callbacks).toHaveLength(2);
  });
  it('does not let a PR response started before login populate the new cache', async () => {
    const query = { owner: 'owner', repo: 'repo', prNumber: 1 };
    let finish!: (value: {
      state: 'closed';
      title: string;
      html_url: string;
      branch: string;
    }) => void;
    const fetchPr = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ state: 'open', title: 'fresh', html_url: '', branch: '' });
    const service = new PrStatusService({
      readToken: async () => ({ ok: true, token: 'test' }),
      fetchPr,
    });
    const old = service.getStatuses([query]);
    await vi.waitFor(() => expect(fetchPr).toHaveBeenCalledOnce());
    service.invalidate();
    expect(await service.getStatuses([query])).toMatchObject([{ title: 'fresh' }]);
    finish({ state: 'closed', title: 'old', html_url: '', branch: '' });
    await old;
    expect(await service.getStatuses([query])).toMatchObject([{ title: 'fresh' }]);
  });
});
