// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useCodexRateLimitReset } from '../useCodexRateLimitReset';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/lib/toast', () => ({ toast: mocks }));

function snapshot(): MobileCodexRateLimitsResult {
  return {
    account: { email: 'te***@example.test', accountId: '…123456', planType: 'plus' },
    rateLimits: { primary: { usedPercent: 100 } }, rateLimitsByLimitId: null,
    rateLimitResetCredits: { availableCount: 2, credits: null },
    resetOffer: { idempotencyKey: '00000000-0000-4000-8000-000000000001', expiresAt: null, validUntil: Date.now() + 60_000 },
  };
}
const refresh = vi.fn();
const consume = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('reset-test');
  mocks.confirm.mockResolvedValue(true);
  consume.mockResolvedValue({ outcome: 'reset', rateLimits: null });
  vi.stubGlobal('electronAPI', { maker: { usage: { consumeCodexRateLimitReset: consume } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('manual Codex resets', () => {
  it('confirms the displayed account and consumes exactly the desktop-issued offer', async () => {
    const value = snapshot();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh, 'openai-b'));
    expect(consume).not.toHaveBeenCalled();
    await act(async () => hook.result.current.reset());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmText: 'codexResets.consumeOnce' }));
    expect(consume).toHaveBeenCalledExactlyOnceWith(value.resetOffer!.idempotencyKey, 'openai-b');
    expect(refresh).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith('codexResets.resetDone');
    expect(hook.result.current.busy).toBe(false);
  });

  function withRows() {
    const value = snapshot();
    const selected = {
      status: 'available' as const, resetType: 'codexRateLimits' as const,
      grantedAt: 1, expiresAt: Date.now() / 1000 + 60_000, title: 'Later reset', description: null,
      resetOffer: { idempotencyKey: '00000000-0000-4000-8000-000000000002', expiresAt: null, validUntil: Date.now() + 60_000 },
    };
    value.rateLimitResetCredits!.credits = [selected];
    return { value, selected };
  }

  it('confirms and consumes the selected row rather than the default offer', async () => {
    const { value, selected } = withRows();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => hook.result.current.reset(selected));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: 'codexResets.confirmSelectedBody' }));
    expect(consume).toHaveBeenCalledExactlyOnceWith(selected.resetOffer.idempotencyKey, 'openai');
  });

  it('does not fall back to the default when a selected row has no offer', async () => {
    const { value, selected } = withRows();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => hook.result.current.reset({ ...selected, resetOffer: null }));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('does not consume a row withdrawn while its confirmation is open', async () => {
    let accept!: (value: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const { value, selected } = withRows();
    const hook = renderHook(({ current }) => useCodexRateLimitReset(current, refresh), { initialProps: { current: value } });
    let request!: Promise<void>;
    act(() => { request = hook.result.current.reset(selected); });
    hook.rerender({ current: { ...value, rateLimitResetCredits: { availableCount: 0, credits: [] } } });
    await act(async () => { accept(true); await request; });
    expect(consume).not.toHaveBeenCalled();
  });

  it('does not consume if the quota recovers while confirmation is open', async () => {
    let accept!: (value: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const value = snapshot();
    const hook = renderHook(({ current }) => useCodexRateLimitReset(current, refresh), { initialProps: { current: value } });
    let request!: Promise<void>;
    act(() => { request = hook.result.current.reset(); });
    hook.rerender({ current: { ...value, rateLimits: { primary: { usedPercent: 0 } } } });
    await act(async () => { accept(true); await request; });
    expect(consume).not.toHaveBeenCalled();
  });

  it('does not consume when the confirmation is cancelled', async () => {
    mocks.confirm.mockResolvedValue(false);
    const value = snapshot();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => hook.result.current.reset());
    expect(consume).not.toHaveBeenCalled();
  });

  it('ignores duplicate clicks while the confirmation is open', async () => {
    let accept!: (value: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const value = snapshot();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => {
      const first = hook.result.current.reset();
      await hook.result.current.reset();
      expect(mocks.confirm).toHaveBeenCalledOnce();
      accept(true);
      await first;
    });
    expect(consume).toHaveBeenCalledOnce();
  });

  it('retains the same offer after an ambiguous network result', async () => {
    consume.mockRejectedValueOnce(new Error('offline'));
    const value = snapshot();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => hook.result.current.reset());
    expect(mocks.error).toHaveBeenCalledWith('codexResets.resetFailed');
    consume.mockResolvedValueOnce({ outcome: 'alreadyRedeemed', rateLimits: null });
    await act(async () => hook.result.current.reset());
    expect(consume.mock.calls).toEqual([
      [value.resetOffer!.idempotencyKey, 'openai'], [value.resetOffer!.idempotencyKey, 'openai'],
    ]);
  });

  it('refuses an expired offer instead of consuming a replacement', async () => {
    const value = snapshot();
    value.resetOffer!.validUntil = Date.now() - 1;
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => hook.result.current.reset());
    expect(consume).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not consume if the data owner changes during confirmation', async () => {
    mocks.confirm.mockImplementation(async () => { setDataOwnerGeneration('other-owner'); return true; });
    const value = snapshot();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => hook.result.current.reset());
    expect(consume).not.toHaveBeenCalled();
  });

  it('does not consume the old connection after the UI switches providers', async () => {
    let accept!: (value: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const value = snapshot();
    const hook = renderHook(({ id }) => useCodexRateLimitReset(value, refresh, id), { initialProps: { id: 'openai' } });
    let request!: Promise<void>;
    act(() => { request = hook.result.current.reset(); });
    hook.rerender({ id: 'openai-b' });
    await act(async () => { accept(true); await request; });
    expect(consume).not.toHaveBeenCalled();
  });

  it.each(['noCredit', 'nothingToReset'])('refreshes after %s without claiming a reset', async outcome => {
    consume.mockResolvedValue({ outcome, rateLimits: null });
    const value = snapshot();
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    await act(async () => hook.result.current.reset());
    expect(refresh).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(`codexResets.${outcome}`);
  });

  it('does not offer resets before the limit or when credits are depleted', async () => {
    const value = snapshot();
    value.rateLimits = { primary: { usedPercent: 99 }, rateLimitReachedType: 'credits_depleted' };
    const hook = renderHook(() => useCodexRateLimitReset(value, refresh));
    expect(hook.result.current.canReset).toBe(false);
    await act(async () => hook.result.current.reset());
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});
