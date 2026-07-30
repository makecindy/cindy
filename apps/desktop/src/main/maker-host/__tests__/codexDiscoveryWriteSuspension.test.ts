/**
 * codex 模型发现写入的 auth 边界静默窗口。
 *
 * 回归 PR #1076 review 第二轮：补拉侧的「代号校验」只挡住了自己的广播，挡不住目录写入 ——
 * `refreshLive()` 内部经 agent 的 `onCodexLocalModelsListed` 回调调用
 * `setDiscoveredCodexModels()`，那发生在 promise resolve **之前**，发起方根本没有机会介入。
 * 于是上一个账号在途的那次 `model/list` 会在目录被按新边界清空之后回来，把旧账号的模型重新
 * 写进去并广播给 renderer；凭证失效路径尤其明显 —— 它不 dispose 旧 host。
 *
 * 闸门因此放在**写入口**（active-catalog），而不是各个发起方：发现写入有多条通道（启动补拉、
 * 登录收口、会话 init 的 supportedModels 捕获），逐个去挡就是同一判据的第三、第四份拷贝。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG, type CatalogModel } from '@cindy/model-providers';

import {
  getActiveCatalog,
  isCodexModelDiscoveryWriteSuspended,
  setActiveCatalog,
  setDiscoveredCodexModels,
  suspendCodexModelDiscoveryWrites,
} from '../active-catalog.js';

const fake = (id: string): CatalogModel => ({
  id,
  name: `Discovered ${id}`,
  group: 'gpt',
  sortOrder: 16.5,
  contextWindow: 400_000,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  status: 'active',
  defaultEnabled: true,
});

function codexIds(): string[] {
  const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
  return (openai?.models.codex ?? []).map((m) => m.id);
}

afterEach(() => {
  setActiveCatalog(BUNDLED_CATALOG);
  setDiscoveredCodexModels([], { fromAuthBoundary: true });
});

describe('codex 模型发现的 auth 边界静默窗口', () => {
  it('窗口期丢弃 discovery 写入 —— 旧账号在途结果不得落地', () => {
    // 交错顺序就是线上那一幕：旧账号的 model/list 已经发出 → auth 边界收口把目录清空 →
    // 旧结果这才回来。
    setDiscoveredCodexModels([fake('old-account-model')], { fromAuthBoundary: true });
    expect(codexIds()).toContain('old-account-model');

    const resume = suspendCodexModelDiscoveryWrites();
    // 边界收口自己的权威清空。
    setDiscoveredCodexModels([], { fromAuthBoundary: true });
    expect(codexIds()).not.toContain('old-account-model');

    // 旧账号那次 model/list 迟到回来（discovery 来源，无 fromAuthBoundary）。
    setDiscoveredCodexModels([fake('old-account-model')]);
    expect(codexIds()).not.toContain('old-account-model');

    resume();
  });

  it('窗口结束后 discovery 写入照常生效', () => {
    const resume = suspendCodexModelDiscoveryWrites();
    setDiscoveredCodexModels([fake('dropped')]);
    expect(codexIds()).not.toContain('dropped');
    resume();

    setDiscoveredCodexModels([fake('accepted')]);
    expect(codexIds()).toContain('accepted');
  });

  it('fromAuthBoundary 写入穿透窗口 —— 它正是窗口要保护的目标状态', () => {
    const resume = suspendCodexModelDiscoveryWrites();
    setDiscoveredCodexModels([fake('authoritative')], { fromAuthBoundary: true });
    expect(codexIds()).toContain('authoritative');
    resume();
  });

  it('重叠的收口按引用计数,先结束的那个不得提前放开窗口', () => {
    // 登出紧接换账号：两条收口链重叠。布尔闸会被先结束的那个放开，留下一段缝隙。
    const resumeOuter = suspendCodexModelDiscoveryWrites();
    const resumeInner = suspendCodexModelDiscoveryWrites();
    expect(isCodexModelDiscoveryWriteSuspended()).toBe(true);

    resumeInner();
    expect(isCodexModelDiscoveryWriteSuspended()).toBe(true);
    setDiscoveredCodexModels([fake('still-dropped')]);
    expect(codexIds()).not.toContain('still-dropped');

    resumeOuter();
    expect(isCodexModelDiscoveryWriteSuspended()).toBe(false);
  });

  it('release 幂等 —— 重复释放不得把别人的挂起一起放开', () => {
    const resumeA = suspendCodexModelDiscoveryWrites();
    const resumeB = suspendCodexModelDiscoveryWrites();
    resumeA();
    resumeA();
    resumeA();
    // A 只持有一份挂起，重复调用不该把 B 的那份也退掉。
    expect(isCodexModelDiscoveryWriteSuspended()).toBe(true);
    resumeB();
    expect(isCodexModelDiscoveryWriteSuspended()).toBe(false);
  });

  it('窗口期被丢弃的写入不触发目录 revision 变更(不白广播)', () => {
    // 广播由 markChanged 驱动；被丢弃的写入若仍 markChanged，renderer 会为一次没落地的
    // 变更做一轮 refetch。
    const before = getActiveCatalog();
    const resume = suspendCodexModelDiscoveryWrites();
    setDiscoveredCodexModels([fake('dropped')]);
    // 同一引用 = 合并缓存没被失效 = 没有 markChanged。
    expect(getActiveCatalog()).toBe(before);
    resume();
  });
});
