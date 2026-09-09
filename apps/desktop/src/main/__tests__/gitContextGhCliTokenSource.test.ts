/**
 * git-context/ghCliTokenSource 单测 — gh 二进制探测、token 读取、
 * 正/负缓存与 in-flight 去重。execFile / exists 全 mock,零子进程。
 */

import { describe, it, expect, vi } from 'vitest';

import { createGhCliTokenSource } from '../git-context/ghCliTokenSource';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function execMock(impl: (file: string, cb: ExecCb) => void) {
  return vi.fn((file: string, _args: string[], _opts: { timeout: number }, cb: ExecCb) =>
    impl(file, cb),
  );
}

describe('createGhCliTokenSource', () => {
  it('优先用存在的绝对路径候选,读到 token 并 trim', async () => {
    const execFileFn = execMock((_file, cb) => cb(null, 'gho_abc123\n', ''));
    const src = createGhCliTokenSource({
      execFileFn,
      existsFn: (p) => p === '/opt/homebrew/bin/gh',
      platform: 'darwin',
    });
    expect(await src.readToken()).toBe('gho_abc123');
    expect(execFileFn.mock.calls[0][0]).toBe('/opt/homebrew/bin/gh');
  });

  it('候选都不存在时退回裸 gh(win32 用 gh.exe)', async () => {
    const execFileFn = execMock((_file, cb) => cb(null, 't', ''));
    const src = createGhCliTokenSource({
      execFileFn,
      existsFn: () => false,
      platform: 'win32',
    });
    await src.readToken();
    expect(execFileFn.mock.calls[0][0]).toBe('gh.exe');
  });

  it('未安装 / 未登录(err)与空输出都返回 null', async () => {
    const errSrc = createGhCliTokenSource({
      execFileFn: execMock((_f, cb) => cb(new Error('ENOENT'), '', '')),
      existsFn: () => false,
    });
    expect(await errSrc.readToken()).toBeNull();

    const emptySrc = createGhCliTokenSource({
      execFileFn: execMock((_f, cb) => cb(null, '\n', '')),
      existsFn: () => false,
    });
    expect(await emptySrc.readToken()).toBeNull();
  });

  it('正/负结果都缓存,TTL 过期后重新探测', async () => {
    let now = 0;
    let result: string | null = null;
    const execFileFn = execMock((_f, cb) =>
      result ? cb(null, result, '') : cb(new Error('not logged in'), '', ''),
    );
    const src = createGhCliTokenSource({
      execFileFn,
      existsFn: () => false,
      cacheTtlMs: 100,
      negativeCacheTtlMs: 100,
      now: () => now,
    });
    // 负缓存:两次调用只 spawn 一次
    expect(await src.readToken()).toBeNull();
    expect(await src.readToken()).toBeNull();
    expect(execFileFn).toHaveBeenCalledTimes(1);
    // TTL 过期 + 用户已登录 → 重新探测拿到 token
    now = 200;
    result = 'gho_new';
    expect(await src.readToken()).toBe('gho_new');
    expect(execFileFn).toHaveBeenCalledTimes(2);
  });

  it('负缓存比正缓存短:gh auth login 后无需等满正缓存 TTL', async () => {
    let now = 0;
    let result: string | null = null;
    const execFileFn = execMock((_f, cb) =>
      result ? cb(null, result, '') : cb(new Error('not logged in'), '', ''),
    );
    const src = createGhCliTokenSource({
      execFileFn,
      existsFn: () => false,
      cacheTtlMs: 10_000,
      negativeCacheTtlMs: 100,
      now: () => now,
    });
    expect(await src.readToken()).toBeNull();
    // 负缓存 100ms 过期后(远早于正缓存 10s),登录态立即被发现
    now = 150;
    result = 'gho_fresh';
    expect(await src.readToken()).toBe('gho_fresh');
    // 正缓存生效:之后的调用不再 spawn
    now = 200;
    expect(await src.readToken()).toBe('gho_fresh');
    expect(execFileFn).toHaveBeenCalledTimes(2);
  });

  it('并发调用共享同一次 in-flight 探测', async () => {
    let resolveCb!: ExecCb;
    const execFileFn = execMock((_f, cb) => {
      resolveCb = cb;
    });
    const src = createGhCliTokenSource({ execFileFn, existsFn: () => false });
    const p1 = src.readToken();
    const p2 = src.readToken();
    resolveCb(null, 'gho_x', '');
    expect(await Promise.all([p1, p2])).toEqual(['gho_x', 'gho_x']);
    expect(execFileFn).toHaveBeenCalledTimes(1);
  });

  it('可用性探测只执行 gh auth status，不读取或污染 token cache', async () => {
    const execFileFn = vi.fn(
      (
        _file: string,
        args: string[],
        opts: { timeout: number },
        cb: ExecCb,
      ) => {
        if (args[1] === 'status') {
          expect(opts.timeout).toBeLessThanOrEqual(1_000);
          cb(null, 'logged in as octocat', '');
        } else {
          expect(opts.timeout).toBe(3_000);
          cb(null, 'gho_after_probe', '');
        }
      },
    );
    const src = createGhCliTokenSource({ execFileFn, existsFn: () => false });
    const expectedGhExecutable = process.platform === 'win32' ? 'gh.exe' : 'gh';

    expect(await src.probeAvailability()).toBe(true);
    expect(execFileFn).toHaveBeenCalledWith(
      expectedGhExecutable,
      ['auth', 'status', '--hostname', 'github.com'],
      { timeout: expect.any(Number) },
      expect.any(Function),
    );
    expect(await src.readToken()).toBe('gho_after_probe');
    expect(execFileFn).toHaveBeenCalledTimes(2);
  });

  it('可用性探测失败只返回 false，不把 stderr/输出写进日志', async () => {
    const execFileFn = execMock((_file, cb) => cb(new Error('not logged in'), 'secret-like-output', ''));
    const src = createGhCliTokenSource({ execFileFn, existsFn: () => false });
    expect(await src.probeAvailability()).toBe(false);
    expect(execFileFn).toHaveBeenCalledTimes(1);
  });

  describe('readTokenDetailed 保留失败原因', () => {
    function errWith(extra: Record<string, unknown>): Error {
      return Object.assign(new Error('gh failed'), extra);
    }

    it('ENOENT → gh-missing;spawn 抛错也归为 gh-missing', async () => {
      const enoent = createGhCliTokenSource({
        execFileFn: execMock((_f, cb) => cb(errWith({ code: 'ENOENT' }), '', '')),
        existsFn: () => false,
      });
      expect(await enoent.readTokenDetailed()).toEqual({ ok: false, reason: 'gh-missing' });

      const thrown = createGhCliTokenSource({
        execFileFn: vi.fn(() => {
          throw new Error('spawn EACCES');
        }),
        existsFn: () => false,
      });
      expect(await thrown.readTokenDetailed()).toEqual({ ok: false, reason: 'gh-missing' });
    });

    it('非零退出(exit 1)与空输出 → gh-not-logged-in', async () => {
      const exit1 = createGhCliTokenSource({
        execFileFn: execMock((_f, cb) => cb(errWith({ code: 1 }), '', 'not logged in')),
        existsFn: () => false,
      });
      expect(await exit1.readTokenDetailed()).toEqual({ ok: false, reason: 'gh-not-logged-in' });

      const empty = createGhCliTokenSource({
        execFileFn: execMock((_f, cb) => cb(null, '\n', '')),
        existsFn: () => false,
      });
      expect(await empty.readTokenDetailed()).toEqual({ ok: false, reason: 'gh-not-logged-in' });
    });

    it('子进程超时(killed + signal)→ gh-timeout', async () => {
      const src = createGhCliTokenSource({
        execFileFn: execMock((_f, cb) => cb(errWith({ killed: true, signal: 'SIGTERM' }), '', '')),
        existsFn: () => false,
      });
      expect(await src.readTokenDetailed()).toEqual({ ok: false, reason: 'gh-timeout' });
    });

    it('EACCES / ENOEXEC 等 spawn 字符串错误 → gh-exec-failed,不当成未登录', async () => {
      for (const code of ['EACCES', 'ENOEXEC'] as const) {
        const src = createGhCliTokenSource({
          execFileFn: execMock((_f, cb) => cb(errWith({ code }), '', '')),
          existsFn: () => false,
        });
        expect(await src.readTokenDetailed()).toEqual({ ok: false, reason: 'gh-exec-failed' });
      }
    });

    it('与 readToken 共享同一份缓存与 in-flight:两种读法交替调用只 spawn 一次', async () => {
      const execFileFn = execMock((_f, cb) => cb(errWith({ code: 1 }), '', ''));
      const src = createGhCliTokenSource({ execFileFn, existsFn: () => false });
      const [detailed, plain] = await Promise.all([src.readTokenDetailed(), src.readToken()]);
      expect(detailed).toEqual({ ok: false, reason: 'gh-not-logged-in' });
      expect(plain).toBeNull();
      expect(await src.readTokenDetailed()).toEqual({ ok: false, reason: 'gh-not-logged-in' });
      expect(execFileFn).toHaveBeenCalledTimes(1);
    });
  });
});
