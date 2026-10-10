// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSessionReveal } from '../useWorkspaceSessionReveal';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
afterEach(cleanup);

function options(): Parameters<typeof useWorkspaceSessionReveal>[0] {
  return {
    sessionId: undefined,
    ready: true,
    enabled: true,
    projects: [{ projectKey: 'local:/client', sessions: [{ id: 'first' }, { id: 'second' }] }],
    workspaces: [
      { id: 'business', name: 'Business', projectKeys: ['local:/client'], collapsed: true },
    ],
    collapsedProjects: new Set(['local:/client']),
    comparisonKey: (key) => key,
    onToggleProject: vi.fn(),
    mutateWorkspace: vi.fn().mockResolvedValue(undefined),
  };
}

describe('opening tasks inside workspaces', () => {
  it('opens both collapsed layers when a task is selected from search', () => {
    const props = options();
    const { rerender } = renderHook(useWorkspaceSessionReveal, { initialProps: props });
    rerender({ ...props, sessionId: 'second' });
    expect(props.onToggleProject).toHaveBeenCalledExactlyOnceWith('local:/client');
    expect(props.mutateWorkspace).toHaveBeenCalledExactlyOnceWith({
      type: 'set-collapsed',
      id: 'business',
      collapsed: false,
    });
  });

  it('opens a collapsed project when its workspace is already open', () => {
    const props = options();
    props.workspaces = props.workspaces.map((workspace) => ({ ...workspace, collapsed: false }));
    renderHook(useWorkspaceSessionReveal, { initialProps: { ...props, sessionId: 'first' } });
    expect(props.onToggleProject).toHaveBeenCalledExactlyOnceWith('local:/client');
    expect(props.mutateWorkspace).not.toHaveBeenCalled();
  });

  it('does not toggle an already expanded project back to collapsed', () => {
    const props = options();
    props.collapsedProjects = new Set();
    renderHook(useWorkspaceSessionReveal, { initialProps: { ...props, sessionId: 'first' } });
    expect(props.onToggleProject).not.toHaveBeenCalled();
    expect(props.mutateWorkspace).toHaveBeenCalledOnce();
  });

  it('preserves manual collapse on the current task and reveals a different task later', () => {
    const props = options();
    const { rerender } = renderHook(useWorkspaceSessionReveal, {
      initialProps: { ...props, sessionId: 'first' },
    });
    rerender({ ...props, sessionId: 'first', collapsedProjects: new Set(['local:/client']) });
    expect(props.onToggleProject).toHaveBeenCalledTimes(1);
    expect(props.mutateWorkspace).toHaveBeenCalledTimes(1);
    rerender({ ...props, sessionId: 'second' });
    expect(props.onToggleProject).toHaveBeenCalledTimes(2);
    expect(props.mutateWorkspace).toHaveBeenCalledTimes(2);
  });

  it('waits for owner readiness and asynchronously arriving project data', () => {
    const props = options();
    const { rerender } = renderHook(useWorkspaceSessionReveal, {
      initialProps: { ...props, sessionId: 'first', ready: false },
    });
    expect(props.onToggleProject).not.toHaveBeenCalled();
    rerender({ ...props, sessionId: 'first', projects: [] });
    expect(props.onToggleProject).not.toHaveBeenCalled();
    rerender({ ...props, sessionId: 'first' });
    expect(props.onToggleProject).toHaveBeenCalledExactlyOnceWith('local:/client');
  });

  it('leaves the existing flat view unchanged', () => {
    const props = options();
    renderHook(useWorkspaceSessionReveal, {
      initialProps: { ...props, sessionId: 'first', enabled: false },
    });
    expect(props.onToggleProject).not.toHaveBeenCalled();
    expect(props.mutateWorkspace).not.toHaveBeenCalled();
  });
});
