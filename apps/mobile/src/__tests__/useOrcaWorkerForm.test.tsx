// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { RemoteSession } from '@/session/types';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  },
}));
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ subscribeRemoteOrcaWorkerChanged: () => () => undefined }));
vi.mock('@/session/ContextSheetCollabView', () => ({ canSubmitOrcaWorkerForm: () => true }));
vi.mock('@/session/fullAccessConfirmation', () => ({ confirmFullAccessChange: async () => true }));

const { useOrcaWorkerForm } = await import('@/session/useSessionOrcaCollab');
const { resetOrcaWorkerCreationPrefsMemory, saveOrcaWorkerCreationPrefs, defaultOrcaWorkerCreationPrefs, readOrcaWorkerCreationPrefs } =
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

/**
 * 版本太旧、没有记忆通道的电脑：「上次选择」只能沿用手机本地的旧记忆。本文件里没有另外说明的
 * 用例都走这条兼容路径；记在电脑上的行为见 `worker roles kept on the task computer`。
 */
const oldComputer = () => ({
  getWorkerRoles: vi.fn(async () => { throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] maker:worker-roles:get'); }),
  applyWorkerRoles: vi.fn(async (_mutation: unknown): Promise<{ ok: true }> => {
    throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] maker:worker-roles:apply');
  }),
});

function fakeMaker(): MobileMakerTransport {
  return {
    orca: oldComputer(),
    listAvailableAgents: vi.fn(async () => ['claude-code', 'codex', 'pi']),
    getCapabilities: vi.fn(async (agent: string) => ({
      hasFastMode: true,
      availableModels: agent === 'pi' ? [model('pi-model')] : [model('codex/gpt-5.5'), model('claude-opus-4-7')],
    })),
  } as unknown as MobileMakerTransport;
}

function ExecutionProbe({ maker, target, enabled = true }: { maker: MobileMakerTransport; target: (id: string) => MobileMakerTransport; enabled?: boolean }) {
  latest = useOrcaWorkerForm({ maker, executionMakerForDevice: target, executionDevicesEnabled: enabled, prefsScope: 'user-1', active: true, setSheetOpen: () => undefined });
  return null;
}

// Unit regression: a Worker on B may use C's provider, with model/effort kept
// as one explicit route. Old execution hosts must retain the local-only form.
it.each([false, true])('permits remote providers on the selected work computer only with support %s', async supported => {
  const lead = { ...fakeMaker(), orca: { ...oldComputer(), listExecutionDevices: vi.fn(async () => ({ devices: [
    { deviceId: 'b', name: 'B', supported: true, ...(supported ? { supportsAgentDevice: true } : {}) },
  ] })) } } as unknown as MobileMakerTransport;
  const remote = fakeMaker();
  function Host() { latest = useOrcaWorkerForm({ maker: lead, executionMakerForDevice: () => remote,
    executionDevicesEnabled: true, agentLocationSelectable: true, leadAgentDeviceId: 'lead-model-pc',
    prefsScope: 'user-1', active: true, setSheetOpen: () => undefined }); return null; }
  await act(async () => { root.render(<Host />); await flush(); });
  await act(async () => { latest!.patch({ executionDeviceId: 'b' }); await flush(); });
  expect(latest!.agentLocationSelectable).toBe(supported);
  await act(async () => { await latest!.modelPicker.select({ agent: 'codex', modelId: 'remote-only', providerId: 'remote-openai', effort: 'high', fast: false }, { deviceId: 'c' }); });
  expect(latest!.form.executionDeviceId).toBe('b');
  if (supported) expect(latest!.form).toMatchObject({ agentDeviceId: 'c', model: { id: 'remote-only', providerId: 'remote-openai', effort: 'high' } });
  else expect(latest!.form.agentDeviceId).toBeUndefined();
});

it('reads selectable devices from the Lead and reads Agent/model capabilities from the chosen device', async () => {
  const lead = { ...fakeMaker(), listAvailableAgents: vi.fn(async () => ['codex']), orca: { ...oldComputer(), listExecutionDevices: vi.fn(async () => ({ devices: [
    { deviceId: 'b', name: 'B', supported: true }, { deviceId: 'old', supported: false },
  ] })) } } as unknown as MobileMakerTransport;
  const remote = { ...fakeMaker(), listAvailableAgents: vi.fn(async () => ['pi']), getCapabilities: vi.fn(async () => ({ availableModels: [model('b-model')] })) } as unknown as MobileMakerTransport;
  const target = vi.fn(() => remote);
  await act(async () => { root.render(<ExecutionProbe maker={lead} target={target} />); await flush(); });
  await act(async () => { latest!.patch({ executionDeviceId: 'b' }); await flush(); });
  expect(latest!.maker).toBe(remote);
  expect(latest!.form.agent).toBe('pi');
  expect(remote.getCapabilities).toHaveBeenCalledWith('pi');
  expect(latest!.modelPicker.flatModelOptions.map((option) => option.id)).toEqual(['b-model']);
  expect(latest!.valid).toBe(true);
  expect(lead.orca.listExecutionDevices).toHaveBeenCalledTimes(1);
  await act(async () => { latest!.patch({ remoteDirMode: 'path', remoteDir: '/b' }); latest!.patch({ executionDeviceId: undefined }); await flush(); });
  expect(latest!.maker).toBe(lead);
  expect(latest!.form.remoteDirMode).toBe('dialogue');
  expect(latest!.form.remoteDir).toBe('');
  await act(async () => { latest!.patch({ executionDeviceId: 'old' }); await flush(); });
  expect(latest!.valid).toBe(false);
  // 同一标记的自动默认分支：撤掉运行设备后需按 Lead 的目录重新收敛，不能残留远端显式选行标记。
  await act(async () => { latest!.patch({ executionDeviceId: 'b' }); await flush(); });
  await act(async () => { await latest!.modelPicker.select({ agent: 'pi', modelId: 'b-model', providerId: 'b-provider', effort: '', fast: false }); });
  await act(async () => { root.render(<ExecutionProbe maker={lead} target={target} enabled={false} />); await flush(); });
  expect(latest!.form.executionDeviceId).toBeUndefined();
  expect(latest!.form.agent).toBe('codex');
});

