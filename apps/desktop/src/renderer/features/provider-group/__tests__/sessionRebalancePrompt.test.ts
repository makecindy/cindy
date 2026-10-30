/**
 * 发送前问换号(provider-groups.md §6.2「任务进行中换号」，2026-10-21 用户裁决)：确认才换，勾「以后自动换」只记这个任务；
 * 选过以后自动换的不再弹窗；取消不换。提议在任务空闲时预先问好，发送时没有问好的提议(问不到、旧版本、还没问完)就
 * 立即照常发送，不多等一次往返。用户看到什么、任务所在电脑收到什么由这里决定，所以从发送前调用的真实入口验证。
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { offerSessionRebalance, prefetchSessionRebalance, SESSION_REBALANCE_CACHE_MS } from '../sessionRebalancePrompt';

const MINI = 'device:mini:anthropic';
const t = i18n.t.bind(i18n) as TFunction;
const suggestion = (kind: 'ask' | 'auto') => ({
  kind,
  memberKey: MINI,
  label: 'Mini',
  quota: { usedPercent: 20, resetAtMs: Date.now() + 86_400_000, windowMs: 7 * 86_400_000 },
});

type Answer = { ok: boolean; checked: boolean };

function setup(reply: () => Promise<unknown>, answer: Answer = { ok: false, checked: false }) {
  const command = vi.fn((request: { action: string }) =>
    request.action === 'rebalance-suggestion' ? reply() : Promise.resolve({ ok: true }));
  vi.stubGlobal('window', { electronAPI: { providerGroup: { command } } });
  const confirmWithCheckbox = vi.fn(async (_options: { title: string; description?: string }) => answer);
  const decisions = () => command.mock.calls.map(([request]) => request).filter((r) => r.action === 'rebalance-decision');
  return { command, confirmWithCheckbox, decisions };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offerSessionRebalance', () => {
  it.each([
    ['switch once', 'ask', { ok: true, checked: false }, false],
    ['switch and remember for this task', 'ask', { ok: true, checked: true }, true],
    ['cancel', 'ask', { ok: false, checked: false }, null],
    ['already set to switch automatically', 'auto', undefined, false],
  ] as const)('%s', async (_name, kind, answer, remember) => {
    const h = setup(async () => suggestion(kind), answer);
    await prefetchSessionRebalance('s1');
    const record = await offerSessionRebalance({ sessionId: 's1', confirmWithCheckbox: h.confirmWithCheckbox, t });
    expect(h.decisions()).toEqual([]);
    if (remember === null) expect(record).toBeUndefined();
    else { expect(record).toBeTypeOf('function'); await record!('message-a'); }

    expect(h.confirmWithCheckbox).toHaveBeenCalledTimes(kind === 'ask' ? 1 : 0);
    if (kind === 'ask') {
      expect(h.confirmWithCheckbox.mock.calls[0][0]).toMatchObject({
        title: expect.stringContaining('Mini'),
        description: expect.stringContaining('80%'),
      });
    }
    expect(h.decisions()).toEqual(remember === null
      ? []
      : [{ action: 'rebalance-decision', sessionId: 's1', memberKey: MINI, remember, clientId: 'message-a' }]);
    // 一次提议只管一条消息：下一条等任务再空闲、重新问过才可能再问。
    await offerSessionRebalance({ sessionId: 's1', confirmWithCheckbox: h.confirmWithCheckbox, t });
    expect(h.confirmWithCheckbox).toHaveBeenCalledTimes(kind === 'ask' ? 1 : 0);
  });

  it('sends at once without asking when nothing usable was fetched beforehand', async () => {
    // 还在问(慢)：不等它。
    const slow = setup(() => new Promise(() => undefined));
    void prefetchSessionRebalance('s1');
    await offerSessionRebalance({ sessionId: 's1', confirmWithCheckbox: slow.confirmWithCheckbox, t });
    expect(slow.confirmWithCheckbox).not.toHaveBeenCalled();

    // 旧版本不认识这个请求。
    const old = setup(() => Promise.reject(new Error('[INVALID_PARAMS] unknown provider group action')));
    await prefetchSessionRebalance('s2');
    await offerSessionRebalance({ sessionId: 's2', confirmWithCheckbox: old.confirmWithCheckbox, t });
    expect(old.confirmWithCheckbox).not.toHaveBeenCalled();

    // 问好的提议已经过期(配额快照只在这么久内有效)。
    vi.useFakeTimers();
    try {
      const stale = setup(async () => suggestion('ask'));
      await prefetchSessionRebalance('s3');
      vi.advanceTimersByTime(SESSION_REBALANCE_CACHE_MS + 1);
      await offerSessionRebalance({ sessionId: 's3', confirmWithCheckbox: stale.confirmWithCheckbox, t });
      expect(stale.confirmWithCheckbox).not.toHaveBeenCalled();
      expect(stale.decisions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
