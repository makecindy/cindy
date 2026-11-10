/**
 * 发送前问换号(provider-groups.md §6.2「任务进行中换号」，2026-10-21 用户裁决)：确认才换，勾「以后自动换」只记这个任务；
 * 选过以后自动换的不再弹窗；取消不换。提议在任务空闲时预先问好，发送时没有问好的提议(问不到、旧版本、还没问完)就
 * 立即照常发送，不多等一次往返。用户看到什么、任务所在电脑收到什么由这里决定，所以从发送前调用的真实入口验证。
 */
import type { TFunction } from 'i18next';
import { isValidElement } from 'react';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import type { RebalanceChoice } from '../SessionRebalanceChoices';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { applySessionRebalancePreferencePatch, offerSessionRebalance, prefetchSessionRebalance, SESSION_REBALANCE_CACHE_MS, SESSION_REBALANCE_QUERY_TIMEOUT_MS } from '../sessionRebalancePrompt';

const MINI = 'device:mini:anthropic';
const t = i18n.t.bind(i18n) as TFunction;
const suggestion = (kind: 'ask' | 'auto') => ({
  kind,
  memberKey: MINI,
  label: 'Mini',
  quota: { usedPercent: 20, resetAtMs: Date.now() + 86_400_000, windowMs: 7 * 86_400_000 },
});

type Answer = { ok: boolean; choice?: RebalanceChoice };

