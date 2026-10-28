// @vitest-environment jsdom
import { i18n } from '@/i18n';
import { act, createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NEW_SESSION_DRAFT,
  buildRecentWorkspaceOptions,
  pickNewSessionDefaultDevice,
  type NewSessionDraft,
  type NewSessionStoredPreferences,
  type NewSessionWorkspaceKind,
} from '@/session/newSession';

import { createInitialNewSessionDraft, patchNewSessionDraft, restoreNewSessionDraft } from '@/session/newSessionForm';
import { useNewSessionStashedDraft, useNewSessionWorkspacePreferences, useNewSessionWorkspaceActions, useNewSessionInitialWorkspace } from '@/session/useNewSessionWorkspace';
import { readNewSessionPreferences, saveNewSessionPreferences } from '@/session/newSessionPreferenceStore';
import type { RemoteSerializedAttachment, RemoteSession } from '@/session/types';
import type { OrcaWorkerFormValue } from '@/session/orcaTeam';

vi.mock('@/session/newSessionPreferenceStore', () => ({
  readNewSessionPreferences: vi.fn(),
  saveNewSessionPreferences: vi.fn(async () => {}),
}));

// Unit: mount production hooks against pending preferences and a visible form.
// #4103 and mobile-development creation recovery: late defaults must not replace
// explicit/restored input or borrow another computer's project directory.
interface WorkspaceState {
  draft: NewSessionDraft;
  firstMessageSelection: { start: number; end: number };
  selectedDeviceId: string;
  newSessionPreferencesLoaded: boolean;
  selectDialogueWorkspace(): void;
  selectRecentProject(path: string): void;
  openProjectBrowse(): void;
  /** 模拟页面 selectDevice 里与工作区相关的部分:标记用户动过设备、重置初始工作区决策、清空项目目录。 */
  switchDevice(deviceId: string): void;
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

function mountWorkspace(options: { initialWorkingDir?: string; restoredKind?: NewSessionWorkspaceKind; collabDraft?: OrcaWorkerFormValue; suggestion?: string; routeDraft?: string | string[]; deviceExplicit?: boolean } = {}) {
  let resolveRead!: (value: NewSessionStoredPreferences) => void;
  const pendingRead = new Promise<NewSessionStoredPreferences>((resolve) => { resolveRead = resolve; });
  const deviceOptions = [{ deviceId: 'a', name: 'A' }, { deviceId: 'b', name: 'B' }];
  const initialWorkingDir = options.initialWorkingDir ?? null;
  const bindings = {
    editRecoveredDraft: vi.fn(), creatingRef: { current: false }, voiceDictionaryLearningTrackerRef: { current: null },
    params: { suggestion: options.suggestion, draft: options.routeDraft, editSessionId: options.restoredKind ? 'failed-task' : undefined }, t: i18n.getFixedT('zh-CN'),
    routeDeviceId: 'a', routeDeviceName: 'A', routeDeviceFallback: deviceOptions[0],
    routeDeviceExplicit: options.deviceExplicit ?? !!initialWorkingDir, deviceOptions, initialWorkingDir, visualInitialDraft: null,
    sessions: deviceOptions.map(({ deviceId }) => ({
      deviceLinkDeviceId: deviceId, workingDir: `/projects/${deviceId}`, workspaceKind: 'project',
      status: 'active', updatedAt: '2026-09-01T00:00:00Z',
    } as RemoteSession)),
    readNewSessionPreferences, saveNewSessionPreferences,
    drainStashedNewSessionDraft: vi.fn((sessionId?: string, deviceId?: string) => options.restoredKind && sessionId === 'failed-task' && deviceId === 'a' ? {
      draft: { ...DEFAULT_NEW_SESSION_DRAFT, workspaceKind: options.restoredKind,
        workingDir: options.restoredKind === 'project' ? '/restored/project' : '',
        firstMessage: 'restored draft' },
      attachments: [], deviceId: 'a', deviceName: 'A', notice: null, collabDraft: options.collabDraft ?? null,
    } : null),
    onRestoreCollab: vi.fn(),
    loadBrowsePath: vi.fn(async () => {}), setDevicePickerOpen: vi.fn(),
    setAttachments: vi.fn(), setAttachmentError: vi.fn(), setBrowseOpen: vi.fn(),
    setBrowseError: vi.fn(), setShowHiddenDirectories: vi.fn(), setWorkspacePickerOpen: vi.fn(),
  };
  vi.mocked(readNewSessionPreferences).mockImplementation(() => pendingRead);
  vi.mocked(saveNewSessionPreferences).mockClear();
  let current!: WorkspaceState;
  const commits: Array<{ device: string; kind: NewSessionWorkspaceKind; path: string }> = [];
  function Harness() {
    const [selectedDeviceId, setSelectedDeviceId] = useState(bindings.routeDeviceId);
    const [, setSelectedDeviceName] = useState(bindings.routeDeviceName);
    const [newSessionPreferences, setNewSessionPreferences] = useState<NewSessionStoredPreferences | null>(null);
    const [newSessionPreferencesLoaded, setNewSessionPreferencesLoaded] = useState(false);
    const [draft, setDraft] = useState(() => createInitialNewSessionDraft({
      initialWorkingDir, visualInitialDraft: null, routeDraft: options.routeDraft,
      suggestion: options.suggestion, t: bindings.t,
    }));
    const workingDirPreferenceOverridesRef = useRef<Record<string, string>>({});
    const initialWorkspaceKeyRef = useRef<string | null>(null);
    const appliedDefaultDeviceKeyRef = useRef<string | null>(null);
    const userTouchedDeviceRef = useRef(false);
    const userTouchedWorkspaceRef = useRef(false);
    const userTouchedRuntimeRef = useRef(false);
    const appliedPermissionMemoryRef = useRef(false);
    const runtimeActionSeqRef = useRef(0);
    const firstMessageRef = useRef(draft.firstMessage);
    const firstMessageSelectionRef = useRef({ start: draft.firstMessage.length, end: draft.firstMessage.length });
    const [firstMessageSelection, setFirstMessageSelection] = useState(firstMessageSelectionRef.current);
    const attachmentsRef = useRef<RemoteSerializedAttachment[]>([]);
    const prePlanPermissionModeRef = useRef<string | null>(null);
    const restoreCreationDraft = useCallback((...args: Parameters<typeof restoreNewSessionDraft> extends [unknown, ...infer Rest] ? Rest : never) => {
      restoreNewSessionDraft({ userTouchedWorkspaceRef, userTouchedRuntimeRef, appliedPermissionMemoryRef,
        runtimeActionSeqRef, firstMessageRef, firstMessageSelectionRef, setFirstMessageSelection,
        attachmentsRef, prePlanPermissionModeRef, setAttachments: bindings.setAttachments,
        setPlanModeDraftOn: () => {}, setRemoteAgentChoice: () => {}, setDraft }, ...args);
    }, []);
    const preferredDefaultDevice = useMemo(() => pickNewSessionDefaultDevice({
      deviceOptions, preferredDeviceId: newSessionPreferences?.device?.deviceId,
      routeDevice: bindings.routeDeviceFallback, routeDeviceExplicit: bindings.routeDeviceExplicit,
    }), [newSessionPreferences]);
    const recentWorkspaces = useMemo(() => buildRecentWorkspaceOptions(
      bindings.sessions.filter(session => session.deviceLinkDeviceId === selectedDeviceId), selectedDeviceId,
    ), [selectedDeviceId]);
    const common = { ...bindings, selectedDeviceId, setSelectedDeviceId, setSelectedDeviceName,
      newSessionPreferences, setNewSessionPreferences, newSessionPreferencesLoaded, setNewSessionPreferencesLoaded,
      workingDirPreferenceOverridesRef, initialWorkspaceKeyRef, appliedDefaultDeviceKeyRef,
      userTouchedDeviceRef, userTouchedWorkspaceRef, draft, setDraft, preferredDefaultDevice };
    useNewSessionStashedDraft({ ...common, sessionId: bindings.params.editSessionId, deviceId: 'a',
      restoreCreationDraft });
    useNewSessionWorkspacePreferences(common);
    const patchDraft = useCallback((patch: Partial<NewSessionDraft>) => patchNewSessionDraft({
      ...bindings, firstMessageRef, setDraft,
    }, patch), []);
    const actions = useNewSessionWorkspaceActions({ ...common, patchDraft });
    useNewSessionInitialWorkspace({ ...common, recentWorkspaces, selectWorkingDir: actions.selectWorkingDir });
    current = { draft, selectedDeviceId, newSessionPreferencesLoaded, firstMessageSelection, ...actions,
      switchDevice: deviceId => {
        userTouchedDeviceRef.current = true;
        initialWorkspaceKeyRef.current = null;
        setSelectedDeviceId(deviceId);
        setDraft(value => value.workspaceKind === 'project' ? { ...value, workingDir: '' } : value);
      },
    };
    useEffect(() => {
      commits.push({ device: current.selectedDeviceId, kind: current.draft.workspaceKind,
        path: current.draft.workingDir });
    });
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Harness)));
  return {
    bindings, commits, get current() { return current; },
    async resolvePreferences(
      kind: NewSessionWorkspaceKind | null,
      deviceId = 'a',
      workingDirByDevice: Record<string, string> = {},
    ) {
      await act(async () => {
        resolveRead({ workspaceKind: kind, device: { deviceId, name: deviceId },
          agentKind: null, permissionModeByAgent: {}, workingDirByDevice, remoteAgentByDevice: {} });
        await pendingRead;
      });
    },
  };
}

