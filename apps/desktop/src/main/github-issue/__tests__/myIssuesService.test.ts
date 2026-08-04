/**
 * myIssuesService 单测 —— 三路输入合并、来源标记、平台通道降级、可选增强的独立性、缓存。
 *
 * 最重要的一条口径:**没有 GitHub 身份是正常状态**,列表必须照常出来,
 * degraded 只由平台通道决定。依赖全注入,不碰网络 / electron。
 */

import { describe, expect, it, vi } from 'vitest';

import type { SubmittedIssueRecord } from '../../../shared/myIssues';
import {
  MyIssuesService,
  isStaleAccountScopeError,
  issueTypeFromLabels,
  mergeIssues,
  type GithubEnhancementViewer,
  type MyIssuesServiceDeps,
  type RemoteIssue,
} from '../myIssuesService';

const GHOST_VIEWER: GithubEnhancementViewer = { source: 'ghost', login: 'octocat' };

function ledgerRecord(over: Partial<SubmittedIssueRecord> = {}): SubmittedIssueRecord {
  return {
    number: 1001,
    url: 'https://github.com/makecindy/cindy/issues/1001',
    title: '账本里记的标题',
    type: 'bug',
    submittedAt: '2026-07-01T00:00:00.000Z',
    identity: 'platform',
    publicName: 'shuji',
    ...over,
  };
}

function remoteIssue(over: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    number: 2002,
    title: 'GitHub 上的标题',
    htmlUrl: 'https://github.com/makecindy/cindy/issues/2002',
    state: 'open',
    labels: ['feature'],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    commentCount: 3,
    ...over,
  };
}

function makeDeps(over: Partial<MyIssuesServiceDeps> = {}): MyIssuesServiceDeps {
  return {
    readLedger: () => [],
    fetchPlatformIssues: async () => ({
      ok: true,
      page: { issues: [], totalCount: 0 },
    }),
    resolveGithubEnhancement: async () => null,
    searchAuthoredIssues: async () => ({ issues: [], totalCount: 0 }),
    readScope: () => 'owner-a:1',
    ...over,
  };
}

