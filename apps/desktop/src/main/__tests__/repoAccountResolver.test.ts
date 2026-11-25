/**
 * repoAccountResolver 单测:活跃账号看不到某个私有仓库时,按仓库换本机另一个已登录账号,
 * 并记住选择。真实症状是私有仓库的 PR 被显示成「PR 不存在」。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createRepoAccountResolver,
  type RepoAccountDeps,
} from '../git-context/repoAccountResolver';

const PR = { owner: 'acme', repo: 'widgets', prNumber: 1 };
const active = async () => ({ ok: true as const, token: 'active-token' });

function deps(over: Partial<RepoAccountDeps> = {}): RepoAccountDeps {
  return {
    readToken: active,
    listLogins: async () => ({ logins: ['me', 'work'], complete: true }),
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

  it('活跃账号重新能读时,按刚失败的 token 重新探测它', async () => {
    // 最小失败输入:B 先被记住;B 被撚权后,活跃账号 A 其实已经能读这个仓库了。
    // 若仍然无条件跳过活跃账号,recover 会空手而归并把仓库记成 10 分钟读不到。
    let readable = 'b-token';
    const resolver = createRepoAccountResolver(
      deps({
        listLogins: async () => ({ logins: ['me', 'work'], complete: true }),
        readTokenForLogin: async (login) => (login === 'me' ? 'active-token' : 'b-token'),
        repoAccess: async (token) => token === readable,
      }),
    );

    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'b-token' });
    readable = 'active-token';
    expect(await resolver.recover(PR, 'b-token')).toEqual({ ok: true, token: 'active-token' });
  });

  it('列表不完整时仍探测读得到的账号', async () => {
    // 一个无关账号校验失败,不能让剩下能读的账号一起被跳过。
    const listLogins = vi.fn(async () => ({ logins: ['work'], complete: false }));
    const resolver = createRepoAccountResolver(deps({ listLogins }));

    expect(await resolver.recover(PR)).toEqual({ ok: true, token: 'work-token' });
  });

  it('列表不完整且都不行时不写失败记忆', async () => {
    const listLogins = vi.fn(async () => ({ logins: ['work'], complete: false }));
    const repoAccess = vi.fn(async () => false);
    const resolver = createRepoAccountResolver(deps({ listLogins, repoAccess }));

    expect(await resolver.recover(PR)).toBeNull();
    expect(await resolver.recover(PR)).toBeNull();
    // 没有 10 分钟 miss:两次都真的重新探测。
    expect(listLogins).toHaveBeenCalledTimes(2);
  });

  it('PR 编号写错时先复核刚被拒的凭证,不因此换账号', async () => {
    // 活跃账号能读仓库,只是这条 PR 不存在:PR 接口 404 不等于仓库没权限。
    const repoAccess = vi.fn(async (token: string) => token === 'active-token');
    const resolver = createRepoAccountResolver(deps({ repoAccess }));

    expect(await resolver.recover(PR, 'active-token')).toBeNull();
    expect(repoAccess).toHaveBeenCalledTimes(1);
    expect(repoAccess).toHaveBeenCalledWith('active-token', PR);
    expect(await resolver.tokenFor(PR)).toEqual({ ok: true, token: 'active-token' });
  });

  it('记住的账号被 404 后 recover 重新探测,不会把同一个 token 原样返回', async () => {
    // 最小失败输入:work 在 30 分钟 TTL 内失去仓库权限,而 personal 还能读。
    let readable = 'work-token';
    const resolver = createRepoAccountResolver(
      deps({
        listLogins: async () => ({ logins: ['me', 'work', 'personal'], complete: true }),
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
    let listed: { logins: string[]; complete: boolean } | null = null;
    const resolver = createRepoAccountResolver(deps({ listLogins: async () => listed }));

    expect(await resolver.recover(PR)).toBeNull();
    listed = { logins: ['me', 'work'], complete: true };
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
    const listLogins = vi.fn(async () => ({ logins: ['me', 'work'], complete: true }));
    const repoAccess = vi.fn(async () => false);
    const resolver = createRepoAccountResolver(deps({ listLogins, repoAccess }));

    expect(await resolver.recover(PR)).toBeNull();
    expect(await resolver.recover({ ...PR, prNumber: 2 })).toBeNull();
    expect(listLogins).toHaveBeenCalledTimes(1);
    expect(repoAccess).toHaveBeenCalledTimes(1);
  });

  it('账号列表没查成时不写失败记忆', async () => {
    let reachable = false;
    const listLogins = vi.fn(async () =>
      reachable ? { logins: ['me', 'work'], complete: true } : null,
    );
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
        listLogins: async () => ({ logins: ['me', 'work', 'other'], complete: true }),
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
    const listLogins = vi.fn(async () => ({ logins: ['me', 'work'], complete: true }));
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