describe('new session workspace page effects', () => {
  it.each([undefined, 'findFile'])('keeps the checked recommendation device over a late remembered device (%s)', async (suggestion) => {
    const page = mountWorkspace({ suggestion, deviceExplicit: true });
    await page.resolvePreferences('project', 'b');
    expect(page.current.selectedDeviceId).toBe('a');
  });

  it('prefills a recommendation and preserves it when device/workspace defaults arrive', async () => {
    const page = mountWorkspace({ suggestion: 'findFile' });
    const prompt = i18n.t('devices.list.taskSuggestions.items.findFile.prompt', { lng: 'zh-CN' });
    expect(page.current.draft.firstMessage).toBe(prompt);
    expect(page.current.firstMessageSelection).toEqual({ start: prompt.length, end: prompt.length });
    await page.resolvePreferences('project', 'b');
    expect(page.current.draft.firstMessage).toBe(prompt);
  });

  it('preserves the plugin route draft over recommendations and late preferences', async () => {
    const page = mountWorkspace({ suggestion: 'findFile', routeDraft: '使用练习场学习 DJ' });
    expect(page.current.draft.firstMessage).toBe('使用练习场学习 DJ');
    await page.resolvePreferences('project', 'b');
    expect(page.current.draft.firstMessage).toBe('使用练习场学习 DJ');
  });

  it('leaves an unknown recommendation empty and keeps recovery drafts authoritative', async () => {
    const page = mountWorkspace({ suggestion: 'unknown' });
    expect(page.bindings.drainStashedNewSessionDraft).toHaveBeenCalledExactlyOnceWith(undefined, 'a');
    expect(page.current.draft.firstMessage).toBe(DEFAULT_NEW_SESSION_DRAFT.firstMessage);
    await page.resolvePreferences('dialogue');
    expect(page.current.draft.firstMessage).toBe(DEFAULT_NEW_SESSION_DRAFT.firstMessage);
  });

  it('keeps choices for both devices made before the stored preferences arrive', async () => {
    const page = mountWorkspace();
    act(() => page.current.selectRecentProject(' /manual/a '));
    act(() => page.current.switchDevice('b'));
    act(() => page.current.selectRecentProject('/manual/b'));
    await page.resolvePreferences('project', 'a', { a: '/old/a', b: '/old/b' });
    act(() => page.current.switchDevice('a'));
    expect(page.current.draft.workingDir).toBe(' /manual/a ');
    act(() => page.current.switchDevice('b'));
    expect(page.current.draft.workingDir).toBe('/manual/b');
    expect(page.bindings.saveNewSessionPreferences).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit project entry when a different preference arrives late', async () => {
    const page = mountWorkspace({ initialWorkingDir: '/explicit/project' });
    await page.resolvePreferences('dialogue', 'b');
    expect(page.current.draft).toMatchObject({ workspaceKind: 'project', workingDir: '/explicit/project' });
    expect(page.current.selectedDeviceId).toBe('a');
    expect(page.bindings.loadBrowsePath).not.toHaveBeenCalled();
  });

  it.each(['project', 'dialogue'] as const)('preserves a restored %s draft over a late default', async (kind) => {
    // Creation recovery must restore the associated Worker plan along with the
    // Lead's input; the former page-literal guard could miss a disconnected hook.
    const collabDraft: OrcaWorkerFormValue = {
      role: 'Worker', agent: 'pi', model: null, permissionMode: 'auto', initialTask: 'review changes',
    };
    const page = mountWorkspace({ restoredKind: kind, suggestion: 'findFile', collabDraft });
    expect(page.bindings.drainStashedNewSessionDraft).toHaveBeenCalledExactlyOnceWith('failed-task', 'a');
    await page.resolvePreferences(kind === 'project' ? 'dialogue' : 'project', 'b');
    expect(page.current.draft).toMatchObject({ workspaceKind: kind,
      workingDir: kind === 'project' ? '/restored/project' : '' });
    expect(page.current.selectedDeviceId).toBe('a');
    expect(page.current.firstMessageSelection).toEqual({ start: 'restored draft'.length, end: 'restored draft'.length });
    expect(page.bindings.onRestoreCollab).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deviceId: 'a', collabDraft, draft: expect.objectContaining({ firstMessage: 'restored draft' }),
    }));
  });

  it.each(['project', 'dialogue'] as const)('preserves a manual %s choice made during the read', async (kind) => {
    const page = mountWorkspace();
    act(() => kind === 'project'
      ? page.current.selectRecentProject('/manual/project')
      : page.current.selectDialogueWorkspace());
    await page.resolvePreferences(kind === 'project' ? 'dialogue' : 'project');
    expect(page.current.draft).toMatchObject({ workspaceKind: kind,
      workingDir: kind === 'project' ? '/manual/project' : '' });
    expect(page.bindings.saveNewSessionPreferences).toHaveBeenCalledWith(kind === 'project'
      // 显式点选最近项目同时按设备记住目录(#4103)
      ? { workspaceKind: 'project', workingDirForDevice: { deviceId: 'a', workingDir: '/manual/project' } }
      : { workspaceKind: 'dialogue' });
  });

  it('keeps an explicitly opened project browser open after a late dialogue preference', async () => {
    const page = mountWorkspace();
    act(() => page.current.openProjectBrowse());
    await page.resolvePreferences('dialogue');
    expect(page.current.draft).toMatchObject({ workspaceKind: 'project', workingDir: '' });
    expect(page.bindings.setBrowseOpen).toHaveBeenLastCalledWith(true);
    expect(page.bindings.loadBrowsePath).toHaveBeenCalledExactlyOnceWith('~');
  });

  it('waits for the remembered device before choosing a project, including intermediate commits', async () => {
    const page = mountWorkspace();
    expect(page.current.newSessionPreferencesLoaded).toBe(false);
    await page.resolvePreferences('project', 'b');
    expect(page.current.selectedDeviceId).toBe('b');
    expect(page.current.draft.workingDir).toBe('/projects/b');
    expect(page.commits.filter(({ path }) => path)).toEqual([
      { device: 'b', kind: 'project', path: '/projects/b' },
    ]);
    expect(page.bindings.loadBrowsePath).not.toHaveBeenCalled();
  });

  it('restores the directory last explicitly chosen on the remembered device instead of the most recent one (#4103)', async () => {
    const page = mountWorkspace();
    // 用户上次在设备 b 显式选了第三个目录(它甚至不在最近列表里);重进后应恢复它而不是最近首项 /projects/b
    await page.resolvePreferences('project', 'b', { b: '/projects/third', a: '/projects/other' });
    expect(page.current.selectedDeviceId).toBe('b');
    expect(page.current.draft).toMatchObject({ workspaceKind: 'project', workingDir: '/projects/third' });
    // 自动恢复不算显式选择:不得把它再写回目录记忆
    expect(page.bindings.saveNewSessionPreferences).not.toHaveBeenCalledWith(
      expect.objectContaining({ workingDirForDevice: expect.anything() }),
    );
    expect(page.bindings.loadBrowsePath).not.toHaveBeenCalled();
  });

  it('uses the directory chosen in this session after switching devices and back, not the stale stored one (#4103 Codex P2)', async () => {
    const page = mountWorkspace();
    await page.resolvePreferences('project', 'a', { a: '/projects/old-a' });
    expect(page.current.draft.workingDir).toBe('/projects/old-a');
    // 本页内显式换成新目录 → 内存里的设备记忆同步更新(落盘不回写 state)
    act(() => page.current.selectRecentProject('/projects/new-a'));
    expect(page.current.draft.workingDir).toBe('/projects/new-a');
    // 切到 b(无记忆 → 最近首项),再切回 a:应恢复本页刚选的 new-a,而不是读取时的 old-a
    act(() => page.current.switchDevice('b'));
    expect(page.current.draft.workingDir).toBe('/projects/b');
    act(() => page.current.switchDevice('a'));
    expect(page.current.draft.workingDir).toBe('/projects/new-a');
  });

  it('falls back to the most recent workspace when only another device has a remembered directory', async () => {
    const page = mountWorkspace();
    await page.resolvePreferences('project', 'b', { a: '/projects/other' });
    expect(page.current.draft).toMatchObject({ workspaceKind: 'project', workingDir: '/projects/b' });
  });

  it('keeps the existing default when storage has no remembered mode', async () => {
    const page = mountWorkspace();
    await page.resolvePreferences(null);
    expect(page.current.draft).toMatchObject({ workspaceKind: 'dialogue', workingDir: '' });
  });
});
