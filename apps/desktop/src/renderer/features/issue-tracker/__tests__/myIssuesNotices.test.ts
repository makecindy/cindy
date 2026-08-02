/**
 * 顶部提示的选取规则 —— 钉住「哪些降级值得打扰用户」这个产品判断。
 */

import { describe, expect, it } from 'vitest';

import type { MyIssueItem, MyIssuesResult } from '@/../shared/myIssues';

import { canTrustEmptyList, selectMyIssuesNotices } from '../lib/myIssuesNotices';

function item(over: Partial<MyIssueItem> = {}): MyIssueItem {
  return {
    number: 1,
    url: 'https://github.com/makecindy/cindy/issues/1',
    title: 't',
    type: 'bug',
    state: 'unknown',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: null,
    commentCount: null,
    sources: ['cindy-tool'],
    ...over,
  };
}

function result(over: Partial<MyIssuesResult> = {}): MyIssuesResult {
  return {
    items: [],
    githubEnhancement: null,
    githubEnhancementFailed: false,
    degraded: null,
    truncated: false,
    ...over,
  };
}

/** 配好且身份可用的插件通道增强 —— 多组用例共用。 */
const enhanced = { login: 'octocat', source: 'ghost' as const };

describe('selectMyIssuesNotices', () => {
  it('一切正常时不打扰用户', () => {
    expect(selectMyIssuesNotices(result({ items: [item()] }))).toEqual([]);
  });

  it('平台接口未就绪 + 列表只有本机账本:说「只显示本机记录」成立', () => {
    expect(
      selectMyIssuesNotices(
        result({ degraded: 'platform-unavailable', items: [item({ state: 'unknown' })] }),
      ),
    ).toEqual(['issueTracker.mine.platformUnavailableHint']);
  });

  it('平台接口未就绪 + 一条都没有:**必须**提示 —— 空的本机兜底不能证明远端历史为空', () => {
    // 曾经这里返回 [](想省掉接口上线前的常驻横幅),但那会让新设备 / 重装 / 提交早于
    // 账本功能的用户直接看到「还没有提交过 Issue」,把「暂时查不到」说成「你从未提交」。
    expect(selectMyIssuesNotices(result({ degraded: 'platform-unavailable' }))).toEqual([
      'issueTracker.mine.platformUnavailableHint',
    ]);
  });

  it('平台接口未就绪但列表全部来自远端:提示历史可能不全,但不说「只显示本机记录」', () => {
    expect(
      selectMyIssuesNotices(
        result({
          degraded: 'platform-unavailable',
          items: [
            item({ number: 1, state: 'open', sources: ['github-account'] }),
            item({ number: 2, state: 'closed', sources: ['github-account'] }),
          ],
        }),
      ),
    ).toEqual(['issueTracker.mine.platformUnavailablePartialHint']);
  });

  it('混合列表(增强有内容 + 账本里一条平台代发):不得谎称「只显示本机记录」', () => {
    // 这正是读接口未上线时最常见的真实场景:平台 404、GitHub 增强并回几十条、账本里
    // 有一条平台代发记录(作者是 cindy-issue App,不出现在 author: 搜索里 → 保持
    // unknown)。旧判据 some(state === 'unknown') 在这里为真,于是推出「只显示本机
    // 记录」——而同一页明明列着一堆 GitHub 账号名下的 issue。
    expect(
      selectMyIssuesNotices(
        result({
          degraded: 'platform-unavailable',
          items: [
            item({ number: 1, state: 'open', sources: ['github-account'] }),
            item({ number: 2, state: 'unknown', sources: ['cindy-tool'] }),
          ],
        }),
      ),
    ).toEqual(['issueTracker.mine.platformUnavailablePartialHint']);
  });

  it('未登录 / 取数失败无条件提示,空列表时也要说清是「没查到」而不是「没有」', () => {
    expect(selectMyIssuesNotices(result({ degraded: 'not-signed-in' }))).toEqual([
      'issueTracker.mine.notSignedInHint',
    ]);
    expect(selectMyIssuesNotices(result({ degraded: 'fetch-failed' }))).toEqual([
      'issueTracker.mine.fetchFailedHint',
    ]);
  });

  it('取数失败但增强带回了远端条目:不说「只显示本机记录」(否则与同页列出的自相矛盾)', () => {
    const withRemote = result({
      degraded: 'fetch-failed',
      items: [item({ state: 'open' }), item({ number: 2 })],
    });
    expect(selectMyIssuesNotices(withRemote)).toEqual([
      'issueTracker.mine.fetchFailedPartialHint',
    ]);

    // 全部条目都没有实时状态 → 列表确实只有本机账本,那句结论成立。
    const ledgerOnly = result({ degraded: 'fetch-failed', items: [item(), item({ number: 2 })] });
    expect(selectMyIssuesNotices(ledgerOnly)).toEqual(['issueTracker.mine.fetchFailedHint']);
  });

  it('判据看 state 而不是 sources —— 账本里 github-user 的记录也打 github-account', () => {
    // 上一轮起,账本 identity=github-user 的条目会带 github-account 来源(提交时确认的
    // 事实),所以 sources 不再等价于「来自远端」。用它当判据会误报成 partial。
    const ledgerGithubUser = result({
      degraded: 'fetch-failed',
      items: [item({ sources: ['cindy-tool', 'github-account'], state: 'unknown' })],
    });
    expect(selectMyIssuesNotices(ledgerGithubUser)).toEqual(['issueTracker.mine.fetchFailedHint']);
  });

  it('增强配了却没用上:单独一条提示,排在主来源之后', () => {
    // 显式给出 ghost 来源:提示分了版本,插件专属那条只在确知是插件通道时才给
    // (来源见「增强失败提示按来源分版」那组用例),所以这里不能靠 fixture 默认值。
    const ghostFailed = { githubEnhancementFailed: true, githubEnhancement: enhanced } as const;
    expect(selectMyIssuesNotices(result(ghostFailed))).toEqual([
      'issueTracker.mine.enhancementFailedHint',
    ]);
    // 两路各自出问题时两条都要说,顺序稳定(平台是主来源,排前面)。
    expect(
      selectMyIssuesNotices(result({ degraded: 'platform-unavailable', ...ghostFailed })),
    ).toEqual([
      'issueTracker.mine.platformUnavailableHint',
      'issueTracker.mine.enhancementFailedHint',
    ]);
  });

  it('回退救回来时不提示 —— 没有可见损失就不打扰用户', () => {
    // service 在兜底通道拿到数据后会把 githubEnhancementFailed 置回 false。
    expect(
      selectMyIssuesNotices(
        result({ githubEnhancementFailed: false, items: [item({ state: 'open' })] }),
      ),
    ).toEqual([]);
  });

  describe('canTrustEmptyList', () => {
    it('三路都真查过且成功才可确证「真的没有」', () => {
      expect(canTrustEmptyList(result({ githubEnhancement: enhanced }))).toBe(true);
    });

    it('没配增强 ⇒ 不可确证 —— GitHub 账号那一路根本没查过', () => {
      // githubEnhancementFailed 此时是 false(没配不是失败),只看它就会把「从未查过」
      // 当成「查过且为空」。平台侧不知道用户绕过 Cindy 直接在 GitHub 提的那些 issue,
      // 只有增强查得到 —— 对那种用户会重演本次要修的错误断言。
      expect(canTrustEmptyList(result({ githubEnhancement: null }))).toBe(false);
    });

    it('任一路降级或失败就不可确证', () => {
      for (const over of [
        { degraded: 'platform-unavailable' as const },
        { degraded: 'not-signed-in' as const },
        { degraded: 'fetch-failed' as const },
        { githubEnhancementFailed: true },
      ]) {
        expect(canTrustEmptyList(result({ githubEnhancement: enhanced, ...over }))).toBe(false);
      }
    });
  });

  describe('增强失败提示按来源分版', () => {
    it('ghost 来源:给插件令牌那版指引', () => {
      expect(
        selectMyIssuesNotices(
          result({
            githubEnhancementFailed: true,
            githubEnhancement: { login: 'octocat', source: 'ghost' },
          }),
        ),
      ).toEqual(['issueTracker.mine.enhancementFailedHint']);
    });

    it('gh-cli 来源:用不提插件的通用版 —— 那种用户根本没在用插件', () => {
      // searchViaFallback 对非 ghost 主通道直接判失败(它自己就是兜底),所以
      // githubEnhancementFailed 在 gh-cli 下同样为 true。给他「去插件页检查」
      // 等于指向不存在的页面,而 gh 用的是完整 OAuth token、失败多为网络或额度。
      expect(
        selectMyIssuesNotices(
          result({
            githubEnhancementFailed: true,
            githubEnhancement: { login: 'octocat', source: 'gh-cli' },
          }),
        ),
      ).toEqual(['issueTracker.mine.enhancementFailedGenericHint']);
    });

    it('连来源都不知道(配了却问不出身份)→ 也用通用版,不指向插件页', () => {
      // 新可达的组合:runtime 不再把 gh 身份查询的异常咽成 null,所以
      // githubEnhancement=null 且 failed=true 会真的出现(token 过期 / 撤销 / 限流)。
      // 判据写成「是不是 ghost」而不是「是不是 gh-cli」,未知情况才会落在保守那版 ——
      // 反过来写会把这里误判成插件故障。
      expect(
        selectMyIssuesNotices(
          result({ githubEnhancementFailed: true, githubEnhancement: null }),
        ),
      ).toEqual(['issueTracker.mine.enhancementFailedGenericHint']);
    });
  });

  it('截断与降级可以同时提示', () => {
    expect(
      selectMyIssuesNotices(result({ degraded: 'fetch-failed', truncated: true, items: [item()] })),
    ).toEqual(['issueTracker.mine.fetchFailedHint', 'issueTracker.mine.truncatedHint']);
  });

  it('提示文案 key 与 UI 用的一致(没有 GitHub 身份时绝不提示连接 GitHub)', () => {
    const keys = [
      ...selectMyIssuesNotices(result({ degraded: 'platform-unavailable', items: [item()] })),
      ...selectMyIssuesNotices(result({ degraded: 'not-signed-in' })),
      ...selectMyIssuesNotices(result({ degraded: 'fetch-failed' })),
      ...selectMyIssuesNotices(result({ truncated: true })),
    ];
    expect(keys.some((key) => /viewerNone|noToken|connectGithub/i.test(key))).toBe(false);
  });
});