describe('mergeIssues', () => {
  it('账本 only 的条目状态标 unknown,标题用账本记的那一版', () => {
    const [item] = mergeIssues([ledgerRecord()], []);
    expect(item).toMatchObject({
      number: 1001,
      title: '账本里记的标题',
      state: 'unknown',
      updatedAt: null,
      commentCount: null,
      sources: ['cindy-tool'],
    });
  });

  it('平台通道返回的条目只打 cindy-tool —— 平台代发的 GitHub 作者不是本人', () => {
    const [item] = mergeIssues(
      [],
      [],
      [remoteIssue({ number: 9, state: 'closed', title: '远端标题' })],
    );
    expect(item).toMatchObject({ state: 'closed', title: '远端标题', sources: ['cindy-tool'] });
  });

  it('账本 + 平台同号时远端字段覆盖账本,标签被清掉时类型回退账本', () => {
    const [item] = mergeIssues(
      [ledgerRecord({ number: 5, title: '提交时的旧标题', type: 'bug' })],
      [],
      [remoteIssue({ number: 5, title: '被维护者改过的标题', state: 'closed', labels: [] })],
    );
    expect(item).toMatchObject({
      title: '被维护者改过的标题',
      state: 'closed',
      type: 'bug',
      sources: ['cindy-tool'],
    });
  });

  it('author 搜到的打 github-account;同时命中两路时两个来源都标上且顺序稳定', () => {
    const [onlyAuthored] = mergeIssues([], [remoteIssue({ number: 7 })]);
    expect(onlyAuthored.sources).toEqual(['github-account']);

    const [both] = mergeIssues(
      [ledgerRecord({ number: 7 })],
      [remoteIssue({ number: 7 })],
      [remoteIssue({ number: 7 })],
    );
    expect(both.sources).toEqual(['cindy-tool', 'github-account']);
  });

  it('账本 identity=github-user 时保留 github-account —— 增强不可用也不丢已确认的来源', () => {
    // 用自己 GitHub 身份提交的那条,两个来源都成立。硬编码 ['cindy-tool'] 会让同一条
    // issue 的来源标记随插件状态漂移:插件开着显示两个,停用 / 超时 / 离线只显示一个。
    const [asUser] = mergeIssues([ledgerRecord({ identity: 'github-user' })], []);
    expect(asUser.sources).toEqual(['cindy-tool', 'github-account']);

    // 平台代发的作者是 cindy-issue App、不是本人 —— 这一路仍然只打 cindy-tool。
    const [asPlatform] = mergeIssues([ledgerRecord({ identity: 'platform' })], []);
    expect(asPlatform.sources).toEqual(['cindy-tool']);
  });

  it('链接一律由 issue 号派生,不采纳任何来源给的原值', () => {
    // 两个产出点都要钉住:远端 overlay 与账本兜底。整行点击直接走 openExternal,
    // 任一处采纳外部 url,被篡改的账本或被伪造的响应就能把用户带去别的站点。
    const [fromRemote] = mergeIssues(
      [],
      [remoteIssue({ number: 42, htmlUrl: 'https://evil.example.com/phish' })],
    );
    expect(fromRemote.url).toBe('https://github.com/makecindy/cindy/issues/42');

    const [fromLedger] = mergeIssues(
      [ledgerRecord({ number: 43, url: 'https://evil.example.com/phish' })],
      [],
    );
    expect(fromLedger.url).toBe('https://github.com/makecindy/cindy/issues/43');

    const [fromPlatform] = mergeIssues(
      [],
      [],
      [remoteIssue({ number: 44, htmlUrl: 'https://evil.example.com/phish' })],
    );
    expect(fromPlatform.url).toBe('https://github.com/makecindy/cindy/issues/44');
  });

  it('按创建时间倒序;同一时间戳按 issue 号兜底,顺序稳定', () => {
    const items = mergeIssues(
      [],
      [
        remoteIssue({ number: 1, createdAt: '2026-07-01T00:00:00.000Z' }),
        remoteIssue({ number: 3, createdAt: '2026-07-20T00:00:00.000Z' }),
        remoteIssue({ number: 2, createdAt: '2026-07-20T00:00:00.000Z' }),
      ],
    );
    expect(items.map((i) => i.number)).toEqual([3, 2, 1]);
  });
});

describe('issueTypeFromLabels', () => {
  it('识别 bug / feature,大小写不敏感;都没有时为 null', () => {
    expect(issueTypeFromLabels(['Bug'])).toBe('bug');
    expect(issueTypeFromLabels(['feature'])).toBe('feature');
    expect(issueTypeFromLabels(['needs-triage'])).toBeNull();
    expect(issueTypeFromLabels([])).toBeNull();
  });
});

