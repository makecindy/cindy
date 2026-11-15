import { restoreNewSessionDraft } from '@/session/newSessionForm';
import type { RemoteSerializedAttachment } from '@/session/types';
import { newSessionAttachment } from './fixtures/newSession';
import { expect, it, vi } from 'vitest';
import { DEFAULT_NEW_SESSION_DRAFT } from '../session/newSession';

// Unit: restore the production form boundary; recovered text, Plan and remote Agent
// must be available before the next composer event (mobile-development: creation recovery).
function fixture() {
  const state = { draft: { ...DEFAULT_NEW_SESSION_DRAFT }, selection: { start: 0, end: 0 }, plan: false, files: [] as RemoteSerializedAttachment[] };
  const bindings = {
    useCallback: (fn: unknown) => fn,
    userTouchedWorkspaceRef: { current: false }, userTouchedRuntimeRef: { current: false },
    appliedPermissionMemoryRef: { current: false }, runtimeActionSeqRef: { current: 10 },
    firstMessageRef: { current: '' }, firstMessageSelectionRef: { current: state.selection },
    attachmentsRef: { current: state.files }, prePlanPermissionModeRef: { current: null as string | null },
    setFirstMessageSelection: (value: typeof state.selection) => { state.selection = value; },
    setAttachments: (value: RemoteSerializedAttachment[]) => { state.files = value; },
    setPlanModeDraftOn: (value: boolean) => { state.plan = value; },
    setDraft: vi.fn((value: typeof state.draft) => { state.draft = value; }),
    setRemoteAgentChoice: vi.fn(),
  };
  const apply = (...args: Parameters<typeof restoreNewSessionDraft> extends [unknown, ...infer Rest] ? Rest : never) =>
    restoreNewSessionDraft(bindings, ...args);
  return { ...bindings, state, apply };
}

it.each([true, false])('restores Plan=%s and makes recovered text immediately available to composer actions', (enabled) => {
  const f = fixture();
  const draft = { ...DEFAULT_NEW_SESSION_DRAFT, firstMessage: 'Recovered message', model: 'saved-model', permissionMode: 'ask' };
  const files = [newSessionAttachment({ id: 'saved-file' })];
  f.apply(draft, files, { enabled, restorePermissionMode: 'ask' });
  // Slash/mention/voice actions read these refs before another text-change event.
  const caret = f.firstMessageSelectionRef.current.end;
  const edited = f.firstMessageRef.current.slice(0, caret) + ' appended' + f.firstMessageRef.current.slice(caret);
  expect(edited).toBe('Recovered message appended');
  expect(f.state.selection).toEqual({ start: draft.firstMessage.length, end: draft.firstMessage.length });
  expect(f.state.plan).toBe(enabled);
  expect(f.prePlanPermissionModeRef.current).toBe('ask');
  expect(f.state.draft).toEqual(draft);
  expect(f.attachmentsRef.current).toBe(files);
  expect(f.state.files).toBe(files);
  expect(f.userTouchedWorkspaceRef.current && f.userTouchedRuntimeRef.current && f.appliedPermissionMemoryRef.current).toBe(true);
  // A previously captured runtime preference continuation is now stale.
  expect(f.runtimeActionSeqRef.current).not.toBe(10);
});

it('splits a saved remote Agent back into the remote choice and leaves the draft local', () => {
  const f = fixture();
  const saved = { ...DEFAULT_NEW_SESSION_DRAFT, firstMessage: 'hi', agentKind: 'codex' as const, model: 'gpt-5.5',
    providerId: 'openai', effort: 'high', fastMode: true, agentDeviceId: 'share:s1' };
  f.apply(saved, [], undefined, 'controlled-a');
  expect(f.state.draft).not.toHaveProperty('agentDeviceId');
  expect(f.setRemoteAgentChoice).toHaveBeenCalledWith({
    controlledDeviceId: 'controlled-a',
    pick: { deviceId: 'share:s1', agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai', effort: 'high', fastMode: true },
  });
  f.apply({ ...DEFAULT_NEW_SESSION_DRAFT, firstMessage: 'local' }, []);
  expect(f.setRemoteAgentChoice).toHaveBeenLastCalledWith(null);
});

it('uses the same text recovery without inventing a Plan snapshot for legacy stashes', () => {
  const f = fixture();
  f.state.plan = true;
  f.apply({ ...DEFAULT_NEW_SESSION_DRAFT, firstMessage: 'legacy draft' }, []);
  expect(f.firstMessageRef.current).toBe('legacy draft');
  expect(f.state.plan).toBe(true);
});
