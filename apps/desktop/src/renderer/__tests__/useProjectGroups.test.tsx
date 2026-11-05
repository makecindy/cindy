// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { useProjectGroups } from '@/features/cc-agent/hooks/useProjectGroups';
import i18n from '@/i18n';

const registry = vi.hoisted(() => ({ hosts: [] as RemoteHostSnapshot[], bots: [] }));
vi.mock('@/hooks/useRemoteSshHosts', () => ({ useRemoteSshHosts: () => registry.hosts }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => registry.bots }));
beforeEach(() => {
  registry.hosts = [];
});
afterEach(cleanup);

function task(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    workingDir: `/workspace/${id}`,
    workspaceKind: 'project',
    status: 'active',
    pinnedAt: null,
    userSendAt: '2026-08-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    _count: { messages: 1 },
    ...patch,
  } as Session;
}

it('preserves untouched enriched project nodes through row-only updates', () => {
  const rows = [task('a'), task('b')];
  const { result, rerender } = renderHook(({ rows }) => useProjectGroups(rows), {
    initialProps: { rows },
  });
  const before = result.current.projects;
  const updated = { ...rows[0], title: 'latest' };
  rerender({ rows: [updated, rows[1]] });
  expect(result.current.projects[0].sessions[0]).toBe(updated);
  expect(result.current.projects[1]).toBe(before[1]);
});

it('refreshes SSH labels when only the registry changes', () => {
  const rows = [task('a', { remoteHostId: 'remote' })];
  const { result, rerender } = renderHook(() => useProjectGroups(rows));
  expect(result.current.projects[0].remoteMachineIdentity?.label).toBe('remote');
  registry.hosts = [
    { config: { id: 'remote', displayName: 'Build Mac', user: 'u', hostname: 'host', port: 22 } },
  ] as RemoteHostSnapshot[];
  rerender();
  expect(result.current.projects[0].remoteMachineIdentity?.displayLabel).toBe(
    'Build Mac (remote) · u@host',
  );
});

it('updates collision labels when another device starts or stops sharing the name', () => {
  const rows = [
    task('a', { deviceLinkDeviceId: 'one', deviceLinkDeviceName: 'Mac' }),
    task('b', { deviceLinkDeviceId: 'two', deviceLinkDeviceName: 'Other' }),
  ];
  const { result, rerender } = renderHook(({ rows }) => useProjectGroups(rows), {
    initialProps: { rows },
  });
  expect(result.current.projects[0].remoteMachineIdentity?.detail).toBeNull();
  rerender({ rows: [rows[0], { ...rows[1], deviceLinkDeviceName: 'Mac' }] });
  expect(result.current.projects[0].remoteMachineIdentity?.displayLabel).toBe('Mac (1)');
  rerender({ rows });
  expect(result.current.projects[0].remoteMachineIdentity?.detail).toBeNull();
});

it('refreshes cached unnamed labels and reused results when the language changes', async () => {
  const previousLanguage = i18n.language;
  await i18n.changeLanguage('en');
  const rows = [task('a', { deviceLinkDeviceId: 'one', deviceLinkDeviceName: 'one' })];
  try {
    const { result } = renderHook(() => {
      const all = useProjectGroups(rows);
      const filtered = useProjectGroups(rows, undefined, false, undefined, '', all);
      return { all, filtered };
    });
    const before = result.current.all;
    expect(before.projects[0].remoteMachineIdentity?.label).toBe('another computer');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(result.current.all.projects[0].remoteMachineIdentity?.label).toBe('另一台电脑');
    expect(result.current.all).not.toBe(before);
    expect(result.current.filtered).toBe(result.current.all);
  } finally {
    cleanup();
    await i18n.changeLanguage(previousLanguage);
  }
});
