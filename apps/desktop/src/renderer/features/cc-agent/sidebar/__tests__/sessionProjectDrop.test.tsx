// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '../../lib/projectGrouping';
import {
  startSessionDrag,
  getActiveSessionDrag,
  SPLIT_GROUP_SESSION_MIME,
} from '../../splitGroupDnd';
import { resolveSessionProjectDrop } from '../sessionProjectDrop';
import { PROJECT_DROP_HOVER_MS, useSessionProjectDrop } from '../useSessionProjectDrop';

const task = {
  id: 'task',
  title: 'Task',
  status: 'active',
  workingDir: '/projects/a',
  workspaceKind: 'project',
  _count: { messages: 2 },
} as Session;
const project = {
  projectKey: '/projects/b',
  workingDir: '/projects/b',
  scope: 'local',
  remoteHostId: null,
  deviceLinkDeviceId: null,
  deviceLinkConnectionStatus: null,
} as ProjectNode;

afterEach(() => {
  fireEvent.dragEnd(window);
  cleanup();
  vi.useRealTimers();
});

describe('project drop destinations', () => {
  it('moves within the owner computer and keeps dialogue separate from its execution directory', () => {
    expect(resolveSessionProjectDrop(task, { kind: 'project', project })).toEqual({
      kind: 'project',
      workingDir: project.workingDir,
    });
    expect(resolveSessionProjectDrop(task, { kind: 'dialogue' })).toEqual({ kind: 'dialogue' });
    expect(
      resolveSessionProjectDrop(
        { ...task, workingDir: project.workingDir },
        { kind: 'project', project },
      ),
    ).toBeNull();
    expect(
      resolveSessionProjectDrop(
        { ...task, workspaceKind: 'dialogue', workingDir: project.workingDir },
        { kind: 'project', project },
      ),
    ).not.toBeNull();
  });

  it('never treats a path on another computer as a same-computer destination', () => {
    const remote = { ...task, deviceLinkDeviceId: 'owner' };
    expect(resolveSessionProjectDrop(remote, { kind: 'project', project })).toBeNull();
    expect(
      resolveSessionProjectDrop(task, {
        kind: 'project',
        project: { ...project, deviceLinkDeviceId: 'owner' },
      }),
    ).toBeNull();
    expect(
      resolveSessionProjectDrop(remote, {
        kind: 'project',
        project: { ...project, deviceLinkDeviceId: 'other' },
      }),
    ).toBeNull();
    expect(
      resolveSessionProjectDrop(remote, {
        kind: 'project',
        project: { ...project, deviceLinkDeviceId: 'owner' },
      }),
    ).not.toBeNull();
    expect(resolveSessionProjectDrop(remote, { kind: 'dialogue', deviceId: null })).toBeNull();
    expect(
      resolveSessionProjectDrop(remote, { kind: 'dialogue', deviceId: 'owner' }),
    ).not.toBeNull();
  });

  it.each([
    { status: 'archived' },
    { status: 'deleted' },
    { remoteHostId: 'ssh' },
    { agentDeviceId: 'provider-device' },
    { source: 'review' },
    { source: 'bot' },
    { orcaRole: 'worker' },
    { deviceLinkDeviceId: 'owner', deviceLinkConnectionStatus: 'disconnected' },
  ] as Partial<Session>[])('retains existing move restrictions: %o', (patch) => {
    expect(resolveSessionProjectDrop({ ...task, ...patch }, { kind: 'dialogue' })).toBeNull();
    expect(resolveSessionProjectDrop({ ...task, ...patch }, { kind: 'project', project })).toBeNull();
  });
});

function dataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: '',
    dropEffect: '',
    get types() {
      return [...data.keys()];
    },
    setData: (key: string, value: string) => data.set(key, value),
    getData: (key: string) => data.get(key) ?? '',
    clearData: () => data.clear(),
  };
}

