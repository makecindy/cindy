// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  },
}));
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ subscribeRemoteOrcaWorkerChanged: () => () => undefined }));
vi.mock('@/session/ContextSheetCollabView', () => ({
  canSubmitOrcaWorkerForm: () => true,
  isPredefinedOrcaRole: (role: string) => ['developer', 'designer', 'reviewer', 'tester', 'merger'].includes(role),
}));
vi.mock('@/session/fullAccessConfirmation', () => ({ confirmFullAccessChange: async () => true }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { applySessionPatch: vi.fn() } }));

const { useOrcaWorkerForm } = await import('@/session/useSessionOrcaCollab');
const { resetOrcaWorkerCreationPrefsMemory, saveOrcaWorkerCreationPrefs, defaultOrcaWorkerCreationPrefs } =
  await import('@/session/orcaWorkerPrefs');

let root: Root;
let latest: ReturnType<typeof useOrcaWorkerForm> | null = null;

function Probe({ maker }: { maker: MobileMakerTransport }) {
  latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: false, setSheetOpen: () => undefined });
  return null;
}

const model = (id: string, efforts = ['low', 'high']) => ({
  id, label: id, efforts, effortDisplayNames: {}, defaultEffort: efforts[0] ?? null, supportsFastMode: true,
});

function fakeMaker(): MobileMakerTransport {
  return {
    listAvailableAgents: vi.fn(async () => ['claude-code', 'codex', 'pi']),
    getCapabilities: vi.fn(async (agent: string) => ({
      hasFastMode: true,
      availableModels: agent === 'pi' ? [model('pi-model')] : [model('codex/gpt-5.5'), model('claude-opus-4-7')],
    })),
  } as unknown as MobileMakerTransport;
}

const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  storage.clear();
  resetOrcaWorkerCreationPrefsMemory();
  latest = null;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

it('restores the last Agent and its remembered model, and drops models the computer cannot run', async () => {
  saveOrcaWorkerCreationPrefs('user-1', {
    ...defaultOrcaWorkerCreationPrefs(),
    lastAgent: 'pi',
    workerPermissionMode: 'auto',
    agents: { ...defaultOrcaWorkerCreationPrefs().agents, pi: { model: 'retired', effort: 'high', fast: false } },
  });
  resetOrcaWorkerCreationPrefsMemory();
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form.agent).toBe('pi');
  expect(latest!.form.permissionMode).toBe('auto');
  // 记住的模型在这台电脑上已下线 → 回落「默认」,交给电脑端解析。
  expect(latest!.form.model).toBeNull();

  await act(async () => { latest!.changeAgent('codex'); await flush(); });
  expect(latest!.form.model).toEqual({ id: 'codex/gpt-5.5', providerId: null, effort: 'high', fast: false });
});

it('remembers the submitted choice for next time', async () => {
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  await act(async () => { latest!.reset(); await flush(); });
  await act(async () => {
    latest!.remember({
      ...latest!.form,
      agent: 'claude-code',
      model: { id: 'claude-opus-4-7', providerId: 'anthropic', effort: 'low', fast: true },
      permissionMode: 'auto',
      initialTask: 'not remembered',
    });
  });
  resetOrcaWorkerCreationPrefsMemory();
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form).toEqual({
    role: 'developer',
    agent: 'claude-code',
    model: { id: 'claude-opus-4-7', providerId: null, effort: 'low', fast: true },
    permissionMode: 'auto',
    initialTask: '',
  });
});

it('never lets a late memory read overwrite a permission the user already chose', async () => {
  saveOrcaWorkerCreationPrefs('user-1', { ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'bypassPermissions' });
  resetOrcaWorkerCreationPrefsMemory();
  // 预读还没完成就打开表单并立刻改成「自动审批」。
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  act(() => { latest!.reset(); });
  await act(async () => { await latest!.changePermission('auto'); });
  await act(async () => { await flush(); });
  expect(latest!.form.permissionMode).toBe('auto');
});

