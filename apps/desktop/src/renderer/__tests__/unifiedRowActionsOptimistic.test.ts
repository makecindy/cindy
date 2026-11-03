// @vitest-environment jsdom

/**
 * 统一模型面板改深度 / Fast 的即时反馈:写入在途时行上先显示目标值(松手不回弹),
 * 在途时仍可继续调(每一维只保留最新一笔,落定后提交);失败后回到真实值。
 */

import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnifiedModelEntry } from '@cindy/model-providers';

import type { UnifiedAnchor, UnifiedRowConfig } from '../components/new-chat/unifiedModelSelection';
import {
  PENDING_VISIBLE_DELAY_MS,
  useUnifiedRowActions,
  withOptimisticConfig,
  type UnifiedRowActionsOptions,
} from '../components/new-chat/useUnifiedRowActions';

const anchor: UnifiedAnchor = { kind: 'model', providerId: 'openai', modelId: 'gpt' };
const entry = { providerId: 'openai', modelId: 'gpt' } as unknown as UnifiedModelEntry;
const config = {
  engine: 'codex',
  agent: 'codex',
  efforts: ['low', 'medium', 'high', 'xhigh'],
  effort: 'medium',
  fast: false,
  fastCapable: true,
  customized: false,
  capability: { defaultEffort: 'medium' },
  wireModelId: 'gpt',
} as unknown as UnifiedRowConfig;

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderActions(overrides: Partial<UnifiedRowActionsOptions>) {
  return renderHook(() =>
    useUnifiedRowActions({
      interactionDisabled: false,
      isLiveRow: () => true,
      onSelect: vi.fn(),
      onFavoriteFlash: vi.fn(),
      onBeforeRemoveFavorite: vi.fn(),
      ...overrides,
    }),
  );
}

