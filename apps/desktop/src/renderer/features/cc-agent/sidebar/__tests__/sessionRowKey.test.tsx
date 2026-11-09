// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

import { SessionEntryRows } from '../SessionEntryList';

vi.mock('../SessionItem', () => ({
  SessionItem: ({ session }: { session: Session }) => (
    <div data-testid="row">{`${session.deviceLinkDeviceId ?? 'local'}:${session.id}`}</div>
  ),
}));
vi.mock('../SessionCard', () => ({ SessionCard: () => null }));
vi.mock('../AutomationSessionGroupItem', () => ({ AutomationSessionGroupItem: () => null }));

function task(id: string, deviceLinkDeviceId?: string): Session {
  return { id, title: id, ...(deviceLinkDeviceId ? { deviceLinkDeviceId } : {}) } as Session;
}

function renderRows(sessions: Session[]) {
  return (
    <SessionEntryRows
      entries={sessions.map((session) => ({ kind: 'session' as const, session }))}
      runningSessionIds={new Set()}
      attachedSessionIds={new Set()}
      notifications={new Set()}
      onSessionClick={() => {}}
      onAction={() => {}}
      onRename={() => {}}
      onTogglePin={() => {}}
      onScheduleAction={() => {}}
    />
  );
}

const rows = () => screen.getAllByTestId('row').map((row) => row.textContent);

describe('sidebar session row identity', () => {
  afterEach(cleanup);

  it('removes the archived local row instead of leaving a stale copy behind', () => {
    const local = task('task-1');
    const remote = task('task-1', 'pc-2');
    const { rerender } = render(renderRows([task('a'), local, task('b'), remote]));
    expect(rows()).toEqual(['local:a', 'local:task-1', 'local:b', 'pc-2:task-1']);

    // 归档本机那条后列表重排：同 key 时 React 会漏删旧行，留下一条点不掉的残影。
    rerender(renderRows([task('b'), remote, task('a')]));
    expect(rows()).toEqual(['local:b', 'pc-2:task-1', 'local:a']);
  });
});