it('opens a Worker on tap and keeps the long-press action menu within three buttons for Android', async () => {
  const { Alert } = await import('react-native');
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  let collab: ReturnType<typeof useSessionOrcaCollab> | null = null;
  const maker = {
    ...fakeMaker(),
    orca: {
      listWorkers: vi.fn(async () => []),
      getCollaborationSettings: vi.fn(async () => ({})),
      getTeamByWorkerSession: vi.fn(async () => null),
    },
  } as unknown as MobileMakerTransport;
  function Host() {
    collab = useSessionOrcaCollab({
      maker, deviceId: 'dev-1', sessionId: 'lead-1', prefsScope: 'user-1', enabled: true,
      session: { id: 'lead-1', orcaRole: 'lead', workspaceKind: 'project', workingDir: '/repo', agentKind: 'codex' } as never,
      sheetView: null, sheetOpen: false, setSheetView: () => undefined, setSheetOpen: () => undefined, openSession,
    });
    return null;
  }
  const openSession = vi.fn();
  await act(async () => root.render(<Host />));
  const alert = vi.mocked(Alert.alert);
  const worker = { workerId: 'w-1', sessionId: 's-1', role: 'developer', label: null, status: 'idle' as const, focused: false, agentKind: 'codex' as const, model: null, effort: null, title: null };
  // 点按直接进入 Worker,不弹窗。
  const alertsBefore = alert.mock.calls.length;
  act(() => collab!.openWorker(worker));
  expect(openSession).toHaveBeenCalledWith('s-1');
  expect(alert.mock.calls.length).toBe(alertsBefore);
  // 长按才弹管理操作:手机上只有归档(焦点是电脑端协同面板的展示,不在手机上切换)。
  act(() => collab!.showWorkerActions(worker));
  expect(alert.mock.calls.at(-1)![2]!.map((button) => button.style)).toEqual(['destructive', 'cancel']);
  act(() => collab!.showWorkerActions({ ...worker, focused: true }));
  expect(alert.mock.calls.at(-1)![2]!.map((button) => button.style)).toEqual(['destructive', 'cancel']);
});

it('moves an untouched form off an Agent the computer does not have', async () => {
  const maker = { ...fakeMaker(), listAvailableAgents: vi.fn(async () => ['claude-code']) } as unknown as MobileMakerTransport;
  function ActiveProbe() {
    latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: true, setSheetOpen: () => undefined });
    return null;
  }
  await act(async () => root.render(<ActiveProbe />));
  act(() => { latest!.reset(); });
  await act(async () => { await flush(); });
  expect(latest!.agents).toEqual(['claude-code']);
  expect(latest!.form.agent).toBe('claude-code');
  expect(latest!.form.model?.id).toBe('claude-opus-4-7');
});

it('reopens a confirmed draft with the role mode that matches its saved role', async () => {
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  await act(async () => { latest!.reset(); await flush(); });
  const saved = { ...latest!.form, role: 'developer' };
  // 上次打开时切到了「自定义」但没提交就关掉。
  await act(async () => { latest!.setCustomRoleMode(true); });
  await act(async () => { latest!.restore(saved); await flush(); });
  expect(latest!.customRoleMode).toBe(false);
  expect(latest!.form.role).toBe('developer');

  await act(async () => { latest!.restore({ ...saved, role: 'Security Auditor' }); await flush(); });
  expect(latest!.customRoleMode).toBe(true);
});

it('drops a memory read that lands after switching to another account', async () => {
  saveOrcaWorkerCreationPrefs('user-1', { ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'pi', workerPermissionMode: 'auto' });
  resetOrcaWorkerCreationPrefsMemory();
  const maker = fakeMaker();
  function ScopedProbe({ scope }: { scope: string }) {
    latest = useOrcaWorkerForm({ maker, prefsScope: scope, active: false, setSheetOpen: () => undefined });
    return null;
  }
  // 账号 A 的记忆还在读取中就打开表单,随后切到账号 B。
  act(() => root.render(<ScopedProbe scope="user-1" />));
  act(() => { latest!.reset(); });
  act(() => root.render(<ScopedProbe scope="user-2" />));
  await act(async () => { await flush(); });
  expect(latest!.form.agent).toBe('codex');
  expect(latest!.form.permissionMode).toBe('bypassPermissions');
});