it('does not let a late capability response from A overwrite a model chosen on B', async () => {
  let resolveLead!: (value: unknown) => void;
  const lead = { ...fakeMaker(), getCapabilities: vi.fn(() => new Promise((resolve) => { resolveLead = resolve; })), orca: { ...oldComputer(),
    listExecutionDevices: vi.fn(async () => ({ devices: [{ deviceId: 'b', supported: true }] })),
  } } as unknown as MobileMakerTransport;
  const remote = { ...fakeMaker(), getCapabilities: vi.fn(async () => ({ availableModels: [model('b-model')] })) } as unknown as MobileMakerTransport;
  const target = () => remote;
  await act(async () => { root.render(<ExecutionProbe maker={lead} target={target} />); await flush(); });
  await act(async () => { latest!.patch({ executionDeviceId: 'b' }); await flush(); });
  await act(async () => { await latest!.modelPicker.select({ agent: 'codex', modelId: 'b-model', providerId: '', effort: 'high', fast: false }); });
  await act(async () => { resolveLead({ availableModels: [model('a-model')] }); await flush(); });
  expect(latest!.form.model?.id).toBe('b-model');
  expect(latest!.modelPicker.flatModelOptions.map((option) => option.id)).toEqual(['b-model']);
});

function LocationProbe({ maker, lead, selectable, host = 'host-a', scope = 'user-1', sshRemote = false }: { maker: MobileMakerTransport; lead: string | null; selectable: boolean; host?: string; scope?: string; sshRemote?: boolean }) {
  latest = useOrcaWorkerForm({
    maker, prefsScope: scope, taskHostDeviceId: host, sshRemote, active: true, setSheetOpen: () => undefined,
    leadAgentDeviceId: lead, agentLocationSelectable: selectable,
  });
  return null;
}

// 远程供应商与本机供应商一视同仁(2026-10-10)：Worker 的 Agent 可以放到另一台电脑或分享上。
it("defaults the Worker to the Lead's Agent computer and follows remote picks without converging them on the controlled computer", async () => {
  const maker = fakeMaker();
  await act(async () => { root.render(<LocationProbe maker={maker} lead="agent-pc" selectable />); await flush(); });
  await act(async () => { latest!.reset(); await flush(); });
  // Lead 在另一台电脑：位置跟它，本机记忆的模型属于别的目录，回到「默认」。
  expect(latest!.form.agentDeviceId).toBe('agent-pc');
  expect(latest!.form.model).toBeNull();
  expect(latest!.agentLocationSelectable).toBe(true);

  await act(async () => {
    await latest!.modelPicker.select(
      { agent: 'codex', modelId: 'remote-only-model', providerId: 'spark', effort: 'high', fast: false },
      { deviceId: 'share:s1' },
    );
    await flush();
  });
  // 被控电脑的能力里没有这个模型，换 Agent 列表 / 收敛时也不清掉。
  await act(async () => { root.render(<LocationProbe maker={maker} lead="agent-pc" selectable />); await flush(); });
  expect(latest!.form).toMatchObject({ agentDeviceId: 'share:s1', model: { id: 'remote-only-model', providerId: 'spark' } });

  await act(async () => {
    await latest!.modelPicker.select(
      { agent: 'codex', modelId: 'codex/gpt-5.5', providerId: 'xd', effort: 'high', fast: false },
      { deviceId: null },
    );
    await flush();
  });
  expect(latest!.form.agentDeviceId).toBeNull();
});

// 7af90460e2 后 reset 跟 Lead 丢失远程选择；旧用例只验证本次选行。
// unit：经过表单 select → remember → 重新挂载，验证持久恢复及账号/任务电脑隔离。
it.each(['agent-pc', 'share:s1', null])('remembers the submitted model route independently of the Lead (%s)', async (location) => {
  const maker = fakeMaker();
  const renderForm = async (lead: string | null, props = {}) => {
    await act(async () => { root.render(<LocationProbe maker={maker} lead={lead} selectable {...props} />); await flush(); });
    await act(async () => { latest!.reset(); await flush(); });
  };
  await renderForm('original-lead');
  await act(async () => { await latest!.modelPicker.select(
    { agent: 'pi', modelId: 'chosen-model', providerId: 'chosen-provider', effort: 'high', fast: true },
    { deviceId: location },
  ); });
  await act(async () => { latest!.remember(latest!.form); await flush(); });
  if (location) expect((await readOrcaWorkerCreationPrefs('user-1')).agents.pi.model)
    .toBe(defaultOrcaWorkerCreationPrefs().agents.pi.model);
  await act(async () => root.render(null));
  resetOrcaWorkerCreationPrefsMemory();
  await renderForm('new-lead');
  expect(latest!.form).toMatchObject({ agent: 'pi', agentDeviceId: location,
    model: { id: 'chosen-model', providerId: 'chosen-provider', effort: 'high', fast: true } });
  // PR #6453：Android 已选 Agent pill 也触发 onChange；原用例漏了同值重复选择。
  // unit 最小输入：恢复完整路线后重复选当前 Agent，不能清模型/来源/位置/档位/Fast/显式标记。
  const restored = latest!.form;
  await act(async () => { latest!.changeAgent(restored.agent); await flush(); });
  expect(latest!.form).toEqual(restored);
  await act(async () => { latest!.remember(latest!.form); await flush(); });
  await act(async () => root.render(null));
  resetOrcaWorkerCreationPrefsMemory();
  await renderForm('new-lead');
  expect(latest!.form).toEqual(restored);
  // 旧端不能兑现记住的位置时阻止提交，不跟着 Lead 静默换位置。
  await renderForm('new-lead', { selectable: false });
  expect(latest!.valid).toBe(false);
  for (const props of [{ host: 'host-b' }, { scope: 'user-2' }, { sshRemote: true }]) {
    await renderForm('new-lead', props);
    expect(latest!.form.agentDeviceId).toBe('new-lead');
    expect(latest!.form.model).toBeNull();
  }
});