describe('MyIssuesService.list', () => {
  it('平台通道就绪时给出实时状态,不需要任何 GitHub 身份', async () => {
    const searchAuthoredIssues = vi.fn();
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => [ledgerRecord({ number: 1001 })],
        fetchPlatformIssues: async () => ({
          ok: true,
          page: {
            issues: [remoteIssue({ number: 1001, state: 'closed', title: '远端标题' })],
            totalCount: 1,
          },
        }),
        resolveGithubEnhancement: async () => null,
        searchAuthoredIssues,
      }),
    );
    const result = await service.list();
    expect(result).toMatchObject({
      githubEnhancement: null,
      degraded: null,
      truncated: false,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ state: 'closed', title: '远端标题' });
    // 没有 GitHub 身份时不该去搜 GitHub。
    expect(searchAuthoredIssues).not.toHaveBeenCalled();
  });

  it('平台读接口未就绪时降级 platform-unavailable,账本记录照常渲染', async () => {
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => [ledgerRecord()],
        fetchPlatformIssues: async () => ({ ok: false, reason: 'platform-unavailable' }),
      }),
    );
    const result = await service.list();
    expect(result.degraded).toBe('platform-unavailable');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.state).toBe('unknown');
  });

  it('未登录 / 取数失败各自映射到对应 degraded', async () => {
    for (const reason of ['not-signed-in', 'fetch-failed'] as const) {
      const service = new MyIssuesService(
        makeDeps({
          readLedger: () => [ledgerRecord()],
          fetchPlatformIssues: async () => ({ ok: false, reason }),
        }),
      );
      await expect(service.list()).resolves.toMatchObject({ degraded: reason });
    }
  });

  it('账本读取抛错时不拖累另两路 —— 主来源好着就必须照常出数据', async () => {
    // electron-store 初始化会同步抛(目录不可读 / 权限 / 磁盘错误)。放在 Promise.all
    // 之前裸调用,一次抛出就让平台请求与增强都不再启动,整页只剩 unexpected ——
    // 而平台通道才是主来源,账本只是它未就绪时的兜底,依赖方向不能反。
    const fetchPlatformIssues = vi.fn(async () => ({
      ok: true as const,
      page: { issues: [remoteIssue({ number: 77 })], totalCount: 1 },
    }));
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => {
          throw new Error('ENOENT: no such file or directory');
        },
        fetchPlatformIssues,
      }),
    );

    const result = await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(1);
    expect(result.items.map((i) => i.number)).toEqual([77]);
    // 账本读不到不是平台通道的状态,不占用那三个 reason。
    expect(result.degraded).toBeNull();
  });

  it('平台通道意外抛错时归到 fetch-failed,不把整页打挂', async () => {
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => [ledgerRecord()],
        fetchPlatformIssues: async () => {
          throw new Error('boom');
        },
      }),
    );
    const result = await service.list();
    expect(result.degraded).toBe('fetch-failed');
    expect(result.items).toHaveLength(1);
  });

  it('deps 同步抛出时也走 deadline 的清理路径,不留下悬挂计时器', async () => {
    // 裸 run() 的写法下,同步 throw 会越过 clearTimeout,留一个跑到 12s 才触发的
    // 计时器。用假计时器断言:结果落地后已无待触发的计时器。
    vi.useFakeTimers();
    try {
      const service = new MyIssuesService(
        makeDeps({
          readLedger: () => [ledgerRecord()],
          // 注意是**同步** throw,不是 rejected promise。
          fetchPlatformIssues: (() => {
            throw new Error('sync boom');
          }) as MyIssuesServiceDeps['fetchPlatformIssues'],
        }),
      );
      const result = await service.list();
      expect(result.degraded).toBe('fetch-failed');
      expect(result.items).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('可选增强把用户自己 GitHub 名下的 issue 并进来,并回传身份', async () => {
    const service = new MyIssuesService(
      makeDeps({
        fetchPlatformIssues: async () => ({
          ok: true,
          page: { issues: [remoteIssue({ number: 1 })], totalCount: 1 },
        }),
        resolveGithubEnhancement: async () => GHOST_VIEWER,
        searchAuthoredIssues: async () => ({
          issues: [remoteIssue({ number: 2, createdAt: '2026-07-20T00:00:00.000Z' })],
          totalCount: 1,
        }),
      }),
    );
    const result = await service.list();
    expect(result.githubEnhancement).toEqual({ login: 'octocat', source: 'ghost' });
    expect(result.items.map((i) => i.number)).toEqual([2, 1]);
    expect(result.items.find((i) => i.number === 2)!.sources).toEqual(['github-account']);
  });

  it('增强身份解析或搜索失败都不算列表降级', async () => {
    const throwingResolve = new MyIssuesService(
      makeDeps({
        resolveGithubEnhancement: async () => {
          throw new Error('ghost pipe exploded');
        },
      }),
    );
    await expect(throwingResolve.list()).resolves.toMatchObject({
      degraded: null,
      githubEnhancement: null,
    });

    const throwingSearch = new MyIssuesService(
      makeDeps({
        resolveGithubEnhancement: async () => GHOST_VIEWER,
        searchAuthoredIssues: async () => {
          throw new Error('HTTP 403');
        },
      }),
    );
    const result = await throwingSearch.list();
    expect(result.degraded).toBeNull();
    // 身份查到了就如实回传,只是这一次没并进内容。
    expect(result.githubEnhancement).toEqual({ login: 'octocat', source: 'ghost' });
    expect(result.items).toEqual([]);
  });

  it('任一路远端总数多于返回条数时标 truncated', async () => {
    const platformTruncated = new MyIssuesService(
      makeDeps({
        fetchPlatformIssues: async () => ({
          ok: true,
          page: { issues: [remoteIssue()], totalCount: 240 },
        }),
      }),
    );
    await expect(platformTruncated.list()).resolves.toMatchObject({ truncated: true });

    const enhancementTruncated = new MyIssuesService(
      makeDeps({
        resolveGithubEnhancement: async () => GHOST_VIEWER,
        searchAuthoredIssues: async () => ({ issues: [remoteIssue()], totalCount: 240 }),
      }),
    );
    await expect(enhancementTruncated.list()).resolves.toMatchObject({ truncated: true });
  });

  it('TTL 内复用缓存;force 绕过 TTL;invalidate 后重新拉', async () => {
    let clock = 0;
    const fetchPlatformIssues = vi.fn(async () => ({
      ok: true as const,
      page: { issues: [remoteIssue()], totalCount: 1 },
    }));
    const service = new MyIssuesService(
      makeDeps({ fetchPlatformIssues, cacheTtlMs: 1000, now: () => clock }),
    );

    await service.list();
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(1);

    await service.list({ force: true });
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(2);

    service.invalidate();
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(3);

    clock += 2000;
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(4);
  });

  it('并发调用只打一次远端(in-flight 去重)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchPlatformIssues = vi.fn(async () => {
      await gate;
      return { ok: true as const, page: { issues: [remoteIssue()], totalCount: 1 } };
    });
    const service = new MyIssuesService(makeDeps({ fetchPlatformIssues }));
    const both = Promise.all([service.list(), service.list()]);
    release!();
    const [first, second] = await both;
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

/**
 * 账号边界 —— 服务是进程级单例,而 issue 列表(标题/编号/GitHub 用户名)是账号私有
 * 数据。这一组用例是安全回归:任一条挂掉都意味着切号后可能看到别人的 issue。
 */
describe('MyIssuesService 的账号作用域隔离', () => {
  it('切账号后不复用上一个账号的缓存', async () => {
    let scope = 'owner-a:1';
    const fetchPlatformIssues = vi.fn(async () => ({
      ok: true as const,
      page: {
        issues: [remoteIssue({ number: scope === 'owner-a:1' ? 111 : 222 })],
        totalCount: 1,
      },
    }));
    const service = new MyIssuesService(makeDeps({ fetchPlatformIssues, readScope: () => scope }));

    expect((await service.list()).items.map((i) => i.number)).toEqual([111]);

    // TTL 远未到期,但账号换了 —— 必须重新取,绝不能回放账号 A 的结果。
    scope = 'owner-b:2';
    expect((await service.list()).items.map((i) => i.number)).toEqual([222]);
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(2);

    // 切回账号 A 也不该命中账号 B 留下的那条缓存。
    scope = 'owner-a:3';
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(3);
  });

  it('切账号后不复用上一个账号的在途请求', async () => {
    let scope = 'owner-a:1';
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchPlatformIssues = vi.fn(async () => {
      await gate;
      return { ok: true as const, page: { issues: [remoteIssue()], totalCount: 1 } };
    });
    const service = new MyIssuesService(makeDeps({ fetchPlatformIssues, readScope: () => scope }));

    const first = service.list();
    scope = 'owner-b:2';
    const second = service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(2);
    release!();
    // 账号 A 发起的那次落地时已不是当前账号 → 拒绝交付;
    // 账号 B 自己那次照常拿到结果。
    await expect(first).rejects.toSatisfy(isStaleAccountScopeError);
    await expect(second).resolves.toMatchObject({ degraded: null });
  });

  it('请求期间切了账号 → 缓存未被投毒,新账号下次必须重新取', async () => {
    let scope = 'owner-a:1';
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchPlatformIssues = vi.fn(async () => {
      await gate;
      return { ok: true as const, page: { issues: [remoteIssue()], totalCount: 1 } };
    });
    const service = new MyIssuesService(makeDeps({ fetchPlatformIssues, readScope: () => scope }));

    const pending = service.list();
    scope = 'owner-b:2'; // 结果回来时已经不是发起时那个账号了
    release!();
    await expect(pending).rejects.toSatisfy(isStaleAccountScopeError);

    // 关键:新账号读不到任何缓存,必须重新打远端(此前那份结果没被写进去)。
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(2);
  });

  it('结果落地时账号已切换 → 拒绝交付,不把旧账号数据交给调用方', async () => {
    // 这一条专门区分「只堵缓存」与「也堵返回值」两种修法:前者会让这里拿到 resolved
    // 的旧账号结果,测试必挂。
    let scope = 'owner-a:1';
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new MyIssuesService(
      makeDeps({
        readScope: () => scope,
        fetchPlatformIssues: async () => {
          await gate;
          return {
            ok: true as const,
            page: { issues: [remoteIssue({ title: '账号 A 的私有标题' })], totalCount: 1 },
          };
        },
      }),
    );

    const pending = service.list();
    scope = 'owner-b:2';
    release!();
    await expect(pending).rejects.toSatisfy(isStaleAccountScopeError);
  });

  it('invalidate 让在飞的旧快照不可落缓存(提交成功后下次一定看到新记录)', async () => {
    let ledger: SubmittedIssueRecord[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    const service = new MyIssuesService(
      makeDeps({
        readLedger: () => ledger,
        fetchPlatformIssues: async () => {
          if (gated) await gate;
          return { ok: false as const, reason: 'platform-unavailable' as const };
        },
      }),
    );

    // 请求先读到空账本,期间另一个窗口提交成功 → invalidate()。
    const pending = service.list();
    ledger = [ledgerRecord({ number: 777 })];
    service.invalidate();
    release!();
    gated = false;
    await pending;

    // 那份旧快照不得落缓存,否则接下来 60s 都看不到 #777。
    const next = await service.list();
    expect(next.items.map((i) => i.number)).toEqual([777]);
  });

  it('可选增强卡住时不拖累主列表:超时后当作没有增强,平台结果照常返回', async () => {
    // 插件通道默认超时 330s,而增强与平台通道是并行 await 的 —— 没有短超时的话
    // 这里会一直挂着,页面被加载态遮住。
    const service = new MyIssuesService(
      makeDeps({
        enhancementTimeoutMs: 5,
        fetchPlatformIssues: async () => ({
          ok: true as const,
          page: { issues: [remoteIssue({ number: 42 })], totalCount: 1 },
        }),
        resolveGithubEnhancement: async () => GHOST_VIEWER,
        // 永不 resolve,模拟插件卡死
        searchAuthoredIssues: () => new Promise(() => {}),
      }),
    );
    const result = await service.list();
    expect(result.items.map((i) => i.number)).toEqual([42]);
    expect(result.degraded).toBeNull();
    // 身份解析成功过,所以身份照常回传,只是这次没并进内容。
    expect(result.githubEnhancement).toEqual({ login: 'octocat', source: 'ghost' });
  });

  it('增强的总时长有单一 deadline:两段各自不超时但累计超预算时也会被切断', async () => {
    // 专门区分「分阶段各起一次计时器」与「整条路径一次 deadline」:前者会让第二段
    // 重置 deadline,两段各 40ms 在 50ms 预算下都不超时,于是总共等 80ms 才返回。
    const started = Date.now();
    const slow = <T>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 40));
    const service = new MyIssuesService(
      makeDeps({
        enhancementTimeoutMs: 50,
        fetchPlatformIssues: async () => ({
          ok: true as const,
          page: { issues: [remoteIssue({ number: 9 })], totalCount: 1 },
        }),
        resolveGithubEnhancement: () => slow(GHOST_VIEWER),
        searchAuthoredIssues: () => slow({ issues: [remoteIssue({ number: 8 })], totalCount: 1 }),
      }),
    );
    const result = await service.list();
    const elapsed = Date.now() - started;

    // 总 deadline 生效:在 50ms 附近被切断,不会跑到两段之和(80ms+)。
    expect(elapsed).toBeLessThan(75);
    // 被切断时身份已解析成功 → 照常回传,只是这次没并进内容。
    expect(result.githubEnhancement).toEqual({ login: 'octocat', source: 'ghost' });
    expect(result.items.map((i) => i.number)).toEqual([9]);
    expect(result.degraded).toBeNull();
  });

  it('平台通道卡住时有总 deadline,账本记录照常渲染', async () => {
    // 覆盖 401 → authManager.refresh() 挂死这条链:runtime 侧给 serverApiFetch 的
    // timeoutMs 只管单次 fetch,refresh 自己无上限,所以 service 层必须有总 deadline。
    const service = new MyIssuesService(
      makeDeps({
        platformTimeoutMs: 5,
        readLedger: () => [ledgerRecord({ number: 314 })],
        fetchPlatformIssues: () => new Promise(() => {}),
      }),
    );
    const result = await service.list();
    expect(result.degraded).toBe('fetch-failed');
    expect(result.items.map((i) => i.number)).toEqual([314]);
    expect(result.items[0]!.state).toBe('unknown');
  });

  it('身份解析本身卡住时同样超时,不阻塞主列表', async () => {
    const service = new MyIssuesService(
      makeDeps({
        enhancementTimeoutMs: 5,
        fetchPlatformIssues: async () => ({
          ok: true as const,
          page: { issues: [remoteIssue({ number: 7 })], totalCount: 1 },
        }),
        resolveGithubEnhancement: () => new Promise(() => {}),
      }),
    );
    const result = await service.list();
    expect(result.items.map((i) => i.number)).toEqual([7]);
    expect(result.githubEnhancement).toBeNull();
  });

  it('invalidate 之后发起的查询不复用更早的在途请求', async () => {
    // 只用 epoch 阻止「旧结果落缓存」是不够的:失效后发起的调用若复用那个读了旧账本
    // 的在途 Promise,拿回的仍是不含新 issue 的快照,而页面不会自动再查。
    let ledger: SubmittedIssueRecord[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;
    const fetchPlatformIssues = vi.fn(async () => {
      if (gated) await gate;
      return { ok: false as const, reason: 'platform-unavailable' as const };
    });
    const service = new MyIssuesService(makeDeps({ readLedger: () => ledger, fetchPlatformIssues }));

    const stale = service.list(); // 读到空账本后卡住
    ledger = [ledgerRecord({ number: 555 })];
    service.invalidate(); // 另一个窗口提交成功

    gated = false;
    const fresh = service.list(); // 失效后发起 —— 必须另起,不能复用上面那个
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(2);
    expect((await fresh).items.map((i) => i.number)).toEqual([555]);

    release!();
    await stale;
  });

  it('同一账号内 TTL 与 in-flight 复用不受影响', async () => {
    const fetchPlatformIssues = vi.fn(async () => ({
      ok: true as const,
      page: { issues: [remoteIssue()], totalCount: 1 },
    }));
    const service = new MyIssuesService(
      makeDeps({ fetchPlatformIssues, readScope: () => 'owner-a:1' }),
    );
    await service.list();
    await service.list();
    expect(fetchPlatformIssues).toHaveBeenCalledTimes(1);
  });
});