it('moves off an unavailable Agent even after unrelated edits, keeping those edits', async () => {
  let resolveAgents: (agents: string[]) => void = () => undefined;
  const maker = {
    ...fakeMaker(),
    listAvailableAgents: vi.fn(() => new Promise<string[]>((resolve) => { resolveAgents = resolve; })),
  } as unknown as MobileMakerTransport;
  function ActiveProbe() {
    latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: true, setSheetOpen: () => undefined });
    return null;
  }
  await act(async () => root.render(<ActiveProbe />));
  act(() => { latest!.reset(); });
  // Agent 列表还没回来,用户先改了角色和初始任务。
  act(() => { latest!.patch({ role: 'reviewer', initialTask: 'check tests' }); });
  await act(async () => { resolveAgents(['claude-code']); await flush(); });
  expect(latest!.form.agent).toBe('claude-code');
  expect(latest!.form.role).toBe('reviewer');
  expect(latest!.form.initialTask).toBe('check tests');
});

it('rereads Agents and model capabilities on an open form after reconnecting', async () => {
  saveOrcaWorkerCreationPrefs('user-1', {
    ...defaultOrcaWorkerCreationPrefs(),
    agents: { ...defaultOrcaWorkerCreationPrefs().agents, codex: { model: 'retired', effort: 'high', fast: false } },
  });
  const base = fakeMaker();
  let online = false;
  const maker = {
    listAvailableAgents: vi.fn(async () => {
      if (!online) throw new Error('[DEVICE_OFFLINE] offline');
      return base.listAvailableAgents();
    }),
    getCapabilities: vi.fn(async (agent: string) => {
      if (!online) throw new Error('[DEVICE_OFFLINE] offline');
      return base.getCapabilities(agent as never);
    }),
  } as unknown as MobileMakerTransport;
  function EpochProbe({ epoch }: { epoch: number }) {
    latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: true, setSheetOpen: () => undefined, connectionEpoch: epoch });
    return null;
  }
  await act(async () => root.render(<EpochProbe epoch={1} />));
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form.model?.id).toBe('retired');
  online = true;
  await act(async () => { root.render(<EpochProbe epoch={2} />); await flush(); });
  // 记住的模型在这台电脑上已下线 → 重连后收敛为「默认」。
  expect(latest!.form.model).toBeNull();
});

it('still restores remembered choices when the Agent list lands before the memory read', async () => {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  saveOrcaWorkerCreationPrefs('user-1', { ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'auto' });
  resetOrcaWorkerCreationPrefsMemory();
  const releases: Array<() => void> = [];
  vi.mocked(AsyncStorage.getItem).mockImplementation((key: string) => new Promise((resolve) => {
    releases.push(() => resolve(storage.get(key) ?? null));
  }));
  const base = fakeMaker();
  let releaseAgents: () => void = () => undefined;
  const maker = {
    ...base,
    listAvailableAgents: vi.fn(() => new Promise<string[]>((resolve) => {
      releaseAgents = () => resolve(['claude-code', 'codex', 'pi']);
    })),
  } as unknown as MobileMakerTransport;
  try {
    function ActiveProbe() {
      latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: true, setSheetOpen: () => undefined });
      return null;
    }
    await act(async () => root.render(<ActiveProbe />));
    act(() => { latest!.reset(); });
    // Agent 列表(非用户事件)先回来,记忆读取随后才完成。
    await act(async () => { releaseAgents(); await flush(); });
    expect(latest!.form.permissionMode).toBe('bypassPermissions');
    await act(async () => { for (const release of releases) release(); await flush(); });
    expect(latest!.form.permissionMode).toBe('auto');
  } finally {
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => storage.get(key) ?? null);
  }
});

