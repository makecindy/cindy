/**
 * codex-model-backfill 单测 —— 启动补拉的决策逻辑(纯函数 + 注入 deps,不碰真实 app-server)。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS,
  createCodexModelBackfillCoordinator,
  maybeBackfillCodexModels,
  type CodexBackfillDeps,
} from '../codex-model-backfill.js';

function makeDeps(over: Partial<CodexBackfillDeps> = {}): CodexBackfillDeps {
  return {
    hasCodexLogin: async () => true,
    hasCodexModels: () => false,
    refreshLive: async () => true,
    onApplied: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...over,
  };
}

describe('maybeBackfillCodexModels', () => {
  it('未登录 → 跳过,不拉不广播', async () => {
    const refreshLive = vi.fn(async () => true);
    const onApplied = vi.fn();
    const r = await maybeBackfillCodexModels(makeDeps({ hasCodexLogin: async () => false, refreshLive, onApplied }));
    expect(r).toBe('skipped-unauthed');
    expect(refreshLive).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('已有 codex 模型 → 跳过,不重复起 app-server', async () => {
    const refreshLive = vi.fn(async () => true);
    const r = await maybeBackfillCodexModels(makeDeps({ hasCodexModels: () => true, refreshLive }));
    expect(r).toBe('skipped-has-models');
    expect(refreshLive).not.toHaveBeenCalled();
  });

  it('已登录 + 无模型 + live applied → 广播', async () => {
    const onApplied = vi.fn();
    const r = await maybeBackfillCodexModels(makeDeps({ refreshLive: async () => true, onApplied }));
    expect(r).toBe('applied');
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('live 未 applied(app-server 起不来等)→ 不广播,记 warn', async () => {
    const onApplied = vi.fn();
    const warn = vi.fn();
    const r = await maybeBackfillCodexModels(
      makeDeps({ refreshLive: async () => false, onApplied, log: { info: vi.fn(), warn } }),
    );
    expect(r).toBe('not-applied');
    expect(onApplied).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('refreshLive 抛错 → 吞掉记 warn,不影响启动(返回 error)', async () => {
    const warn = vi.fn();
    const onApplied = vi.fn();
    const r = await maybeBackfillCodexModels(
      makeDeps({
        refreshLive: async () => {
          throw new Error('app-server spawn failed');
        },
        onApplied,
        log: { info: vi.fn(), warn },
      }),
    );
    expect(r).toBe('error');
    expect(onApplied).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'startup codex model backfill threw',
      expect.objectContaining({ error: 'app-server spawn failed' }),
    );
  });
});

describe('createCodexModelBackfillCoordinator', () => {
  it('未授权不消费重试额度,授权就绪后仍能补拉', async () => {
    // 回归全新机器首启：maker 构造那一刻「本机已有 ChatGPT 凭证」的 owner 绑定还没认领完,
    // hasCodexLogin() 返回 false。旧实现在这里用掉了唯一一次机会,ChatGPT 订阅的模型清单
    // 要等用户打开设置页 / 模型选择器才出现。
    let authed = false;
    const refreshLive = vi.fn(async () => true);
    const onApplied = vi.fn();
    const coordinator = createCodexModelBackfillCoordinator(
      makeDeps({ hasCodexLogin: async () => authed, refreshLive, onApplied }),
    );

    await expect(coordinator.request()).resolves.toBe('skipped-unauthed');
    expect(refreshLive).not.toHaveBeenCalled();

    // 绑定认领完成 → auth 事件再驱动一次。
    authed = true;
    await expect(coordinator.request()).resolves.toBe('applied');
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('清单在场与否每次现查,被 auth 边界收口清空后还能重新拉回来', async () => {
    // 不缓存「已经拉到了」:登出 / cache miss 回退都会清空 discovered 快照,
    // 把成功记成终态会让清空之后再也拉不回来。
    let hasModels = false;
    const refreshLive = vi.fn(async () => {
      hasModels = true;
      return true;
    });
    const coordinator = createCodexModelBackfillCoordinator(
      makeDeps({ hasCodexModels: () => hasModels, refreshLive }),
    );

    await expect(coordinator.request()).resolves.toBe('applied');
    await expect(coordinator.request()).resolves.toBe('skipped-has-models');
    expect(refreshLive).toHaveBeenCalledOnce();

    // 边界收口把快照清空(不重置 coordinator)—— 下一次请求必须真的再拉一次。
    hasModels = false;
    await expect(coordinator.request()).resolves.toBe('applied');
    expect(refreshLive).toHaveBeenCalledTimes(2);
  });

  it('并发请求合并成一次拉取,不各起一个 app-server', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshLive = vi.fn(async () => {
      await gate;
      return true;
    });
    const coordinator = createCodexModelBackfillCoordinator(makeDeps({ refreshLive }));

    const a = coordinator.request();
    const b = coordinator.request();
    release();
    await expect(Promise.all([a, b])).resolves.toEqual(['applied', 'applied']);
    expect(refreshLive).toHaveBeenCalledOnce();
  });

  it('真跑过 app-server 的失败到封顶就停手,reset 后恢复额度', async () => {
    const refreshLive = vi.fn(async () => false);
    const coordinator = createCodexModelBackfillCoordinator(makeDeps({ refreshLive }));

    for (let i = 0; i < CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS; i += 1) {
      await expect(coordinator.request()).resolves.toBe('not-applied');
    }
    await expect(coordinator.request()).resolves.toBe('skipped-exhausted');
    expect(refreshLive).toHaveBeenCalledTimes(CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS);

    coordinator.reset();
    await expect(coordinator.request()).resolves.toBe('not-applied');
    expect(refreshLive).toHaveBeenCalledTimes(CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS + 1);
  });

  it('reset 作废在途那次的写回权 —— 旧账号结果不得落地', async () => {
    // 回归 PR #1076 review:reset 只清 inflight 引用时,旧账号那次 model/list 仍会带着旧
    // maker 引用完成并调 onApplied,把刚被 auth 边界清空的目录重新填上上一个账号的模型。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onApplied = vi.fn();
    const warn = vi.fn();
    const coordinator = createCodexModelBackfillCoordinator(
      makeDeps({
        refreshLive: async () => {
          await gate;
          return true;
        },
        onApplied,
        log: { info: vi.fn(), warn },
      }),
    );

    const oldAccountFlight = coordinator.request();
    coordinator.reset(); // 登出 / 切账号发生在拉取途中
    release();
    await expect(oldAccountFlight).resolves.toBe('applied');
    expect(onApplied).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auth boundary changed mid-flight'));
  });

  it('换代后的失败不占新边界的重试额度', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshLive = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await gate;
        return false;
      })
      .mockResolvedValue(false);
    const coordinator = createCodexModelBackfillCoordinator(makeDeps({ refreshLive }));

    const stale = coordinator.request();
    coordinator.reset();
    release();
    await stale;

    // 新边界应有完整的 MAX 次额度：旧代那次失败不能记在它头上。
    for (let i = 0; i < CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS; i += 1) {
      await expect(coordinator.request()).resolves.toBe('not-applied');
    }
    await expect(coordinator.request()).resolves.toBe('skipped-exhausted');
  });

  it('未授权抖动不会耗尽额度', async () => {
    const refreshLive = vi.fn(async () => true);
    const coordinator = createCodexModelBackfillCoordinator(
      makeDeps({ hasCodexLogin: async () => false, refreshLive }),
    );

    for (let i = 0; i < CODEX_MODEL_BACKFILL_MAX_LIVE_ATTEMPTS + 2; i += 1) {
      await expect(coordinator.request()).resolves.toBe('skipped-unauthed');
    }
    expect(refreshLive).not.toHaveBeenCalled();
  });
});