describe('useUnifiedRowActions 深度 / Fast 即时反馈', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('深度写入在途时立即显示目标档,短写入不显示为不可操作', async () => {
    const write = deferred();
    const { result } = renderActions({ onEffortChangeLive: () => write.promise });

    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
    });
    expect(result.current.optimistic).toEqual({ anchorKey: 'model::openai::gpt', effort: 'high' });
    expect(withOptimisticConfig(anchor, config, result.current.optimistic).effort).toBe('high');
    expect(result.current.pending).toBe(false);

    await act(async () => {
      write.resolve(true);
      await settled;
    });
    expect(result.current.optimistic).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it('深度写入在途时仍可继续调:只保留最新一笔,落定后再提交,全程不置灰', async () => {
    const first = deferred();
    const onEffortChangeLive = vi.fn((_effort: string) =>
      onEffortChangeLive.mock.calls.length === 1 ? first.promise : Promise.resolve(true),
    );
    const { result } = renderActions({ onEffortChangeLive });

    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
    });
    act(() => {
      result.current.applyEffort(anchor, entry, config, 'xhigh');
      result.current.applyEffort(anchor, entry, config, 'low');
    });
    expect(onEffortChangeLive).toHaveBeenCalledTimes(1);
    expect(result.current.optimistic?.effort).toBe('low');

    act(() => {
      vi.advanceTimersByTime(PENDING_VISIBLE_DELAY_MS * 3);
    });
    expect(result.current.pending).toBe(false);

    await act(async () => {
      first.resolve(true);
      await settled;
    });
    await act(async () => {});
    expect(onEffortChangeLive.mock.calls.map(([effort]) => effort)).toEqual(['high', 'low']);
    expect(result.current.optimistic).toBeNull();
  });

  it('深度在途时排队的 Fast 不会被随后的深度调整覆盖', async () => {
    const first = deferred();
    const writes: string[] = [];
    const { result } = renderActions({
      onEffortChangeLive: (effort) => {
        writes.push(`effort:${effort}`);
        return writes.length === 1 ? first.promise : Promise.resolve(true);
      },
      onFastModeChangeLive: (enabled) => {
        writes.push(`fast:${enabled}`);
        return Promise.resolve(true);
      },
    });
    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
    });
    act(() => {
      result.current.applyFast(anchor, entry, config, true);
      result.current.applyEffort(anchor, entry, config, 'xhigh');
    });
    expect(withOptimisticConfig(anchor, config, result.current.optimistic)).toMatchObject({
      effort: 'xhigh',
      fast: true,
    });
    await act(async () => {
      first.resolve(true);
      await settled;
    });
    await act(async () => {});
    await act(async () => {});
    expect(writes).toEqual(['effort:high', 'fast:true', 'effort:xhigh']);
    expect(result.current.optimistic).toBeNull();
  });

  it('在途写入失败时丢掉排队的调整', async () => {
    const first = deferred();
    const onEffortChangeLive = vi.fn(() => first.promise);
    const { result } = renderActions({ onEffortChangeLive });
    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
      result.current.applyEffort(anchor, entry, config, 'xhigh');
    });
    await act(async () => {
      first.resolve(false);
      await settled;
    });
    expect(onEffortChangeLive).toHaveBeenCalledTimes(1);
    expect(result.current.optimistic).toBeNull();
  });

  it('「先应用、后收尾」路径失败时同样回报失败,丢掉排队项', async () => {
    const first = deferred();
    const onEffortChangeLive = vi.fn(() => first.promise);
    const { result } = renderActions({
      onEffortChangeLive,
      // 选中的是一条收藏、改的是同模型的普通行:成功后才清锚点的那条路径。
      selectedFavoriteUid: 'fav-1',
      onSelectedFavoriteAnchorClear: vi.fn(),
    });
    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
      result.current.applyEffort(anchor, entry, config, 'xhigh');
    });
    await act(async () => {
      first.resolve(false);
      expect(await settled).toBe(false);
    });
    await act(async () => {});
    expect(onEffortChangeLive).toHaveBeenCalledTimes(1);
    expect(result.current.optimistic).toBeNull();
  });

  it('其它写入超过延迟阈值才显示为不可操作,期间的深度调整排队而不丢弃', async () => {
    const external = deferred();
    const onEffortChangeLive = vi.fn(() => Promise.resolve(true));
    const { result } = renderActions({ onEffortChangeLive });
    let settled: unknown;
    act(() => {
      settled = result.current.runExternal(() => external.promise);
    });
    act(() => {
      expect(result.current.applyEffort(anchor, entry, config, 'high')).toBeUndefined();
    });
    expect(result.current.optimistic?.effort).toBe('high');
    expect(result.current.pending).toBe(false);
    act(() => {
      vi.advanceTimersByTime(PENDING_VISIBLE_DELAY_MS);
    });
    expect(result.current.pending).toBe(true);
    expect(onEffortChangeLive).not.toHaveBeenCalled();
    await act(async () => {
      external.resolve(true);
      await settled;
    });
    await act(async () => {});
    expect(result.current.pending).toBe(false);
    expect(onEffortChangeLive).toHaveBeenCalledWith('high');
    expect(result.current.optimistic).toBeNull();
  });

  it('深度在途时点其它行 / 收藏不会被静默丢弃,落定后按顺序执行', async () => {
    const first = deferred();
    const order: string[] = [];
    const { result } = renderActions({
      onEffortChangeLive: (effort) => {
        order.push(`effort:${effort}`);
        return first.promise;
      },
    });
    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
    });
    act(() => {
      result.current.runExternal(() => {
        order.push('external');
      });
    });
    expect(order).toEqual(['effort:high']);
    await act(async () => {
      first.resolve(true);
      await settled;
    });
    await act(async () => {});
    expect(order).toEqual(['effort:high', 'external']);
  });

  it('被替换的排队项移到队尾,提交顺序等于最后一次点击的先后', async () => {
    const first = deferred();
    const order: string[] = [];
    const { result } = renderActions({
      onEffortChangeLive: (effort) => {
        order.push(`effort:${effort}`);
        return order.length === 1 ? first.promise : Promise.resolve(true);
      },
    });
    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
    });
    act(() => {
      result.current.runExternal(() => {
        order.push('external:1');
      });
      result.current.applyEffort(anchor, entry, config, 'xhigh');
      result.current.runExternal(() => {
        order.push('external:2');
      });
    });
    await act(async () => {
      first.resolve(true);
      await settled;
    });
    await act(async () => {});
    await act(async () => {});
    expect(order).toEqual(['effort:high', 'effort:xhigh', 'external:2']);
  });

  it('排队项在上一笔落定并重新渲染后提交,用的是最新一次渲染的回调', async () => {
    const staleFast = vi.fn(() => Promise.resolve(true));
    const freshFast = vi.fn(() => Promise.resolve(true));
    const { result } = renderHook(() => {
      const [onFastModeChangeLive, setFastHandler] = useState(() => staleFast);
      return useUnifiedRowActions({
        interactionDisabled: false,
        isLiveRow: () => true,
        onSelect: vi.fn(),
        onFavoriteFlash: vi.fn(),
        onBeforeRemoveFavorite: vi.fn(),
        // 与 ChatInput 一致:写入成功时先更新调用方状态(新闭包要到下一次渲染才生效),再返回。
        onEffortChangeLive: () =>
          Promise.resolve().then(() => {
            setFastHandler(() => freshFast);
            return true;
          }),
        onFastModeChangeLive,
      });
    });
    let settled: unknown;
    act(() => {
      settled = result.current.applyEffort(anchor, entry, config, 'high');
      result.current.applyFast(anchor, entry, config, true);
    });
    await act(async () => {
      await settled;
    });
    await act(async () => {});
    expect(staleFast).not.toHaveBeenCalled();
    expect(freshFast).toHaveBeenCalledWith(true);
  });

  it('写入失败后撤掉目标值,回到真实配置', async () => {
    const { result } = renderActions({
      onEffortChangeLive: () => Promise.reject(new Error('persist failed')),
    });
    await act(async () => {
      await result.current.applyEffort(anchor, entry, config, 'high');
    });
    expect(result.current.optimistic).toBeNull();
    expect(withOptimisticConfig(anchor, config, result.current.optimistic)).toBe(config);
  });

  it('Fast 写入同样即时显示', async () => {
    const write = deferred();
    const { result } = renderActions({ onFastModeChangeLive: () => write.promise });
    let settled: unknown;
    act(() => {
      settled = result.current.applyFast(anchor, entry, config, true);
    });
    const shown = withOptimisticConfig(anchor, config, result.current.optimistic);
    expect(shown.fast).toBe(true);
    expect(shown.customized).toBe(true);
    await act(async () => {
      write.resolve(true);
      await settled;
    });
    expect(result.current.optimistic).toBeNull();
  });
});

describe('withOptimisticConfig', () => {
  it('只覆盖发起写入的那一行,且忽略该行不支持的档位', () => {
    const other: UnifiedAnchor = { kind: 'model', providerId: 'openai', modelId: 'other' };
    const optimistic = { anchorKey: 'model::openai::gpt', effort: 'high' as const };
    expect(withOptimisticConfig(other, config, optimistic)).toBe(config);
    expect(withOptimisticConfig(anchor, config, optimistic)).toMatchObject({
      effort: 'high',
      customized: true,
    });
    expect(
      withOptimisticConfig(anchor, config, { anchorKey: 'model::openai::gpt', effort: 'max' }),
    ).toBe(config);
  });
});