it('treats a timed-out Worker archive as unconfirmed and rechecks the team', async () => {
  const { Alert } = await import('react-native');
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  let collab: ReturnType<typeof useSessionOrcaCollab> | null = null;
  const listWorkers = vi.fn(async () => []);
  const maker = {
    ...fakeMaker(),
    orca: {
      listWorkers,
      getCollaborationSettings: vi.fn(async () => ({})),
      getTeamByWorkerSession: vi.fn(async () => null),
      archiveWorker: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }),
    },
  } as unknown as MobileMakerTransport;
  function Host() {
    collab = useSessionOrcaCollab({
      maker, deviceId: 'dev-1', sessionId: 'lead-1', prefsScope: 'user-1', enabled: true,
      session: { id: 'lead-1', orcaRole: 'lead', workspaceKind: 'project', workingDir: '/repo', agentKind: 'codex' } as never,
      sheetView: null, sheetOpen: false, setSheetView: () => undefined, setSheetOpen: () => undefined, openSession: () => undefined,
    });
    return null;
  }
  await act(async () => root.render(<Host />));
  const loads = listWorkers.mock.calls.length;
  const worker = { workerId: 'w-1', sessionId: 's-1', role: 'developer', label: null, status: 'idle' as const, focused: false, agentKind: 'codex' as const, model: null, effort: null, title: null };
  act(() => collab!.showWorkerActions({ ...worker, focused: true }));
  act(() => vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!.onPress?.());
  const confirm = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!;
  await act(async () => { confirm.onPress?.(); await flush(); });
  expect(collab!.error).toMatch(/timed out|超时/);
  expect(listWorkers.mock.calls.length).toBeGreaterThan(loads);
});

it('restores the remembered Agent after a device switch instead of the previous computer fallback', async () => {
  saveOrcaWorkerCreationPrefs('user-1', { ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'claude-code' });
  const codexOnly = { ...fakeMaker(), listAvailableAgents: vi.fn(async () => ['codex']) } as unknown as MobileMakerTransport;
  let releaseB: () => void = () => undefined;
  const both = {
    ...fakeMaker(),
    listAvailableAgents: vi.fn(() => new Promise<string[]>((resolve) => {
      releaseB = () => resolve(['claude-code', 'codex']);
    })),
  } as unknown as MobileMakerTransport;
  function DeviceProbe({ maker }: { maker: MobileMakerTransport }) {
    latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: true, setSheetOpen: () => undefined });
    return null;
  }
  // 电脑 A 只有 Codex:打开表单落在 Codex。
  await act(async () => root.render(<DeviceProbe maker={codexOnly} />));
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form.agent).toBe('codex');
  // 切到电脑 B:列表回来前复位不再沿用 A 的列表;回来后恢复记忆的 Claude。
  await act(async () => root.render(<DeviceProbe maker={both} />));
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.agents).toEqual(['claude-code', 'codex', 'pi']);
  await act(async () => { releaseB(); await flush(); });
  expect(latest!.form.agent).toBe('claude-code');
});

it('lets a Worker task archive itself back to the Lead', async () => {
  const { Alert } = await import('react-native');
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  let collab: ReturnType<typeof useSessionOrcaCollab> | null = null;
  const archiveWorker = vi.fn(async () => ({}));
  const maker = {
    ...fakeMaker(),
    orca: {
      listWorkers: vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-1', role: 'tester', focused: false }]),
      getCollaborationSettings: vi.fn(async () => ({})),
      getTeamByWorkerSession: vi.fn(async () => ({ leadSessionId: 'lead-1' })),
      archiveWorker,
    },
  } as unknown as MobileMakerTransport;
  const openSession = vi.fn();
  function Host() {
    collab = useSessionOrcaCollab({
      maker, deviceId: 'dev-1', sessionId: 'worker-1', prefsScope: 'user-1', enabled: true,
      session: { id: 'worker-1', orcaRole: 'worker', workspaceKind: 'project', workingDir: '/repo', agentKind: 'pi' } as never,
      sheetView: null, sheetOpen: false, setSheetView: () => undefined, setSheetOpen: () => undefined, openSession,
    });
    return null;
  }
  await act(async () => { root.render(<Host />); await flush(); });
  await act(async () => { await flush(); });
  expect(collab!.workerLeadSessionId).toBe('lead-1');
  expect(collab!.workerSelf?.workerId).toBe('w-1');
  // 确认弹窗先弹出(详情面板还开着),确认后才收起面板再归档。
  const closeMenu = vi.fn();
  act(() => collab!.confirmArchiveSelf(closeMenu));
  expect(closeMenu).not.toHaveBeenCalled();
  const confirm = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!;
  await act(async () => { confirm.onPress?.(); await flush(); });
  expect(closeMenu).toHaveBeenCalledTimes(1);
  expect(archiveWorker).toHaveBeenCalledWith('lead-1', 'w-1');
  expect(openSession).toHaveBeenCalledWith('lead-1');
});

