// @vitest-environment jsdom
/**
 * 本机供应商组快照按当前数据归属账号隔离(provider-groups.md §10)：换账号后清空并重读，
 * 旧账号迟到的读取结果丢弃——否则同一 Renderer 里从账号 A 切到 B 后，模型列表与设置页会拿
 * A 的组成员键去收起 B 的供应商与分享，直到重启或任一组被编辑。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig } from '../../../../shared/providerGroup';
import { __testing, setLocalProviderGroupsOwner, useLocalProviderGroups } from '../useLocalProviderGroups';

const GROUP = {
  strategy: 'least',
  autoSwitch: true,
  members: [
    { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false },
  ],
} as unknown as ProviderGroupConfig;

const state = vi.hoisted(() => ({
  commands: 0,
  calls: [] as Array<{ resolve: (groups: unknown) => void; reject: (error: unknown) => void }>,
  changed: null as null | (() => void),
}));

beforeEach(() => {
  state.commands = 0;
  state.calls.length = 0;
  state.changed = null;
  Object.assign(window, {
    electronAPI: {
      providerGroup: {
        command: () => {
          state.commands += 1;
          return new Promise((res, rej) => state.calls.push({ resolve: res, reject: rej }));
        },
        onChanged: (callback: () => void) => {
          state.changed = callback;
          return () => undefined;
        },
      },
    },
  });
  __testing.reset();
});

afterEach(() => {
  __testing.reset();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('useLocalProviderGroups', () => {
  it('reads the groups once and shares the snapshot between components', async () => {
    const first = renderHook(() => useLocalProviderGroups());
    const second = renderHook(() => useLocalProviderGroups());
    await waitFor(() => expect(state.calls.length).toBe(1));
    await act(async () => state.calls[0].resolve({ a: GROUP }));
    await waitFor(() => expect(first.result.current).toEqual({ a: GROUP }));
    expect(second.result.current).toEqual({ a: GROUP });
  });

  it('clears and re-reads the snapshot when the account changes', async () => {
    setLocalProviderGroupsOwner('owner-a');
    const hook = renderHook(() => useLocalProviderGroups());
    await waitFor(() => expect(state.calls.length).toBe(1));
    await act(async () => state.calls[0].resolve({ a: GROUP }));
    await waitFor(() => expect(hook.result.current).toEqual({ a: GROUP }));

    act(() => setLocalProviderGroupsOwner('owner-b'));
    // 上一个账号的组立刻不再参与收起，再按新账号重读。
    expect(hook.result.current).toEqual({});
    await waitFor(() => expect(state.calls.length).toBe(2));
    await act(async () => state.calls[1].resolve({ b: GROUP }));
    await waitFor(() => expect(hook.result.current).toEqual({ b: GROUP }));
  });

  it('drops a read that was already in flight when the account changed', async () => {
    const hook = renderHook(() => useLocalProviderGroups());
    await waitFor(() => expect(state.calls.length).toBe(1));
    await act(async () => state.calls[0].resolve({ a: GROUP }));
    await waitFor(() => expect(hook.result.current).toEqual({ a: GROUP }));

    // 旧账号的重读在途时换账号：旧结果到达也不能写进新账号的快照。
    act(() => state.changed?.());
    await waitFor(() => expect(state.calls.length).toBe(2));
    act(() => setLocalProviderGroupsOwner('owner-b'));
    await waitFor(() => expect(state.calls.length).toBe(3));
    await act(async () => state.calls[1].resolve({ stale: GROUP }));
    expect(hook.result.current).toEqual({});
    await act(async () => state.calls[2].resolve({ b: GROUP }));
    await waitFor(() => expect(hook.result.current).toEqual({ b: GROUP }));
    expect(hook.result.current).not.toHaveProperty('stale');
  });

  it('is reset from AuthContext on account switches', () => {
    const authSource = readFileSync(resolve(__dirname, '../../../contexts/AuthContext.tsx'), 'utf8');
    expect(authSource).toContain('setLocalProviderGroupsOwner(state.dataOwnerId);');
  });
});
