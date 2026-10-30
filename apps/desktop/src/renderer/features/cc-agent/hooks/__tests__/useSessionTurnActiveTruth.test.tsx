// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { resolveSessionInterruptCandidate } from '../../sessionInterruptBannerModel';

const getSessionTurnActiveOn =
  vi.fn<(sessionId: string, deviceId: string | null) => Promise<boolean>>();
vi.mock('@/lib/makerTransport', () => ({
  getSessionTurnActiveOn: (sessionId: string, deviceId: string | null) =>
    getSessionTurnActiveOn(sessionId, deviceId),
}));

const { useSessionTurnActiveTruth } = await import('../useSessionTurnActiveTruth');

type Props = Parameters<typeof useSessionTurnActiveTruth>[0];

const REMOTE: Props = {
  sessionId: 'rs',
  activeTurnStartedAt: 2_000,
  deviceId: 'dev-1',
  online: true,
};

/** 与视图同口径:被控端写下 started > ended,活动镜像尚未回放(控制端刚重启)。 */
function bannerShown(truth: boolean | null): boolean {
  return resolveSessionInterruptCandidate({
    acked: false,
    remoteTurnActive: false,
    mainTurnActive: truth,
    activeTurnStartedAt: 2_000,
    lastTurnEndedAt: 1_000,
    clearedAtMs: null,
  });
}

beforeEach(() => {
  getSessionTurnActiveOn.mockReset();
});
afterEach(cleanup);

it('被控端答在跑:不显示中断横幅', async () => {
  getSessionTurnActiveOn.mockResolvedValue(true);
  const { result } = renderHook(() => useSessionTurnActiveTruth(REMOTE));
  await waitFor(() => expect(result.current).toBe(true));
  expect(getSessionTurnActiveOn).toHaveBeenCalledWith('rs', 'dev-1');
  expect(bannerShown(result.current)).toBe(false);
});

it('被控端答没在跑:真中断,显示横幅', async () => {
  getSessionTurnActiveOn.mockResolvedValue(false);
  const { result } = renderHook(() => useSessionTurnActiveTruth(REMOTE));
  await waitFor(() => expect(result.current).toBe(false));
  expect(bannerShown(result.current)).toBe(true);
});

it('隧道失败按未确认:不显示横幅;链路恢复在线后重查并显示', async () => {
  getSessionTurnActiveOn.mockRejectedValueOnce(new Error('[DEVICE_OFFLINE]'));
  const { result, rerender } = renderHook((props: Props) => useSessionTurnActiveTruth(props), {
    initialProps: REMOTE,
  });
  await waitFor(() => expect(getSessionTurnActiveOn).toHaveBeenCalledTimes(1));
  expect(result.current).toBeNull();
  expect(bannerShown(result.current)).toBe(false);

  // 离线期间不查询(必然失败),保持未确认。
  rerender({ ...REMOTE, online: false });
  expect(getSessionTurnActiveOn).toHaveBeenCalledTimes(1);
  expect(result.current).toBeNull();

  getSessionTurnActiveOn.mockResolvedValueOnce(false);
  rerender(REMOTE);
  await waitFor(() => expect(result.current).toBe(false));
  expect(getSessionTurnActiveOn).toHaveBeenCalledTimes(2);
  expect(bannerShown(result.current)).toBe(true);
});

it('切会话时旧会话的真值不串到新会话', async () => {
  getSessionTurnActiveOn.mockResolvedValueOnce(true);
  const { result, rerender } = renderHook((props: Props) => useSessionTurnActiveTruth(props), {
    initialProps: REMOTE,
  });
  await waitFor(() => expect(result.current).toBe(true));

  let resolveNext!: (v: boolean) => void;
  getSessionTurnActiveOn.mockReturnValueOnce(
    new Promise((r) => {
      resolveNext = r;
    }),
  );
  rerender({ ...REMOTE, sessionId: 'rs-2' });
  expect(result.current).toBeNull();
  await act(async () => resolveNext(false));
  expect(result.current).toBe(false);
});

it('没有在飞候选时不查询', () => {
  const { result } = renderHook(() =>
    useSessionTurnActiveTruth({ ...REMOTE, activeTurnStartedAt: null }),
  );
  expect(result.current).toBeNull();
  expect(getSessionTurnActiveOn).not.toHaveBeenCalled();
});
