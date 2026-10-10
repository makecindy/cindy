// @vitest-environment jsdom
/**
 * 本机供应商组快照按账号隔离：换账号后不沿用旧账号的组，旧账号迟到的读取结果丢弃。
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __testing as ownerTesting, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ProviderGroupConfig } from '../../../../shared/providerGroup';
import { __testing, useLocalProviderGroups } from '../useLocalProviderGroups';

function group(label: string): Record<string, ProviderGroupConfig> {
  return { anthropic: { members: [{ key: 'local', label }] } as unknown as ProviderGroupConfig };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let command: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __testing.reset();
  ownerTesting.reset();
  setDataOwnerGeneration('owner-a', 1);
  command = vi.fn();
  Object.assign(window, { electronAPI: { providerGroup: { command, onChanged: () => () => undefined } } });
});

afterEach(() => {
  cleanup();
  __testing.reset();
  ownerTesting.reset();
});

describe('useLocalProviderGroups', () => {
  it('drops the previous account groups after switching accounts and reads the new account', async () => {
    command.mockResolvedValueOnce(group('A'));
    const first = renderHook(() => useLocalProviderGroups());
    await waitFor(() => expect(first.result.current.anthropic?.members[0].label).toBe('A'));
    first.unmount();

    const forB = deferred<Record<string, ProviderGroupConfig>>();
    command.mockReturnValueOnce(forB.promise);
    setDataOwnerGeneration('owner-b', 2);
    const second = renderHook(() => useLocalProviderGroups());
    expect(second.result.current).toEqual({});
    await act(async () => {
      forB.resolve(group('B'));
      await forB.promise;
    });
    await waitFor(() => expect(second.result.current.anthropic?.members[0].label).toBe('B'));
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('ignores a late answer that belongs to the previous account', async () => {
    const forA = deferred<Record<string, ProviderGroupConfig>>();
    command.mockReturnValueOnce(forA.promise);
    const first = renderHook(() => useLocalProviderGroups());
    first.unmount();

    command.mockResolvedValueOnce(group('B'));
    setDataOwnerGeneration('owner-b', 2);
    const second = renderHook(() => useLocalProviderGroups());
    await waitFor(() => expect(second.result.current.anthropic?.members[0].label).toBe('B'));
    await act(async () => {
      forA.resolve(group('A'));
      await forA.promise;
    });
    expect(second.result.current.anthropic?.members[0].label).toBe('B');
  });

  it('keeps showing the groups while re-reading after a same-account refresh', async () => {
    command.mockResolvedValueOnce(group('A'));
    const first = renderHook(() => useLocalProviderGroups());
    await waitFor(() => expect(first.result.current.anthropic?.members[0].label).toBe('A'));
    first.unmount();

    const again = deferred<Record<string, ProviderGroupConfig>>();
    command.mockReturnValueOnce(again.promise);
    setDataOwnerGeneration('owner-a', 2);
    const second = renderHook(() => useLocalProviderGroups());
    expect(second.result.current.anthropic?.members[0].label).toBe('A');
    await act(async () => {
      again.resolve(group('A2'));
      await again.promise;
    });
    await waitFor(() => expect(second.result.current.anthropic?.members[0].label).toBe('A2'));
  });
});