it('offers the Agent capability models as a flat fallback for computers without the provider catalog', async () => {
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  await act(async () => { latest!.reset(); await flush(); });
  const options = latest!.modelPicker.flatModelOptions;
  expect(options.map((option) => option.id)).toEqual(['codex/gpt-5.5', 'claude-opus-4-7']);
  await act(async () => { latest!.modelPicker.selectFlatModel(options[1]!); await flush(); });
  expect(latest!.form.model).toMatchObject({ id: 'claude-opus-4-7', providerId: null });
});

it('returns to the Lead when a timed-out self-archive is confirmed by a recheck', async () => {
  const { Alert } = await import('react-native');
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  let collab: ReturnType<typeof useSessionOrcaCollab> | null = null;
  let archived = false;
  const maker = {
    ...fakeMaker(),
    orca: {
      listWorkers: vi.fn(async () => (archived ? [] : [{ id: 'w-1', sessionId: 'worker-1', role: 'tester' }])),
      getCollaborationSettings: vi.fn(async () => ({})),
      getTeamByWorkerSession: vi.fn(async () => ({ leadSessionId: 'lead-1' })),
      archiveWorker: vi.fn(async () => { archived = true; throw new Error('[INVOKE_TIMEOUT] timed out'); }),
    },
  } as unknown as MobileMakerTransport;
  const openSession = vi.fn();
  function Host() {
    collab = useSessionOrcaCollab({
      maker, deviceId: 'dev-1', sessionId: 'worker-1', prefsScope: 'user-1', enabled: true,
      session: { id: 'worker-1', orcaRole: 'worker', workspaceKind: 'project', workingDir: '/repo', agentKind: 'pi' } as never,
      sheetView: null, sheetOpen: false, setSheetView: () => undefined, setSheetOpen: () => undefined, openSession,
    });
    return null;
  }
  await act(async () => { root.render(<Host />); await flush(); });
  await act(async () => { await flush(); });
  act(() => collab!.confirmArchiveSelf());
  const confirm = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!;
  await act(async () => { confirm.onPress?.(); await flush(); await flush(); });
  expect(openSession).toHaveBeenCalledWith('lead-1');
});

it('does not let a late capability response from the previous computer fill the flat model list', async () => {
  let releaseA: () => void = () => undefined;
  const makerA = {
    ...fakeMaker(),
    getCapabilities: vi.fn(() => new Promise((resolve) => {
      releaseA = () => resolve({ hasFastMode: true, availableModels: [model('a-only-model')] });
    })),
  } as unknown as MobileMakerTransport;
  const makerB = {
    ...fakeMaker(),
    getCapabilities: vi.fn(async () => ({ hasFastMode: true, availableModels: [model('b-model')] })),
  } as unknown as MobileMakerTransport;
  function DeviceProbe({ maker }: { maker: MobileMakerTransport }) {
    latest = useOrcaWorkerForm({ maker, prefsScope: 'user-1', active: false, setSheetOpen: () => undefined });
    return null;
  }
  await act(async () => root.render(<DeviceProbe maker={makerA} />));
  act(() => { latest!.reset(); });
  await act(async () => root.render(<DeviceProbe maker={makerB} />));
  await act(async () => { latest!.reset(); await flush(); });
  await act(async () => { releaseA(); await flush(); });
  expect(latest!.modelPicker.flatModelOptions.map((option) => option.id)).toEqual(['b-model']);
});