// PR #6453：完整路线恢复优先于 lastAgent；切 Agent 后成功提交不能再次恢复旧 Agent。
// unit：已有用例未覆盖 select → remember → changeAgent → remember → reset 的连续操作；
// 分别覆盖有效旧模型、收敛成默认模型，以及不能写进本机逐 Agent 槽的远程目录。
it.each([
  { location: null, remembered: 'pi-model', expected: 'pi-model' },
  { location: null, remembered: 'retired', expected: null },
  { location: 'agent-pc', remembered: 'pi-model', expected: null },
])('replaces the saved Agent only after submitting an Agent switch ($location, $remembered)', async ({ location, remembered, expected }) => {
  const maker = fakeMaker();
  const defaults = defaultOrcaWorkerCreationPrefs();
  const otherHostSelection = { agent: 'codex' as const, agentDeviceId: 'other-pc', model: { id: 'other-model', providerId: 'other-provider', effort: 'high', fast: false } };
  saveOrcaWorkerCreationPrefs('user-1', {
    ...defaults,
    modelSelectionByHost: { 'host-b': otherHostSelection },
    agents: { ...defaults.agents, pi: { model: remembered, effort: 'high', fast: false } },
  });
  await act(async () => { root.render(<LocationProbe maker={maker} lead={location} selectable />); await flush(); });
  await act(async () => { latest!.reset(); await flush(); });
  await act(async () => { await latest!.modelPicker.select(
    { agent: 'codex', modelId: 'codex/gpt-5.5', providerId: 'chosen-provider', effort: 'high', fast: true },
    { deviceId: location },
  ); });
  await act(async () => { latest!.remember(latest!.form); await flush(); });
  const original = (await readOrcaWorkerCreationPrefs('user-1')).modelSelectionByHost?.['host-a'];

  await act(async () => { latest!.changeAgent('pi'); await flush(); });
  expect(latest!.form.model?.id ?? null).toBe(expected);
  // 没有成功提交时，仅关闭重开不能删除旧完整路线。
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form).toMatchObject({ agent: 'codex', agentDeviceId: location });
  expect((await readOrcaWorkerCreationPrefs('user-1')).modelSelectionByHost?.['host-a']).toEqual(original);

  await act(async () => { latest!.changeAgent('pi'); await flush(); });
  expect(latest!.form.model?.id ?? null).toBe(expected);
  await act(async () => { latest!.remember(latest!.form); await flush(); });
  await act(async () => root.render(null));
  resetOrcaWorkerCreationPrefsMemory();
  await act(async () => { root.render(<LocationProbe maker={maker} lead={location} selectable />); await flush(); });
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form.agent).toBe('pi');
  expect(latest!.form.model?.id ?? null).toBe(expected);
  const saved = await readOrcaWorkerCreationPrefs('user-1');
  expect(saved.agents.pi.model).toBe(remembered);
  expect(saved.modelSelectionByHost?.['host-b']).toEqual(otherHostSelection);
});

it('does not save cancelled picks or let a late saved route replace a new pick', async () => {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  const maker = fakeMaker();
  let release!: (value: string | null) => void;
  vi.mocked(AsyncStorage.getItem).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  try {
    await act(async () => root.render(<LocationProbe maker={maker} lead="lead-pc" selectable />));
    act(() => latest!.reset());
    await act(async () => { await latest!.modelPicker.select(
      { agent: 'codex', modelId: 'new-pick', providerId: 'new-source', effort: 'high', fast: false },
      { deviceId: 'share:new' },
    ); });
    await act(async () => { release(JSON.stringify({
      ...defaultOrcaWorkerCreationPrefs(), modelSelectionByHost: { 'host-a': {
        agent: 'pi', agentDeviceId: 'share:old', model: { id: 'old', providerId: 'old', effort: 'low', fast: false },
      } },
    })); await flush(); });
    expect(latest!.form).toMatchObject({ agentDeviceId: 'share:new', model: { id: 'new-pick' } });
    await act(async () => { latest!.reset(); await flush(); });
    expect(latest!.form).toMatchObject({ agentDeviceId: 'share:old', model: { id: 'old' } });
    expect(storage.size).toBe(0);
  } finally {
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null);
  }
});

it('leaves the Worker location unset when the controlled computer cannot honor it', async () => {
  await act(async () => { root.render(<LocationProbe maker={fakeMaker()} lead="agent-pc" selectable={false} />); await flush(); });
  await act(async () => { latest!.reset(); await flush(); });
  expect(latest!.form.agentDeviceId).toBeUndefined();
  // 旧被控端让 Worker 跟 Lead 去那台：模型交给那台按自己的目录解析。
  expect(latest!.form.model).toBeNull();
  await act(async () => {
    await latest!.modelPicker.select(
      { agent: 'codex', modelId: 'remote-only-model', providerId: 'xd', effort: 'high', fast: false },
      { deviceId: 'agent-pc' },
    );
  });
  expect(latest!.form.agentDeviceId).toBeUndefined();
  // PR #6453：旧端未指定位置表示跟随 Lead，选行不能把合法提交误禁用。
  expect(latest!.valid).toBe(true);
  await act(async () => { latest!.remember(latest!.form); await flush(); });
  // 跟随远程 Lead 的模型不能写入本机旧槽，完整记忆仍需记录实际位置。
  const prefs = await readOrcaWorkerCreationPrefs('user-1');
  expect(prefs.agents.codex.model).toBe(defaultOrcaWorkerCreationPrefs().agents.codex.model);
  expect(prefs.modelSelectionByHost?.['host-a']).toMatchObject({ agentDeviceId: 'agent-pc', model: { id: 'remote-only-model' } });
  // 同一个远程 Lead 下，显式 null 是要求放在任务电脑，旧端不能兑现。
  act(() => latest!.restore({ ...latest!.form, agentDeviceId: null }));
  expect(latest!.valid).toBe(false);
  act(() => latest!.restore({ ...latest!.form, agentDeviceId: 'agent-pc' }));
  expect(latest!.valid).toBe(true);
});