function Harness({
  move,
  expand,
  bubble,
  session = task,
}: {
  move: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  bubble: ReturnType<typeof vi.fn>;
  session?: Session;
}) {
  const drop = useSessionProjectDrop({
    getSession: (id) => (id === session.id ? session : undefined),
    getProject: (key) => (key === project.projectKey ? project : undefined),
    expandProject: expand,
    onMoveSession: move,
  });
  return (
    <div
      onDragOverCapture={drop.onDragOverCapture}
      onDropCapture={drop.onDropCapture}
      onDragLeaveCapture={drop.onDragLeaveCapture}
    >
      <div
        data-testid="source"
        draggable
        onDragStart={(event) =>
          startSessionDrag(event, {
            sessionId: session.id,
            enabled: true,
            needsDedicatedHandle: false,
          })
        }
      />
      <div data-testid="project" data-session-project-drop={project.projectKey} onDrop={bubble}>
        <span data-testid="child">Project B</span>
      </div>
      {drop.showDialogueDrop && (
        <div data-testid="dialogue" data-session-dialogue-drop="source">
          Dialogue
        </div>
      )}
    </div>
  );
}

describe('project drag interaction', () => {
  it.each(['bot', 'review'] as const)('does not advertise or accept a %s task move', (source) => {
    vi.useFakeTimers();
    const move = vi.fn(), expand = vi.fn(), bubble = vi.fn();
    render(<Harness move={move} expand={expand} bubble={bubble} session={{ ...task, source }} />);
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('source'), { dataTransfer: transfer });
    expect(screen.queryByTestId('dialogue')).toBeNull();
    fireEvent.dragOver(screen.getByTestId('child'), { dataTransfer: transfer });
    act(() => vi.advanceTimersByTime(PROJECT_DROP_HOVER_MS));
    expect(screen.getByTestId('project').dataset.sessionProjectDropActive).toBeUndefined();
    expect(expand).not.toHaveBeenCalled();
    fireEvent.drop(screen.getByTestId('child'), { dataTransfer: transfer });
    expect(move).not.toHaveBeenCalled();
  });

  it('highlights, expands after hover, and moves once before pinned sorting receives the drop', () => {
    vi.useFakeTimers();
    const move = vi.fn(),
      expand = vi.fn(),
      bubble = vi.fn();
    render(<Harness move={move} expand={expand} bubble={bubble} />);
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('source'), { dataTransfer: transfer });
    expect(screen.getByTestId('dialogue')).toBeTruthy();
    fireEvent.dragOver(screen.getByTestId('child'), { dataTransfer: transfer });
    expect(screen.getByTestId('project').dataset.sessionProjectDropActive).toBe('true');
    expect(transfer.dropEffect).toBe('move');
    act(() => vi.advanceTimersByTime(PROJECT_DROP_HOVER_MS));
    expect(expand).toHaveBeenCalledWith(project.projectKey);
    fireEvent.drop(screen.getByTestId('child'), { dataTransfer: transfer });
    expect(move).toHaveBeenCalledExactlyOnceWith(task.id, {
      kind: 'project',
      workingDir: project.workingDir,
    });
    expect(bubble).not.toHaveBeenCalled();
    expect(screen.getByTestId('project').dataset.sessionProjectDropActive).toBeUndefined();
  });

  it('offers a dialogue target even when there are no existing dialogue rows', () => {
    const move = vi.fn();
    render(<Harness move={move} expand={vi.fn()} bubble={vi.fn()} />);
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('source'), { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId('dialogue'), { dataTransfer: transfer });
    expect(move).toHaveBeenCalledExactlyOnceWith(task.id, { kind: 'dialogue' });
  });

  it('cancels hover expansion and highlight on Escape and does not consume unrelated project/file drags', () => {
    vi.useFakeTimers();
    const move = vi.fn(),
      expand = vi.fn(),
      bubble = vi.fn();
    render(<Harness move={move} expand={expand} bubble={bubble} />);
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('source'), { dataTransfer: transfer });
    fireEvent.dragOver(screen.getByTestId('child'), { dataTransfer: transfer });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(getActiveSessionDrag()).toBeNull();
    expect(screen.queryByTestId('dialogue')).toBeNull();
    act(() => vi.advanceTimersByTime(PROJECT_DROP_HOVER_MS));
    expect(expand).not.toHaveBeenCalled();
    expect(screen.getByTestId('project').dataset.sessionProjectDropActive).toBeUndefined();
    transfer.clearData();
    transfer.setData('Files', 'file');
    fireEvent.drop(screen.getByTestId('child'), { dataTransfer: transfer });
    expect(bubble).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    expect(transfer.types).not.toContain(SPLIT_GROUP_SESSION_MIME);
  });
});
