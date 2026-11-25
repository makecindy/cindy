/**
 * repoAccountResolver 单测:活跃账号看不到某个私有仓库时,按仓库换本机另一个已登录账号,
 * 并记住选择。真实症状是私有仓库的 PR 被显示成「PR 不存在」。
 */
import { describe, expect, it, vi } from 'vitest';

import { createRepoAccountResolver, type RepoAccountDeps } from '../git-context/repoAccountResolver';

const PR = { owner: 'acme', repo: 'widgets', prNumber: 1 };
const active = async () => ({ ok: true as const, token: 'active-token' });

function deps(over: Partial<RepoAccountDeps> = {}): RepoAccountDeps {
  return {
    readToken: active,
    listLogins: async () => ['me', 'work'],
    readTokenForLogin: async (login) => (login === 'me' ? 'active-token' : 'work-token'),
    repoAccess: async (token) => token === 'work-token',
    ...over,
  };
}

describe('repoAccountResolver', () => {
  it('换到能看到它的账号后按仓库记住,下一次读取不再问活跃账号', async () => {
    const readToken = vi.fn(active);
    const repoAccess = vi.fn(async (token: string) => token === 'work-token');
    const resolver = createRepoAccountResolver(deps({ readToken, repoAccess }));

    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'work-token' });
    // 活跃账号刚刚才 404,不必再探测它一次。
    expect(repoAccess).toHaveBeenCalledTimes(1);

    readToken.mockClear();
    expect(await resolver.tokenFor(PR)).toEqual({ ok: true, token: 'work-token' });
    expect(readToken).not.toHaveBeenCalled();
    // 同仓库的另一条 PR 共用这个选择。
    expect(await resolver.tokenFor({ ...PR, prNumber: 2 })).toEqual({
      ok: true,
      token: 'work-token',
    });
    expect(repoAccess).toHaveBeenCalledTimes(1);
  });

  it('记住的账号被 404 后 recover 重新探测,不会把同一个 token 原样返回', async () => {
    // 最小失败输入:work 在 30 分钟 TTL 内失去仓库权限,而 personal 还能读。
    let readable = 'work-token';
    const resolver = createRepoAccountResolver(
      deps({
        listLogins: async () => ['me', 'work', 'personal'],
        readTokenForLogin: async (login) =>
          ({ me: 'active-token', work: 'work-token', personal: 'personal-token' })[login] ?? null,
        repoAccess: async (token) => token === readable,
      }),
    );

    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'work-token' });
    readable = 'personal-token';
    // 调用方拿到 work 的 token 后被 404,于是再次 recover。
    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'personal-token' });
  });

  it('账号列表没探测成时不写失败记忆', async () => {
    let logins: string[] | null = null;
    const resolver = createRepoAccountResolver(deps({ listLogins: async () => logins }));

    expect(await resolver.recover(PR)).toBeNull();
    logins = ['me', 'work'];
    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'work-token' });
  });

  it('记住的账号登出后回到活跃账号', async () => {
    let signedIn = true;
    const resolver = createRepoAccountResolver(
      deps({
        readTokenForLogin: async (login) =>
          login === 'me' ? 'active-token' : signedIn ? 'work-token' : null,
      }),
    );

    await resolver.recover(PR);
    signedIn = false;
    expect(await resolver.tokenFor(PR)).toEqual({ ok: true, token: 'active-token' });
  });

  it('确认没有账号能读时记住这次结论,不反复探测', async () => {
    const listLogins = vi.fn(async () => ['me', 'work']);
    const repoAccess = vi.fn(async () => false);
    const resolver = createRepoAccountResolver(deps({ listLogins, repoAccess }));

    expect(await resolver.recover(PR)).toBeNull();
    expect(await resolver.recover({ ...PR, prNumber: 2 })).toBeNull();
    expect(listLogins).toHaveBeenCalledTimes(1);
    expect(repoAccess).toHaveBeenCalledTimes(1);
  });

  it('账号列表没查成时不写失败记忆', async () => {
    let reachable = false;
    const listLogins = vi.fn(async () => (reachable ? ['me', 'work'] : null));
    const resolver = createRepoAccountResolver(deps({ listLogins }));

    expect(await resolver.recover(PR)).toBeNull();
    reachable = true;
    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'work-token' });
    expect(listLogins).toHaveBeenCalledTimes(2);
  });

  it('记住的账号被拒后重新探测其它账号', async () => {
    const access = new Map([
      ['work-token', true],
      ['other-token', false],
    ]);
    const resolver = createRepoAccountResolver(
      deps({
        listLogins: async () => ['me', 'work', 'other'],
        readTokenForLogin: async (login) =>
          login === 'me' ? 'active-token' : login === 'work' ? 'work-token' : 'other-token',
        repoAccess: async (token) => access.get(token) ?? false,
      }),
    );

    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'work-token' });
    // 记住的账号失去了仓库权限:它自己被拒之后不再沿用。
    access.set('work-token', false);
    access.set('other-token', true);
    expect(await resolver.recover(PR, 'work-token')).toEqual({ ok: true, token: 'other-token' });
    expect(await resolver.tokenFor(PR)).toEqual({ ok: true, token: 'other-token' });
  });

  it('没查成不写失败记忆,下一次刷新重新探测', async () => {
    let reachable = false;
    const listLogins = vi.fn(async () => ['me', 'work']);
    const resolver = createRepoAccountResolver(
      deps({ listLogins, repoAccess: async () => (reachable ? true : 'unknown') }),
    );

    expect(await resolver.recover(PR)).toBeNull();
    reachable = true;
    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'work-token' });
    expect(listLogins).toHaveBeenCalledTimes(2);
  });

  it('登录态变化后丢弃在途探测结果', async () => {
    const gate: { release: ((value: boolean | 'unknown') => void) | null } = { release: null };
    const readToken = vi.fn(active);
    const resolver = createRepoAccountResolver(
      deps({
        readToken,
        repoAccess: () =>
          new Promise<boolean | 'unknown'>((resolve) => {
            gate.release = resolve;
          }),
      }),
    );

    const recovering = resolver.recover(PR);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf('function'));
    resolver.reset();
    gate.release?.(true);
    expect(await recovering).toBeNull();

    readToken.mockClear();
    expect(await resolver.tokenFor(PR)).toEqual({ ok: true, token: 'active-token' });
    expect(readToken).toHaveBeenCalledTimes(1);
  });
});