it('keeps local Worker creation available on older Leads without the device-list channel', async () => {
  const lead = { ...fakeMaker(), orca: { ...oldComputer(), listExecutionDevices: vi.fn(async () => { throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old'); }) } } as unknown as MobileMakerTransport;
  await act(async () => { root.render(<ExecutionProbe maker={lead} target={() => fakeMaker()} />); await flush(); });
  expect(latest!.executionDevices).toEqual([]);
  expect(latest!.executionDevicesError).toBeNull();
  expect(latest!.valid).toBe(true);
});

// 打开表单要先等电脑答复(这里是「没有这个通道」)才轮到手机本地的记忆，比原来多几拍。
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

/** store 里的 Worker 任务行(只填乐观归档 / 回滚用得到的字段)。 */
const workerRow = (id: string) => ({
  id, title: id, status: 'active', orcaRole: 'worker', updatedAt: '2026-01-01T00:00:00.000Z',
}) as unknown as RemoteSession;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  storage.clear();
  resetOrcaWorkerCreationPrefsMemory();
  latest = null;
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

const remoteLead = {
  leadDeviceId: 'lead-device', leadDeviceName: 'Lead computer', leadSessionId: 'lead-1',
  leadTitle: 'Lead task', workerLabel: 'tester',
};

it.each([
  { workspaceKind: 'project', orcaRole: null },
  { workspaceKind: 'dialogue', orcaRole: null },
  { workspaceKind: 'project', orcaRole: 'lead' },
] as const)('keeps a real remote Worker out of collaboration ($workspaceKind, role=$orcaRole)', async (identity) => {
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  const ref: { current: ReturnType<typeof useSessionOrcaCollab> | null } = { current: null };
  const maker = {
    ...fakeMaker(),
    orca: { ...oldComputer(),
      listWorkers: vi.fn(async () => []),
      getTeamByWorkerSession: vi.fn(async () => null),
      getCollabPolicy: vi.fn(async () => ({ effectiveEnabled: true })),
      enable: vi.fn(async () => ({ workerSessionId: 'nested-worker' })),
      createWorker: vi.fn(async () => ({ workerSessionId: 'nested-worker' })),
    },
  } as unknown as MobileMakerTransport;
  const setSheetView = vi.fn();
  function Host() {
    ref.current = useSessionOrcaCollab({
      maker, deviceId: 'run-device', sessionId: 'real-worker', prefsScope: 'user-1', enabled: true,
      session: { id: 'real-worker', ...identity, workingDir: '/repo', agentKind: 'codex', orcaRemoteLead: remoteLead } as RemoteSession,
      sheetView: 'collab', sheetOpen: true, setSheetView, setSheetOpen: vi.fn(), openSession: vi.fn(),
    });
    return null;
  }
  await act(async () => { root.render(<Host />); await flush(); });
  expect(ref.current!.eligible).toBe(false);
  expect(ref.current!.entryBlocked).toBe(true);
  expect(ref.current!.canSubmit).toBe(false);
  expect(ref.current!.isLead).toBe(false);
  expect(ref.current!.workerLeadSessionId).toBeNull();
  expect(setSheetView).toHaveBeenCalledWith('main');
  setSheetView.mockClear();
  await act(async () => {
    ref.current!.openFromMain(); ref.current!.openCreateWorker();
    await ref.current!.submitEnable(); await ref.current!.submitCreate();
  });
  expect(setSheetView).not.toHaveBeenCalled();
  expect(maker.orca.enable).not.toHaveBeenCalled();
  expect(maker.orca.createWorker).not.toHaveBeenCalled();
  expect(maker.orca.listWorkers).not.toHaveBeenCalled();
  expect(maker.orca.getTeamByWorkerSession).not.toHaveBeenCalled();
  expect(maker.getCapabilities).not.toHaveBeenCalled();
});

it('rejects callbacks captured before fresh metadata identifies a remote Worker', async () => {
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  const ref: { current: ReturnType<typeof useSessionOrcaCollab> | null } = { current: null };
  const maker = {
    ...fakeMaker(),
    getCapabilities: vi.fn(async () => ({ supportsOrcaWorkerPermissionMode: true })),
    orca: { ...oldComputer(),
      listExecutionDevices: vi.fn(async () => ({ devices: [] })),
      getCollabPolicy: vi.fn(async () => ({ effectiveEnabled: true })),
      enable: vi.fn(async () => ({ workerSessionId: 'nested-worker' })),
      createWorker: vi.fn(async () => ({ workerSessionId: 'nested-worker' })),
    },
  } as unknown as MobileMakerTransport;
  const setSheetView = vi.fn();
  function Host({ marked }: { marked: boolean }) {
    ref.current = useSessionOrcaCollab({
      maker, deviceId: 'run-device', sessionId: 'real-worker', prefsScope: 'user-1', enabled: true,
      session: { id: 'real-worker', orcaRole: null, workspaceKind: 'project', workingDir: '/repo',
        agentKind: 'codex', orcaRemoteLead: marked ? remoteLead : null } as RemoteSession,
      sheetView: 'collab', sheetOpen: true, setSheetView, setSheetOpen: vi.fn(), openSession: vi.fn(),
    });
    return null;
  }
  await act(async () => { root.render(<Host marked={false} />); await flush(); });
  expect(ref.current!.eligible).toBe(true);
  expect(ref.current!.entryBlocked).toBe(false);
  expect(ref.current!.canSubmit).toBe(true);
  const stale = ref.current!;
  await act(async () => { root.render(<Host marked />); await flush(); });
  expect(setSheetView).toHaveBeenCalledWith('main');
  setSheetView.mockClear();
  await act(async () => {
    stale.openFromMain(); stale.openCreateWorker();
    await stale.submitEnable(); await stale.submitCreate();
  });
  expect(setSheetView).not.toHaveBeenCalled();
  expect(maker.orca.enable).not.toHaveBeenCalled();
  expect(maker.orca.createWorker).not.toHaveBeenCalled();
});

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
  // 本次完整记忆标记引入的回归：原用例只测 reset；unit 最小输入为切回旧模型已下架的 Pi。
  // 切 Agent 自动带出的模型仍须按当前目录收敛，不能冒充显式选行而提交 retired。
  await act(async () => { latest!.changeAgent('pi'); await flush(); });
  expect(latest!.form.agent).toBe('pi');
  expect(latest!.form.model).toBeNull();
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
  // 这台电脑读不到角色清单：落在第一个内置角色上，任务是它自带的那句，上次写的任务不带回。
  expect(latest!.form).toEqual({
    role: 'reviewer',
    agent: 'claude-code',
    model: { id: 'claude-opus-4-7', providerId: null, effort: 'low', fast: true },
    permissionMode: 'auto',
    initialTask: 'Take a look at the Lead’s work and give some suggestions.',
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
    orca: { ...oldComputer(),
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

it('reopens a confirmed draft on its saved role instead of the unfinished add-role input', async () => {
  await act(async () => root.render(<Probe maker={fakeMaker()} />));
  await act(async () => { latest!.reset(); await flush(); });
  const saved = { ...latest!.form, role: 'developer' };
  // 上次打开时点了加号但没提交就关掉。
  await act(async () => { latest!.selectRole(null); });
  expect(latest!.customRoleMode).toBe(true);
  await act(async () => { latest!.restore(saved); await flush(); });
  expect(latest!.customRoleMode).toBe(false);
  expect(latest!.form.role).toBe('developer');

  // 草稿里是清单之外的角色：排在这一排最前并保持选中，不回到输入角色名。
  await act(async () => { latest!.restore({ ...saved, role: 'Security Auditor' }); await flush(); });
  expect(latest!.customRoleMode).toBe(false);
  expect(latest!.roles).toEqual(['Security Auditor', 'reviewer', 'developer', 'tester']);
});

// 测试价值(unit，jsdom；与本文件其余用例共用 hook 入口，单独运行约 1 秒)：
// - 生产入口与可观察结果：useOrcaWorkerForm 的 reset / selectRole / removeRole / remember，断言表单
//   落在哪个角色、带回什么，以及发给任务所在电脑的 maker:worker-roles:get / apply 内容。
// - 规则依据：用户 2026-11-10 裁决「角色清单、每个角色记的内容和不分角色的上次选择都只存在任务
//   所在的电脑上，手机不留副本」(docs/dev-rules/orca-team-architecture.md、protocol-compatibility.md
//   同日条目)。
// - 现有覆盖缺口：此前这些记忆都在手机本地，原用例覆盖的是那条路径(现在只给旧电脑兜底)。
// - 最小失败输入：每条用例一个结果分支 —— 读到清单、读到电脑的上次选择、读到前已动过表单、
//   旧电脑没有通道、一时连不上、提交、移除。
describe('worker roles kept on the task computer', () => {
  const route = { agent: 'claude-code', agentDeviceId: null, model: 'claude-opus-4-7', effort: 'low', fast: false, providerId: 'anthropic' };
  function hostWithRoles(
    roles: unknown[],
    applyWorkerRoles = vi.fn(async (_mutation: unknown) => ({ ok: true })),
    defaults?: unknown,
  ) {
    const getWorkerRoles = vi.fn(async () => ({ roles, ...(defaults ? { defaults } : {}) }));
    const maker = { ...fakeMaker(), orca: { ...oldComputer(), getWorkerRoles, applyWorkerRoles } } as unknown as MobileMakerTransport;
    return { maker, getWorkerRoles, applyWorkerRoles };
  }
  const settle = async () => { await flush(); await flush(); };

  it('opens on the computer’s most recent role with the task, permission and model it remembered', async () => {
    const host = hostWithRoles([
      { role: 'Docs', task: 'Update the API reference', permission: 'auto', model: route },
      { role: 'tester' },
    ]);
    await act(async () => root.render(<Probe maker={host.maker} />));
    await act(async () => { latest!.reset(); await settle(); });
    // 清单按电脑给的顺序；不在清单里的内置角色(reviewer / developer)在那台电脑上已被移除。
    expect(latest!.roles).toEqual(['Docs', 'tester']);
    expect(latest!.rolesEditable).toBe(true);
    expect(latest!.form).toMatchObject({
      role: 'Docs',
      initialTask: 'Update the API reference',
      permissionMode: 'auto',
      agent: 'claude-code',
      model: { id: 'claude-opus-4-7', providerId: 'anthropic', effort: 'low', fast: false },
      modelSelectionExplicit: true,
    });

    // 换角色：没改过的任务换成新角色的；自己写过的留着。
    await act(async () => { latest!.selectRole('tester'); });
    expect(latest!.form.initialTask).toBe('Test the Lead’s work so far and report what failed, with steps to reproduce.');
    await act(async () => { latest!.patch({ initialTask: 'Only the login flow' }); });
    await act(async () => { latest!.selectRole('Docs'); });
    expect(latest!.form).toMatchObject({ role: 'Docs', initialTask: 'Only the login flow' });
  });

  it('leaves the task empty for a new-task draft, where the Lead has no work to review yet', async () => {
    const host = hostWithRoles([{ role: 'reviewer' }, { role: 'Docs', task: 'Update the API reference' }]);
    function DraftProbe() {
      latest = useOrcaWorkerForm({ maker: host.maker, prefsScope: 'user-1', active: false, setSheetOpen: () => undefined, leadHasWork: false });
      return null;
    }
    await act(async () => root.render(<DraftProbe />));
    await act(async () => { latest!.reset(); await settle(); });
    expect(latest!.form).toMatchObject({ role: 'reviewer', initialTask: '' });
    // 角色自己记过的任务照常带回。
    await act(async () => { latest!.selectRole('Docs'); });
    expect(latest!.form.initialTask).toBe('Update the API reference');
  });

  // 回归(PR #9731 review)：电脑上某个 Agent 记的来源(providerId)不能在手机上被丢成「不指定」，
  // 否则切到该 Agent 后同一个模型可能走另一个来源，提交时还会把电脑记的来源覆盖掉。
  it('keeps the provider the computer remembered for an Agent when switching to it and submitting', async () => {
    const agentModel = (id: string, providerId: string | null) => ({ model: id, effort: 'low', fast: false, providerId });
    const host = hostWithRoles([{ role: 'developer' }], undefined, {
      agent: 'claude-code',
      permission: 'auto',
      agents: { codex: agentModel('codex/gpt-5.5', 'openai'), 'claude-code': agentModel('claude-opus-4-7', 'anthropic'), pi: agentModel('pi-model', null) },
    });
    await act(async () => root.render(<Probe maker={host.maker} />));
    await act(async () => { latest!.reset(); await settle(); });
    expect(latest!.form.model).toMatchObject({ id: 'claude-opus-4-7', providerId: 'anthropic' });
    await act(async () => { latest!.changeAgent('codex'); await settle(); });
    expect(latest!.form.model).toMatchObject({ id: 'codex/gpt-5.5', providerId: 'openai' });
    await act(async () => { latest!.remember(latest!.submission); await settle(); });
    expect(host.applyWorkerRoles).toHaveBeenLastCalledWith(expect.objectContaining({
      choice: expect.objectContaining({ agent: 'codex', agentModel: expect.objectContaining({ providerId: 'openai' }) }),
    }));
    // 提交后马上再打开：手头这份也带着刚提交的来源，切走再切回不会退成「不指定」。
    act(() => { latest!.reset(); });
    await act(async () => { latest!.changeAgent('claude-code'); });
    await act(async () => { latest!.changeAgent('codex'); });
    expect(latest!.form.model).toMatchObject({ id: 'codex/gpt-5.5', providerId: 'openai' });
  });

  it('keeps a form the user already changed when the role list arrives late', async () => {
    const host = hostWithRoles([{ role: 'Docs', task: 'Update the API reference', permission: 'auto' }]);
    await act(async () => root.render(<Probe maker={host.maker} />));
    await act(async () => {
      latest!.reset();
      latest!.patch({ initialTask: 'Mine' });
      await settle();
    });
    expect(latest!.roles).toEqual(['reviewer', 'Docs']);
    expect(latest!.form).toMatchObject({ role: 'reviewer', initialTask: 'Mine', permissionMode: 'bypassPermissions' });
  });

  it('keeps working with a computer too old to hold the memory: built-in roles only, last choice kept on the phone', async () => {
    const maker = fakeMaker();
    await act(async () => root.render(<Probe maker={maker} />));
    await act(async () => { latest!.reset(); await settle(); });
    expect(latest!.roles).toEqual(['reviewer', 'developer', 'tester']);
    expect(latest!.rolesEditable).toBe(false);
    await act(async () => {
      latest!.remember({ ...latest!.form, permissionMode: 'auto', initialTask: 'Check the migration' });
      await settle();
    });
    expect(maker.orca.applyWorkerRoles).not.toHaveBeenCalled();
    // 兼容旧电脑：不分角色的「上次选择」仍记在手机上，角色和任务文字不记。
    const stored = [...storage.values()].join('\n');
    expect(stored).toContain('"workerPermissionMode":"auto"');
    expect(stored).not.toMatch(/Check the migration|reviewer/);
  });

  it('starts from the computer’s last choice, not the phone’s, and switches Agents with the computer’s models', async () => {
    // 手机上还留着升级前的旧记忆：电脑能读到时不用它。
    saveOrcaWorkerCreationPrefs('user-1', { ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'pi', workerPermissionMode: 'bypassPermissions' });
    resetOrcaWorkerCreationPrefsMemory();
    const agentModel = (id: string) => ({ model: id, effort: 'low', fast: false, providerId: null });
    const host = hostWithRoles([{ role: 'developer' }], undefined, {
      agent: 'claude-code',
      permission: 'auto',
      agents: { codex: agentModel('codex/gpt-5.5'), 'claude-code': agentModel('claude-opus-4-7'), pi: agentModel('pi-model') },
    });
    await act(async () => root.render(<Probe maker={host.maker} />));
    await act(async () => { latest!.reset(); await settle(); });
    expect(latest!.form).toMatchObject({
      role: 'developer',
      agent: 'claude-code',
      permissionMode: 'auto',
      model: { id: 'claude-opus-4-7', effort: 'low' },
    });
    await act(async () => { latest!.changeAgent('codex'); await settle(); });
    expect(latest!.form.model).toMatchObject({ id: 'codex/gpt-5.5', effort: 'low' });
  });

  it('does not fall back to the phone’s memory when the computer is only unreachable, and catches up after reconnecting', async () => {
    saveOrcaWorkerCreationPrefs('user-1', { ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'auto' });
    resetOrcaWorkerCreationPrefsMemory();
    let online = false;
    const host = hostWithRoles([{ role: 'Docs', permission: 'auto' }]);
    host.getWorkerRoles.mockImplementation(async () => {
      if (!online) throw new Error('[DEVICE_OFFLINE] offline');
      return { roles: [{ role: 'Docs', permission: 'auto' }] };
    });
    function EpochProbe({ epoch }: { epoch: number }) {
      latest = useOrcaWorkerForm({ maker: host.maker, prefsScope: 'user-1', active: true, setSheetOpen: () => undefined, connectionEpoch: epoch });
      return null;
    }
    await act(async () => root.render(<EpochProbe epoch={1} />));
    await act(async () => { latest!.reset(); await settle(); });
    // 首次默认值：既不是手机上存的「自动审批」，也还没有电脑上的内容。
    expect(latest!.form).toMatchObject({ role: 'reviewer', permissionMode: 'bypassPermissions' });
    expect(latest!.rolesEditable).toBe(false);
    online = true;
    await act(async () => { root.render(<EpochProbe epoch={2} />); await settle(); });
    expect(latest!.form).toMatchObject({ role: 'Docs', permissionMode: 'auto' });
  });

  it('remembers a submission on the computer and writes nothing to the phone', async () => {
    const host = hostWithRoles([{ role: 'reviewer' }, { role: 'developer' }, { role: 'tester' }]);
    await act(async () => root.render(<Probe maker={host.maker} />));
    await act(async () => { latest!.reset(); await settle(); });
    // 点加号后输入的是内置角色的名字(界面语言下的「Review」)：按那个内置角色提交，不另建同名角色。
    await act(async () => { latest!.selectRole(null); });
    await act(async () => { latest!.patch({ role: ' review ', initialTask: 'Check the migration' }); });
    expect(latest!.submission.role).toBe('reviewer');
    await act(async () => { await latest!.modelPicker.select({ agent: 'claude-code', modelId: 'claude-opus-4-7', providerId: 'anthropic', effort: 'low', fast: false }); });
    await act(async () => { latest!.remember(latest!.submission); await settle(); });
    const agentModel = { model: 'claude-opus-4-7', effort: 'low', fast: false, providerId: 'anthropic' };
    // 角色自己的记忆，加上不分角色的「上次选择」(choice)：这次的 Agent、它的模型、手动选定的路线。
    expect(host.applyWorkerRoles).toHaveBeenLastCalledWith({
      kind: 'remember', role: 'reviewer', task: 'Check the migration', permission: 'bypassPermissions', model: route,
      choice: { agent: 'claude-code', agentModel, route },
    });
    // 手机的存储里什么都没写。
    expect(storage.size).toBe(0);

    // 任务就是这个角色自带的那句、模型不是手动选的：任务和角色的模型都不记，「上次选择」里的路线清掉。
    await act(async () => {
      latest!.remember({
        ...latest!.submission,
        initialTask: 'Take a look at the Lead’s work and give some suggestions.',
        modelSelectionExplicit: false,
      });
      await settle();
    });
    expect(host.applyWorkerRoles).toHaveBeenLastCalledWith({
      kind: 'remember', role: 'reviewer', permission: 'bypassPermissions',
      choice: { agent: 'claude-code', agentModel, route: null },
    });
    expect(storage.size).toBe(0);

    // 马上再打开：不用等电脑答复，就停在刚用过的角色上，带着它记的模型。
    act(() => { latest!.reset(); });
    expect(latest!.customRoleMode).toBe(false);
    expect(latest!.form).toMatchObject({
      role: 'reviewer', agent: 'claude-code', model: { id: 'claude-opus-4-7', providerId: 'anthropic' },
    });
    await act(async () => { await settle(); });
  });

  it('removes a role only after confirmation, moves off it, and rereads the list if the computer refuses', async () => {
    const { Alert } = await import('react-native');
    const applyWorkerRoles = vi.fn(async (_mutation: unknown): Promise<{ ok: true }> => ({ ok: true }));
    const host = hostWithRoles([{ role: 'reviewer' }, { role: 'Docs', task: 'Update the API reference' }], applyWorkerRoles);
    await act(async () => root.render(<Probe maker={host.maker} />));
    await act(async () => { latest!.reset(); await settle(); });
    const confirmRemoval = async () => {
      const confirm = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style !== 'cancel')!;
      await act(async () => { confirm.onPress?.(); await settle(); });
    };

    act(() => latest!.removeRole('reviewer'));
    // 只弹了确认，还没动清单。
    expect(applyWorkerRoles).not.toHaveBeenCalled();
    expect(latest!.roles).toEqual(['reviewer', 'Docs']);
    await confirmRemoval();
    expect(applyWorkerRoles).toHaveBeenCalledWith({ kind: 'forget', role: 'reviewer' });
    expect(latest!.roles).toEqual(['Docs']);
    expect(latest!.form).toMatchObject({ role: 'Docs', initialTask: 'Update the API reference' });

    // 电脑没改成：以它的实际清单为准，被拿掉的角色回到这一排。
    applyWorkerRoles.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] roles not ready'));
    act(() => latest!.removeRole('Docs'));
    await confirmRemoval();
    expect(host.getWorkerRoles).toHaveBeenCalledTimes(2);
    expect(latest!.roles).toEqual(['reviewer', 'Docs']);
  });
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
    orca: oldComputer(),
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

it('treats a timed-out Worker archive as unconfirmed when the recheck still lists it, and rolls back', async () => {
  const { Alert } = await import('react-native');
  const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
  const { remoteSessionStore, sessionPendingWrites } = await import('@/session/remoteSessionStore');
  remoteSessionStore.clear();
  remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [workerRow('s-1')]);
  const reseeds = vi.fn();
  const unregister = remoteSessionStore.registerReseedHandler('dev-1', reseeds);
  let collab: ReturnType<typeof useSessionOrcaCollab> | null = null;
  const listWorkers = vi.fn(async () => [{ id: 'w-1', sessionId: 's-1', role: 'developer', status: 'idle' }]);
  const maker = {
    ...fakeMaker(),
    orca: { ...oldComputer(),
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
  try {
    await act(async () => { root.render(<Host />); await flush(); });
    const loads = listWorkers.mock.calls.length;
    const worker = collab!.team.workers[0]!;
    act(() => collab!.showWorkerActions(worker));
    act(() => vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!.onPress?.());
    const confirm = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!;
    await act(async () => { confirm.onPress?.(); await flush(); await flush(); });
    expect(collab!.error).toMatch(/timed out|超时|confirm/i);
    expect(listWorkers.mock.calls.length).toBeGreaterThan(loads);
    // 回查仍在 → 回滚:任务插回原 shard、团队视图恢复、在途登记释放并 reseed。
    expect(remoteSessionStore.getSessions().map((item) => item.id)).toEqual(['s-1']);
    expect(collab!.team.workers.map((item) => item.workerId)).toEqual(['w-1']);
    expect(sessionPendingWrites.pendingFields('s-1')).toEqual([]);
    expect(reseeds).toHaveBeenCalled();
  } finally {
    unregister();
    remoteSessionStore.clear();
  }
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
    orca: { ...oldComputer(),
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
    orca: { ...oldComputer(),
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

describe('optimistic Worker archive', () => {
  type Deferred = { promise: Promise<unknown>; resolve(value?: unknown): void; reject(error: unknown): void };
  const deferred = (): Deferred => {
    let resolve!: (value?: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  async function mountCollab(params: {
    sessionId: string;
    role: 'lead' | 'worker';
    listWorkers: ReturnType<typeof vi.fn>;
    archiveWorker: ReturnType<typeof vi.fn>;
    openSession?: ReturnType<typeof vi.fn>;
  }) {
    const { useSessionOrcaCollab } = await import('@/session/useSessionOrcaCollab');
    const ref: { current: ReturnType<typeof useSessionOrcaCollab> | null } = { current: null };
    const maker = {
      ...fakeMaker(),
      orca: { ...oldComputer(),
        listWorkers: params.listWorkers,
        getCollaborationSettings: vi.fn(async () => ({})),
        getTeamByWorkerSession: vi.fn(async () => ({ leadSessionId: 'lead-1' })),
        archiveWorker: params.archiveWorker,
      },
    } as unknown as MobileMakerTransport;
    function Host() {
      ref.current = useSessionOrcaCollab({
        maker, deviceId: 'dev-1', sessionId: params.sessionId, prefsScope: 'user-1', enabled: true,
        session: { id: params.sessionId, orcaRole: params.role, workspaceKind: 'project', workingDir: '/repo', agentKind: 'codex' } as never,
        sheetView: null, sheetOpen: false, setSheetView: () => undefined, setSheetOpen: () => undefined,
        openSession: params.openSession ?? vi.fn(),
      });
      return null;
    }
    await act(async () => { root.render(<Host />); await flush(); });
    await act(async () => { await flush(); });
    return ref;
  }

  async function confirmLatestAlert() {
    const { Alert } = await import('react-native');
    const confirm = vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!;
    await act(async () => { confirm.onPress?.(); await flush(); });
  }

  it('removes the Worker from the panel and the store at once, and keeps it gone until the host confirms', async () => {
    const { Alert } = await import('react-native');
    const { remoteSessionStore, sessionPendingWrites } = await import('@/session/remoteSessionStore');
    remoteSessionStore.clear();
    // Worker 任务行在物理 shard dev-old(re-link 前的 shard),路由设备是 dev-1。
    remoteSessionStore.setDeviceSessions('dev-old', 'Old Mac', [workerRow('s-1'), workerRow('s-2')]);
    let hostArchived = false;
    const listWorkers = vi.fn(async () => [
      ...(hostArchived ? [] : [{ id: 'w-1', sessionId: 's-1', role: 'developer', status: 'idle' }]),
      { id: 'w-2', sessionId: 's-2', role: 'tester', status: 'idle' },
    ]);
    const rpc = deferred();
    const archiveWorker = vi.fn(() => rpc.promise);
    const collab = await mountCollab({ sessionId: 'lead-1', role: 'lead', listWorkers, archiveWorker });
    const reseeds = vi.fn();
    const unregister = remoteSessionStore.registerReseedHandler('dev-old', reseeds);
    try {
      act(() => collab.current!.showWorkerActions(collab.current!.team.workers[0]!));
      act(() => vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!.onPress?.());
      await confirmLatestAlert();
      expect(archiveWorker).toHaveBeenCalledWith('lead-1', 'w-1');
      expect(collab.current!.busy).toBe(false);
      expect(collab.current!.team.workers.map((worker) => worker.workerId)).toEqual(['w-2']);
      expect(remoteSessionStore.getSessions().map((item) => item.id)).toEqual(['s-2']);
      expect(sessionPendingWrites.pendingFields('s-1')).toEqual(['status']);

      // 在途期间:旧快照对账、单条读回、整表重拉都不得把它带回来。
      remoteSessionStore.setDeviceSessions('dev-old', 'Old Mac', [workerRow('s-1'), workerRow('s-2')]);
      remoteSessionStore.upsertDeviceSession('dev-old', 'Old Mac', workerRow('s-1'));
      await act(async () => { await collab.current!.team.refresh(); });
      expect(remoteSessionStore.getSessions().map((item) => item.id)).toEqual(['s-2']);
      expect(collab.current!.team.workers.map((worker) => worker.workerId)).toEqual(['w-2']);

      hostArchived = true;
      await act(async () => { rpc.resolve({ ok: true }); await flush(); await flush(); });
      expect(collab.current!.error).toBeNull();
      expect(sessionPendingWrites.pendingFields('s-1')).toEqual([]);
      expect(collab.current!.team.workers.map((worker) => worker.workerId)).toEqual(['w-2']);
      expect(remoteSessionStore.getSessions().map((item) => item.id)).toEqual(['s-2']);
      // 成功后主动对账该 shard:归档前发出、成功后才落地的旧读取由写库后的权威列表收敛。
      expect(reseeds).toHaveBeenCalled();
    } finally {
      unregister();
      remoteSessionStore.clear();
    }
  });

  it('settles a timed-out panel archive as success when the recheck no longer lists the Worker', async () => {
    const { Alert } = await import('react-native');
    const { remoteSessionStore } = await import('@/session/remoteSessionStore');
    remoteSessionStore.clear();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [workerRow('s-1')]);
    let hostArchived = false;
    const listWorkers = vi.fn(async () => (hostArchived ? [] : [{ id: 'w-1', sessionId: 's-1', role: 'developer' }]));
    const archiveWorker = vi.fn(async () => { hostArchived = true; throw new Error('[INVOKE_TIMEOUT] timed out'); });
    const collab = await mountCollab({ sessionId: 'lead-1', role: 'lead', listWorkers, archiveWorker });
    try {
      act(() => collab.current!.showWorkerActions(collab.current!.team.workers[0]!));
      act(() => vi.mocked(Alert.alert).mock.calls.at(-1)![2]!.find((button) => button.style === 'destructive')!.onPress?.());
      await confirmLatestAlert();
      await act(async () => { await flush(); });
      expect(collab.current!.error).toBeNull();
      expect(collab.current!.team.workers).toEqual([]);
      expect(remoteSessionStore.getSessions()).toEqual([]);
    } finally {
      remoteSessionStore.clear();
    }
  });

  it('returns a self-archiving Worker to the Lead before the host replies', async () => {
    const { remoteSessionStore } = await import('@/session/remoteSessionStore');
    remoteSessionStore.clear();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [workerRow('worker-1')]);
    const rpc = deferred();
    const archiveWorker = vi.fn(() => rpc.promise);
    const openSession = vi.fn();
    const listWorkers = vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-1', role: 'tester' }]);
    const collab = await mountCollab({ sessionId: 'worker-1', role: 'worker', listWorkers, archiveWorker, openSession });
    try {
      expect(collab.current!.workerSelf?.workerId).toBe('w-1');
      const closeMenu = vi.fn();
      act(() => collab.current!.confirmArchiveSelf(closeMenu));
      await confirmLatestAlert();
      expect(closeMenu).toHaveBeenCalledTimes(1);
      expect(openSession).toHaveBeenCalledWith('lead-1');
      expect(remoteSessionStore.getSessions()).toEqual([]);
      await act(async () => { rpc.resolve({ ok: true }); await flush(); });
      expect(remoteSessionStore.getSessions()).toEqual([]);
    } finally {
      remoteSessionStore.clear();
    }
  });

  it('rolls a failed self-archive back into the same shard and tells the user', async () => {
    const { Alert } = await import('react-native');
    const { remoteSessionStore, sessionPendingWrites } = await import('@/session/remoteSessionStore');
    remoteSessionStore.clear();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [workerRow('worker-1')]);
    const reseeds = vi.fn();
    const unregister = remoteSessionStore.registerReseedHandler('dev-1', reseeds);
    const rpc = deferred();
    const openSession = vi.fn();
    const listWorkers = vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-1', role: 'tester' }]);
    const collab = await mountCollab({
      sessionId: 'worker-1', role: 'worker', listWorkers, archiveWorker: vi.fn(() => rpc.promise), openSession,
    });
    try {
      act(() => collab.current!.confirmArchiveSelf());
      await confirmLatestAlert();
      expect(openSession).toHaveBeenCalledWith('lead-1');
      vi.mocked(Alert.alert).mockClear();
      await act(async () => { rpc.reject(new Error('[WORKER_NOT_FOUND] gone')); await flush(); await flush(); });
      expect(remoteSessionStore.getSessions().map((item) => item.id)).toEqual(['worker-1']);
      expect(remoteSessionStore.getSessionDeviceId('worker-1')).toBe('dev-1');
      expect(collab.current!.workerSelf?.workerId).toBe('w-1');
      expect(sessionPendingWrites.pendingFields('worker-1')).toEqual([]);
      expect(reseeds).toHaveBeenCalled();
      expect(Alert.alert).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
      remoteSessionStore.clear();
    }
  });

  it('leaves the row to a newer write when the archive was superseded before it failed', async () => {
    const { remoteSessionStore, sessionMetaWriteGuard } = await import('@/session/remoteSessionStore');
    remoteSessionStore.clear();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [workerRow('worker-1')]);
    const reseeds = vi.fn();
    const unregister = remoteSessionStore.registerReseedHandler('dev-1', reseeds);
    const rpc = deferred();
    const listWorkers = vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-1', role: 'tester' }]);
    const collab = await mountCollab({
      sessionId: 'worker-1', role: 'worker', listWorkers, archiveWorker: vi.fn(() => rpc.promise),
    });
    try {
      act(() => collab.current!.confirmArchiveSelf());
      await confirmLatestAlert();
      // 列表里随后又删除了这个任务:同会话后续 status 写取代了归档。
      sessionMetaWriteGuard.begin('worker-1', ['status', 'title', 'pinnedAt']);
      await act(async () => { rpc.reject(new Error('[INTERNAL] failed')); await flush(); await flush(); });
      expect(remoteSessionStore.getSessions()).toEqual([]);
      expect(reseeds).toHaveBeenCalled();
    } finally {
      unregister();
      remoteSessionStore.clear();
    }
  });
});
