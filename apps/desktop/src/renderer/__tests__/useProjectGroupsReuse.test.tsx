// @vitest-environment jsdom
import { memo } from 'react';
import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { useProjectGroups } from '@/features/cc-agent/hooks/useProjectGroups';
import { sessionCardVisualCases } from '@/features/cc-agent/sidebar/__fixtures__/sessionCardVisualCases';

const state = vi.hoisted(() => ({ hosts: [] as unknown[], bots: [] as unknown[] }));
vi.mock('@/hooks/useRemoteSshHosts', () => ({ useRemoteSshHosts: () => state.hosts }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => state.bots }));
afterEach(cleanup);
const sessions = Array.from({ length: 1000 }, (_, i) => ({
  ...sessionCardVisualCases[0].session,
  id: `task-${i}`,
  pinnedAt: null,
  workingDir: `/projects/project-${i % 25}`,
}));

describe('project grouping hook references', () => {
  it('updates one project and one row on a timestamp patch; selection updates two rows', () => {
    let rowRenders = 0;
    const Row = memo(({ session, active }: { session: Session; active: boolean }) => {
      rowRenders++;
      return (
        <div data-active={active}>
          {session.id}:{session.updatedAt}
        </div>
      );
    });
    function Sidebar({ rows, selected }: { rows: Session[]; selected: string }) {
      const groups = useProjectGroups(rows);
      return groups.projects.map((p) => (
        <section key={p.projectKey}>
          {p.sessions.map((s) => (
            <Row key={s.id} session={s} active={s.id === selected} />
          ))}
        </section>
      ));
    }
    const view = render(<Sidebar rows={sessions} selected="task-0" />);
    expect(rowRenders).toBe(1000);
    const next = sessions.slice();
    next[1] = { ...next[1], updatedAt: '2026-09-15T00:00:00.000Z' };
    rowRenders = 0;
    view.rerender(<Sidebar rows={next} selected="task-0" />);
    expect(rowRenders).toBe(1);
    expect(view.container.textContent).toContain('2026-09-15T00:00:00.000Z');
    rowRenders = 0;
    view.rerender(<Sidebar rows={next} selected="task-2" />);
    expect(rowRenders).toBe(2);
  });

  it('keeps enriched projects stable and shares identical filtered results', () => {
    const { result, rerender } = renderHook(
      ({ rows }) => {
        const all = useProjectGroups(rows);
        const filtered = useProjectGroups(rows, undefined, false, undefined, '', all);
        return { all, filtered };
      },
      { initialProps: { rows: sessions } },
    );
    const before = result.current.all;
    expect(result.current.filtered).toBe(before);
    const rows = sessions.slice();
    rows[1] = { ...rows[1], updatedAt: '2026-09-15T00:00:00.000Z' };
    rerender({ rows });
    expect(result.current.filtered).toBe(result.current.all);
    expect(result.current.all.projects.filter((p, i) => p === before.projects[i])).toHaveLength(24);
  });
  it('refreshes cached machine labels when another device stops sharing its name', () => {
    const rows = sessions.slice(0, 2).map((s, i) => ({
      ...s,
      deviceLinkDeviceId: `device-${i}`,
      deviceLinkDeviceName: 'Same machine',
    }));
    const { result, rerender } = renderHook(({ rows }) => useProjectGroups(rows), {
      initialProps: { rows },
    });
    expect(result.current.projects.every((p) => p.remoteMachineIdentity?.detail)).toBe(true);
    const next = rows.slice();
    next[1] = { ...next[1], deviceLinkDeviceName: 'Renamed machine' };
    rerender({ rows: next });
    expect(result.current.projects.every((p) => p.remoteMachineIdentity?.detail === null)).toBe(
      true,
    );
    expect(
      result.current.projects.some((p) => p.remoteMachineIdentity?.label === 'Renamed machine'),
    ).toBe(true);
  });
});
