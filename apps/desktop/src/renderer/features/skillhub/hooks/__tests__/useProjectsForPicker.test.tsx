// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { SkillhubTarget } from '../../SkillhubTargetContext';
import { setProvisionalDraftTaskId } from '@/features/cc-agent/lib/provisionalDraftTaskId';
import { useProjectsForPicker } from '../useProjectsForPicker';

const source = vi.hoisted(() => ({ sessions: [] as Session[], target: null as SkillhubTarget | null }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: source.sessions, isLoading: false }) }));
vi.mock('../../SkillhubTargetContext', () => ({ useSkillhubTarget: () => source.target }));

afterEach(() => {
  cleanup();
  setProvisionalDraftTaskId(null);
  source.target = null;
});

function draftRows() {
  source.sessions = [{
    id: 'draft', workingDir: '/workspace/new-project', workspaceKind: 'project',
    status: 'active', userSendAt: null, pinnedAt: null, _count: { messages: 0 },
    createdAt: '2026-10-23T10:00:00Z', updatedAt: '2026-10-23T10:00:00Z',
  } as Session];
}

// PR #6956 review: InstallTargetPicker's existing tests replace this hook, and
// pure grouping tests cannot observe a mounted picker updating with unchanged
// session rows. This jsdom unit file exercises that subscription and the remote
// target override, keeping the node grouping suite independent of React.
it('updates install projects when only the provisional identity changes', () => {
  draftRows();
  const { result } = renderHook(useProjectsForPicker);
  expect(result.current.projects).toEqual([]);
  act(() => setProvisionalDraftTaskId('draft'));
  expect(result.current.projects.map((p) => p.projectRoot)).toEqual(['/workspace/new-project']);
  act(() => setProvisionalDraftTaskId(null));
  expect(result.current.projects).toEqual([]);
});

it('keeps the first-send project when the picker mounts with a late draft snapshot', () => {
  draftRows();
  setProvisionalDraftTaskId('draft');
  setProvisionalDraftTaskId(null, true);
  const { result } = renderHook(useProjectsForPicker);
  expect(result.current.projects.map((p) => p.projectRoot)).toEqual(['/workspace/new-project']);
});

it('continues using the selected remote computer project catalogue', () => {
  draftRows();
  const projects = [{ projectRoot: '/remote/project', displayName: 'remote' }];
  source.target = { projects, state: { bootstrapped: true } } as SkillhubTarget;
  const { result } = renderHook(useProjectsForPicker);
  act(() => setProvisionalDraftTaskId('draft'));
  expect(result.current).toEqual({ projects, loading: false });
});
