// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { usePublicationFeedback, useRejectionFeedback } from '../useRejectionFeedback';
import { effectivePublishedStatus, effectivePublishedStatusVersion } from '../../lib/publishedStatus';

const target = { entryKey: 'local:helper', name: 'helper', version: '1.1.0', canManage: true };
const response = { success: true, status: 'rejected', gates: [], rejectionReason: 'Remove private notes' };
const getScanStatus = vi.fn();

beforeEach(() => {
  setDataOwnerGeneration('owner-a', 1);
  getScanStatus.mockReset().mockResolvedValue(response);
  vi.stubGlobal('electronAPI', { skillhub: { getScanStatus } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('automatic publication feedback', () => {
  it('keeps visible results through ordinary same-owner refreshes and supports dismissing them', () => {
    const { result, rerender } = renderHook(() => usePublicationFeedback(target.entryKey));
    act(() => result.current.setResult(response));
    rerender();
    expect(result.current.result?.rejectionReason).toBe(response.rejectionReason);
    act(() => result.current.setResult(null));
    expect(result.current.result).toBeNull();
  });

  it('hides stored reasons during the first render after a same-id realm generation change', () => {
    const renderedReasons: Array<string | undefined> = [];
    const { result, rerender } = renderHook(() => {
      const feedback = usePublicationFeedback(target.entryKey);
      renderedReasons.push(feedback.result?.rejectionReason);
      return feedback;
    });
    act(() => result.current.setResult(response));
    const oldDelivery = result.current.setResult;
    setDataOwnerGeneration('owner-a', 2);
    renderedReasons.length = 0;
    rerender();
    expect(renderedReasons).toEqual([undefined]);
    act(() => oldDelivery(response));
    expect(result.current.result).toBeNull();
    act(() => result.current.setResult({ ...response, rejectionReason: 'Current realm feedback' }));
    expect(result.current.result?.rejectionReason).toBe('Current realm feedback');
  });

  it('does not reuse stored feedback or an old callback for another entry', () => {
    const { result, rerender } = renderHook(key => usePublicationFeedback(key), { initialProps: target.entryKey });
    act(() => result.current.setResult(response));
    const oldDelivery = result.current.setResult;
    rerender('local:another');
    expect(result.current.result).toBeNull();
    act(() => oldDelivery(response));
    expect(result.current.result).toBeNull();
  });
});

describe('useRejectionFeedback', () => {
  it.each(['local', 'team'])('requests the native rejected version for a %s entry and shows manual feedback', async (catalog) => {
    const { result } = renderHook(() => useRejectionFeedback({ ...target, entryKey: `${catalog}:helper` }));
    await act(() => result.current.open());
    expect(getScanStatus).toHaveBeenCalledWith({ slug: 'helper', version: '1.1.0' });
    expect(result.current.result).toEqual({
      status: 'rejected', gates: [], rejectionReason: 'Remove private notes',
    });
  });

  it.each([
    ['new version', { version: '1.2.0' }],
    ['permission revoked', { canManage: false }],
    ['review status changed', { version: null }],
    ['different entry', { entryKey: 'team:helper' }],
  ])('drops a late response after %s', async (_label, change) => {
    let resolveRequest!: (value: typeof response) => void;
    getScanStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { result, rerender } = renderHook((props) => useRejectionFeedback(props), {
      initialProps: { ...target, version: target.version as string | null },
    });
    let request!: Promise<void>;
    act(() => { request = result.current.open(); });
    rerender({ ...target, ...change });
    await act(async () => { resolveRequest(response); await request; });
    expect(result.current.result).toBeNull();
  });

  it('clears visible feedback when management permission is revoked', async () => {
    const { result, rerender } = renderHook((props) => useRejectionFeedback(props), { initialProps: target });
    await act(() => result.current.open());
    expect(result.current.result?.rejectionReason).toBe(response.rejectionReason);
    rerender({ ...target, canManage: false });
    expect(result.current.result).toBeNull();
    await act(() => result.current.open());
    expect(getScanStatus).toHaveBeenCalledTimes(1);
  });

  it('drops an old account generation response before React rerenders, including a return to the same owner', async () => {
    let resolveRequest!: (value: typeof response) => void;
    getScanStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { result } = renderHook(() => useRejectionFeedback(target));
    let request!: Promise<void>;
    act(() => { request = result.current.open(); });
    setDataOwnerGeneration('owner-b', 2);
    setDataOwnerGeneration('owner-a', 3);
    await act(async () => { resolveRequest(response); await request; });
    expect(result.current.result).toBeNull();
  });

  it('does not reopen feedback after the user dismisses a pending request', async () => {
    let resolveRequest!: (value: typeof response) => void;
    getScanStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { result } = renderHook(() => useRejectionFeedback(target));
    let request!: Promise<void>;
    act(() => { request = result.current.open(); });
    act(() => result.current.dismiss());
    await act(async () => { resolveRequest(response); await request; });
    expect(result.current.result).toBeNull();
  });

  describe.each(['rejected', 'failed', 'blocked'])('a manageable version with native status %s', (status) => {
    const source = { latestVersion: target.version, moderationStatus: status };
    const version = effectivePublishedStatus(source) === 'rejected' ? effectivePublishedStatusVersion(source) : null;

    it.each(['exception', 'error response'])('does not invent manual rejection on lookup %s', async (failure) => {
      if (failure === 'exception') getScanStatus.mockRejectedValueOnce(new Error('Unavailable'));
      else getScanStatus.mockResolvedValueOnce({ success: false, error: 'Unavailable' });
      const { result } = renderHook(() => useRejectionFeedback({ ...target, version }));
      await act(() => result.current.open());
      expect(getScanStatus).toHaveBeenCalledWith({ slug: target.name, version: target.version });
      expect(result.current.result).toEqual({
        status: 'scan_status_unavailable', gates: [{ name: 'scan-status', status: 'unavailable' }],
      });
    });

    it('preserves the native status when lookup succeeds without a rejection reason', async () => {
      getScanStatus.mockResolvedValueOnce({ success: true, status, gates: [] });
      const { result } = renderHook(() => useRejectionFeedback({ ...target, version }));
      await act(() => result.current.open());
      expect(result.current.result).toEqual({ status, gates: [], rejectionReason: undefined });
    });
  });
});