function setup(reply: () => Promise<unknown>, answer: Answer = { ok: false }) {
  const command = vi.fn((request: { action: string }) =>
    request.action === 'rebalance-suggestion' ? reply() : Promise.resolve({ ok: true }));
  vi.stubGlobal('window', { electronAPI: { providerGroup: { command } } });
  const confirm = vi.fn(async (options: ConfirmOptions) => {
    if (answer.choice && isValidElement<{ onChange: (choice: RebalanceChoice) => void }>(options.content)) {
      options.content.props.onChange(answer.choice);
    }
    return answer.ok;
  });
  const decisions = () => command.mock.calls.map(([request]) => request).filter((r) => r.action === 'rebalance-decision');
  return { command, confirm, decisions };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offerSessionRebalance', () => {
  // Unit/远程写超时合同：5 秒仅结束 UI 等待，迟到的成功仍清缓存，迟到的明确失败才通知。
  it.each([true, false])('reconciles a preference write after the UI wait expires (ok=%s)', async (ok) => {
    vi.useFakeTimers();
    try {
      const h = setup(async () => suggestion('ask'), { ok: true, choice: 'off' });
      vi.mocked(toast.error).mockClear();
      const sessionId = `late-write-${ok}`;
      await prefetchSessionRebalance(sessionId);
      let resolve!: (value: unknown) => void;
      const pending = new Promise<unknown>((done) => { resolve = done; });
      h.command.mockImplementation(async (request) => request.action === 'rebalance-preference' ? pending : suggestion('ask'));
      const offer = offerSessionRebalance({ sessionId, confirm: h.confirm, t });
      await vi.advanceTimersByTimeAsync(SESSION_REBALANCE_QUERY_TIMEOUT_MS);
      await offer;
      expect(toast.error).not.toHaveBeenCalled();
      await prefetchSessionRebalance(sessionId);
      resolve({ ok });
      await vi.advanceTimersByTimeAsync(0);
      expect(toast.error).toHaveBeenCalledTimes(ok ? 0 : 1);
      if (ok) {
        await offerSessionRebalance({ sessionId, confirm: h.confirm, t });
        expect(h.confirm).toHaveBeenCalledTimes(1);
      }
    } finally { vi.useRealTimers(); }
  });
  // Unit/§6.2：另一控制端的偏好推送必须清除同任务的旧提议与迟到回包；其他电脑上的同名任务保留。
  it('retires cached and pending proposals on a host-scoped preference push', async () => {
    const h = setup(async () => suggestion('ask'));
    const invoke = vi.fn(async (): Promise<unknown> => suggestion('ask'));
    Object.assign(window.electronAPI!, { deviceLink: { invoke } });
    await prefetchSessionRebalance('remote-disable');
    await prefetchSessionRebalance('remote-disable', 'pc');
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((done) => { resolve = done; });
    invoke.mockImplementation(async () => response);
    const pending = prefetchSessionRebalance('remote-disable', 'pc');
    applySessionRebalancePreferencePatch('remote-disable', { providerGroupRebalanceEnabled: false }, 'pc');
    await offerSessionRebalance({ sessionId: 'remote-disable', hostDeviceId: 'pc', confirm: h.confirm, t });
    expect(h.confirm).not.toHaveBeenCalled();
    resolve(suggestion('ask'));
    await pending;
    await offerSessionRebalance({ sessionId: 'remote-disable', hostDeviceId: 'pc', confirm: h.confirm, t });
    expect(h.confirm).not.toHaveBeenCalled();
    await offerSessionRebalance({ sessionId: 'remote-disable', confirm: h.confirm, t });
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });
  // Unit/时序，§6.2：弹窗期间刷新的旧提议晚于关闭操作返回，也不能使下一次发送再弹窗。
  it('invalidates suggestions that were already in flight when opting out', async () => {
    const h = setup(async () => suggestion('ask'), { ok: true, choice: 'off' });
    await prefetchSessionRebalance('disable-in-flight');
    let resolve!: (value: unknown) => void;
    const reply = new Promise<unknown>((done) => { resolve = done; });
    h.command.mockImplementation(async (request) => request.action === 'rebalance-suggestion' ? reply : { ok: true });
    const pending = prefetchSessionRebalance('disable-in-flight');
    await offerSessionRebalance({ sessionId: 'disable-in-flight', confirm: h.confirm, t });
    resolve(suggestion('ask'));
    await pending;
    await offerSessionRebalance({ sessionId: 'disable-in-flight', confirm: h.confirm, t });
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });
  // Unit, §6.2：原用例未覆盖明确关闭；不能把关闭选项当成取消或同意换号。
  it.each([true, false, 'unsupported'])('records opting out without switching, reporting failed saves (ok=%s)', async (ok) => {
    const h = setup(async () => suggestion('ask'), { ok: true, choice: 'off' });
    vi.mocked(toast.error).mockClear();
    await prefetchSessionRebalance('opt-out');
    h.command.mockImplementation(async (request) => {
      if (ok === 'unsupported') throw new Error('[INVALID_PARAMS] unknown action');
      return request.action === 'rebalance-preference' ? { ok } : suggestion('ask');
    });
    expect(await offerSessionRebalance({ sessionId: 'opt-out', confirm: h.confirm, t })).toBeUndefined();
    expect(h.command).toHaveBeenLastCalledWith({ action: 'rebalance-preference', sessionId: 'opt-out', enabled: false });
    expect(h.decisions()).toEqual([]);
    expect(toast.error).toHaveBeenCalledTimes(ok === true ? 0 : 1);
  });
  it.each([
    ['switch once', 'ask', { ok: true, choice: 'once' }, false],
    ['switch and remember for this task', 'ask', { ok: true, choice: 'auto' }, true],
    ['cancel', 'ask', { ok: false }, null],
    ['already set to switch automatically', 'auto', undefined, false],
  ] as const)('%s', async (_name, kind, answer, remember) => {
    const h = setup(async () => suggestion(kind), answer);
    await prefetchSessionRebalance('s1');
    const record = await offerSessionRebalance({ sessionId: 's1', confirm: h.confirm, t });
    expect(h.decisions()).toEqual([]);
    if (remember === null) expect(record).toBeUndefined();
    else { expect(record).toBeTypeOf('function'); await record!('message-a'); }

    expect(h.confirm).toHaveBeenCalledTimes(kind === 'ask' ? 1 : 0);
    if (kind === 'ask') {
      expect(h.confirm.mock.calls[0][0]).toMatchObject({
        title: expect.stringContaining('Mini'),
        description: expect.stringContaining('80%'),
      });
    }
    expect(h.decisions()).toEqual(remember === null
      ? []
      : [{ action: 'rebalance-decision', sessionId: 's1', memberKey: MINI, remember, clientId: 'message-a' }]);
    // 一次提议只管一条消息：下一条等任务再空闲、重新问过才可能再问。
    await offerSessionRebalance({ sessionId: 's1', confirm: h.confirm, t });
    expect(h.confirm).toHaveBeenCalledTimes(kind === 'ask' ? 1 : 0);
  });

  it('sends at once without asking when nothing usable was fetched beforehand', async () => {
    // 还在问(慢)：不等它。
    const slow = setup(() => new Promise(() => undefined));
    void prefetchSessionRebalance('s1');
    await offerSessionRebalance({ sessionId: 's1', confirm: slow.confirm, t });
    expect(slow.confirm).not.toHaveBeenCalled();

    // 旧版本不认识这个请求。
    const old = setup(() => Promise.reject(new Error('[INVALID_PARAMS] unknown provider group action')));
    await prefetchSessionRebalance('s2');
    await offerSessionRebalance({ sessionId: 's2', confirm: old.confirm, t });
    expect(old.confirm).not.toHaveBeenCalled();

    // 问好的提议已经过期(配额快照只在这么久内有效)。
    vi.useFakeTimers();
    try {
      const stale = setup(async () => suggestion('ask'));
      await prefetchSessionRebalance('s3');
      vi.advanceTimersByTime(SESSION_REBALANCE_CACHE_MS + 1);
      await offerSessionRebalance({ sessionId: 's3', confirm: stale.confirm, t });
      expect(stale.confirm).not.toHaveBeenCalled();
      expect(stale.decisions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
