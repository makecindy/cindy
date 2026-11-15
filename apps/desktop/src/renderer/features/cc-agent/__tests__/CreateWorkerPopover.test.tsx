import { readLocalWorkerCreationSelection } from '../../../state/workerCreationPrefs';
// @vitest-environment jsdom
import { WorkerProjectField, useWorkerProjectSelection } from '../WorkerProjectField';
import type { WorkerProjectContext } from '../../../../shared/orca-worker-project';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  DEFAULT_WORKER_CREATION_PREFS,
  applyWorkerRolesMutation,
  readWorkerCreationPrefs,
  readWorkerRolePrefs,
  toRemoteWorkerRoles,
  writeWorkerCreationPrefs,
  type WorkerCreationPrefs,
} from '@/state/workerCreationPrefs';
import { modelCatalogKey } from '../../../../shared/controlledModelCatalog';

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  __resetForTest as resetProviderModelMemoryForTest,
  getProviderModelChoice,
  getProviderModelEffort,
  setProviderModelChoice,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import {
  CreateWorkerPopover,
  isAbsoluteRemoteDir,
  parseExecutionDevices,
} from '../CreateWorkerPopover';

const mocks = vi.hoisted(() => ({
  modelsByAgent: {
    codex: [] as Array<{
      id: string;
      efforts: string[];
      defaultEffort: string | null;
      supportsFastMode?: boolean;
    }>,
    'claude-code': [] as Array<{
      id: string;
      efforts: string[];
      defaultEffort: string | null;
      supportsFastMode?: boolean;
    }>,
  },
  capabilitiesByAgent: {
    codex: null as {
      availableModels: Array<{ id: string }>;
      supportsOrcaWorkerPermissionMode?: boolean;
    } | null,
    'claude-code': null as {
      availableModels: Array<{ id: string }>;
      supportsOrcaWorkerPermissionMode?: boolean;
    } | null,
  },
  capabilitiesLoading: false,
  providersLoading: false,
  remoteUnsupported: false,
  // 「(providerId, modelId)」被可见性开关隐藏的组合(isModelEnabled mock 消费)。
  hiddenModels: [] as string[],
  // 本地已连接来源目录(narrowProviderSource 走真函数,消费这份最小 ProviderView 形状)。
  localProviders: [] as Array<{
    id: string;
    name: string;
    connected: boolean;
    agents: string[];
    routing?: Record<string, { wireProtocol?: string }>;
    models: Record<
      string,
      Array<{
        id: string;
        supportsFastMode?: boolean;
        efforts?: string[];
        defaultEffort?: string | null;
        mode?: string;
        /** 停用轴(buildRegistry 烘焙的视图层标志;narrowProviderSource 消费)。 */
        disabled?: boolean;
      }>
    >;
  }>,
  // 被控端 provider 快照(device-link 创建;providerFastSupported 的远程口径消费)。
  remoteProviders: [] as Array<{
    id: string;
    name: string;
    connected: boolean;
    remoteInvocationEnabled?: boolean;
    agents: string[];
    models: Record<
      string,
      Array<{
        id: string;
        supportsFastMode?: boolean;
        efforts?: string[];
        defaultEffort?: string | null;
      }>
    >;
  }>,
  sidebarWindow: false,
  confirm: vi.fn(async () => true),
  directoryPath: '/Users/demo/Interviews',
  // useDeviceProviders 最近一次读的电脑(Worker 的模型目录按哪台读)。
  deviceProvidersFor: undefined as string | undefined,
}));

vi.mock('@/components/new-chat/AddRemoteProjectDialog', () => ({
  AddRemoteProjectDialog: (props: {
    open: boolean; fixedDeviceId: string; onOpenChange(open: boolean): void;
    onProjectAdded(target: { kind: 'device-link'; deviceId: string; deviceName: string; path: string }): void;
  }) => props.open ? <button data-testid="choose-worker-folder" data-device={props.fixedDeviceId}
    onClick={() => {
      props.onProjectAdded({ kind: 'device-link', deviceId: props.fixedDeviceId, deviceName: 'Mac mini', path: mocks.directoryPath });
      props.onOpenChange(false);
    }}>Choose worker folder</button> : null,
}));

function model(id: string, efforts = ['high'], defaultEffort = 'high') {
  return { id, efforts, defaultEffort, supportsFastMode: true };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) =>
    key.startsWith('orca.workerProject.') && values ? `${key} ${Object.values(values).join(' ')}` : key }),
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: (agent: 'codex' | 'claude-code') => ({
    capabilities: mocks.capabilitiesByAgent[agent],
    loading: mocks.capabilitiesLoading,
    error: null,
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: mocks.localProviders.map((provider) => ({
      ...provider,
      routing: provider.routing ?? Object.fromEntries(provider.agents.map((agent) => [agent, {}])),
    })),
    loading: mocks.providersLoading,
  }),
}));

vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: (deviceId?: string) => ({
    ...((mocks.deviceProvidersFor = deviceId), {}),
    unsupported: mocks.remoteUnsupported,
    providers: mocks.remoteProviders.map((provider) => ({
      ...provider,
      routing: Object.fromEntries(provider.agents.map((agent) => [agent, {}])),
    })),
    loading: mocks.providersLoading,
    error: null,
  }),
}));

vi.mock('@/lib/sidebarWindow', () => ({
  isSidebarWindow: () => mocks.sidebarWindow,
}));

// 只覆写 useNavigate,保留真实导出:全量 mock 会连带打断任何间接依赖(copilot review)。
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    onUnifiedSelect?: (selection: { engine: 'cc' | 'codex'; modelId: string; providerId: string; effort: string; fast: boolean; favoriteUid: null }) => void;
    effort?: string;
    currentProviderId?: string | null;
    onProviderChange?: (providerId: string | null, modelId?: string, effort?: string, fast?: boolean) => void;
    onEffortChange: (effort: string) => void;
    reselectEmitsChange?: boolean;
    fastMode?: boolean;
    onFastModeChange?: (enabled: boolean) => void;
    onNavigateToProviders?: () => void;
    modelMemory?: unknown;
    remoteAgent?: { selectedDeviceId: string | null; homeDeviceId?: string; devices: Array<{ deviceId: string }> };
    agentDevice?: { deviceId: string } | null;
  }) => (
    <div
      data-testid="model-selector"
      data-remote-selected={props.remoteAgent ? String(props.remoteAgent.selectedDeviceId) : 'none'}
      data-remote-home={props.remoteAgent?.homeDeviceId ?? ''}
      data-agent-device={props.agentDevice?.deviceId ?? ''}
      // onProviderChange 是「供应商分段模式」的开关(面板内部 sourcesEnabled 判据),
      // fastMode/onFastModeChange 是行级配置列的 Fast 开关(替代外置 FastModeToggle)。
      data-sources-enabled={String(props.onProviderChange !== undefined)}
      data-current-provider={props.currentProviderId ?? ''}
      data-reselect-emits={String(props.reselectEmitsChange === true)}
      data-fast-wired={String(props.onFastModeChange !== undefined)}
      data-memory-wired={String(props.modelMemory !== undefined)}
      data-navigate-wired={String(props.onNavigateToProviders !== undefined)}
      data-effort={props.effort ?? ''}
    >
      {props.modelId}
      <button data-testid="pick-claude-model" onClick={() => props.onUnifiedSelect?.({ engine: 'cc', modelId: 'claude-sonnet-4-6', providerId: 'anthropic', effort: 'high', fast: false, favoriteUid: null })} />
      <button data-testid="pick-codex-config" onClick={() => props.onUnifiedSelect?.({ engine: 'codex', modelId: 'gpt-5.5', providerId: 'xd', effort: 'low', fast: false, favoriteUid: null })} />
      {/* 远程供应商栏里的行带着它所属的电脑(null = 任务所在电脑)。 */}
      <button data-testid="pick-shared-codex" onClick={() => (props.onUnifiedSelect as ((selection: unknown) => void) | undefined)?.({ engine: 'codex', modelId: 'codex/gpt-5.5', providerId: 'openai', effort: 'high', fast: false, favoriteUid: null, agentDevice: { deviceId: 'share:s1', name: 'Shared' } })} />
      <button data-testid="pick-remote-codex" onClick={() => (props.onUnifiedSelect as ((selection: unknown) => void) | undefined)?.({ engine: 'codex', modelId: 'codex/gpt-5.5', providerId: 'openai', effort: 'high', fast: false, favoriteUid: null, agentDevice: { deviceId: 'agent-pc', name: 'Agent PC' } })} />
      <button data-testid="pick-home-codex" onClick={() => (props.onUnifiedSelect as ((selection: unknown) => void) | undefined)?.({ engine: 'codex', modelId: 'codex/gpt-5.5', providerId: 'xd', effort: 'high', fast: false, favoriteUid: null, agentDevice: null })} />
      <button
        type="button"
        data-testid="pick-openai-row"
        onClick={() => props.onProviderChange?.('openai', 'gpt-5.5', 'medium', true)}
      />
      {/* 真组件选行只回传两参(见 ModelSelector.handleRowSelect),记忆恢复走全局预设。 */}
      <button
        type="button"
        data-testid="pick-openai-row-bare"
        onClick={() => props.onProviderChange?.('openai', 'gpt-5.5')}
      />
      <button
        type="button"
        data-testid="edit-active-effort"
        onClick={() => props.onEffortChange('low')}
      />
      <button
        type="button"
        data-testid="pick-xd-row-bare"
        onClick={() => props.onProviderChange?.('xd', 'gpt-5.5')}
      />
    </div>
  ),
}));

vi.mock('@/components/new-chat/PermissionSelector', () => ({
  PermissionSelector: (props: {
    permissionMode: 'auto' | 'bypassPermissions';
    onPermissionModeChange: (mode: 'auto' | 'bypassPermissions') => void;
    allowedModes?: string[];
  }) => (
    <button
      type="button"
      data-testid="permission-selector"
      data-mode={props.permissionMode}
      data-allowed={props.allowedModes?.join(',') ?? ''}
      onClick={() =>
        props.onPermissionModeChange(
          props.permissionMode === 'auto' ? 'bypassPermissions' : 'auto',
        )
      }
    >
      {props.permissionMode}
    </button>
  ),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: (_agent: string, providerId: string, m: { id: string }) =>
    !mocks.hiddenModels.includes(`${providerId}:${m.id}`),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('../workerModelAvailability', () => ({
  selectWorkerModels: ({ agent }: { agent: 'codex' | 'claude-code' }) => mocks.modelsByAgent[agent],
}));

/** 项目与运行设备收在「更多设置」里(收起时按钮名带当前取值),展开后才能操作。 */
async function openMoreSettings() {
  fireEvent.click(await screen.findByRole('button', { name: /^orca\.createWorker\.moreSettings/ }));
}

/**
 * 远程控制的任务所在的那台电脑(被控端)的替身，只接协同记忆这两个通道。
 *  - `memoryHost`：能保存记忆的电脑，读写走生产的 toRemoteWorkerRoles / applyWorkerRolesMutation。
 *  - `oldHost`：版本太旧、没有这组通道，操作端沿用自己原来的本地记忆。
 */
function installRemoteHost(kind: 'memoryHost' | 'oldHost', initial: WorkerCreationPrefs = DEFAULT_WORKER_CREATION_PREFS) {
  let prefs = initial;
  const invoke = vi.fn(async (_device: string, channel: string, args?: unknown[]) => {
    if (!channel.startsWith('maker:worker-roles:')) return undefined;
    if (kind === 'oldHost') throw new Error(`[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel '${channel}' is not allowed`);
    if (channel === 'maker:worker-roles:get') return toRemoteWorkerRoles(prefs, 'host-owner');
    prefs = applyWorkerRolesMutation(prefs, 'host-owner', args![0] as never);
    return { ok: true };
  });
  const host = window as unknown as { electronAPI?: unknown };
  host.electronAPI = { deviceLink: { invoke } };
  onTestFinished(() => { delete host.electronAPI; });
  return { invoke, prefs: () => prefs };
}

describe('CreateWorkerPopover', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // providerModelMemory 有进程内 cache,只清 localStorage 会把记忆泄漏到后续用例。
    resetProviderModelMemoryForTest();
    mocks.modelsByAgent.codex = [model('codex/gpt-5.5')];
    mocks.modelsByAgent['claude-code'] = [model('claude-opus-4-7')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'codex/gpt-5.5' }] };
    mocks.capabilitiesByAgent['claude-code'] = {
      availableModels: [{ id: 'claude-opus-4-7' }],
    };
    mocks.capabilitiesLoading = false;
    mocks.providersLoading = false;
    mocks.localProviders = [];
    mocks.remoteProviders = [];
    mocks.remoteUnsupported = false;
    mocks.hiddenModels = [];
    mocks.sidebarWindow = false;
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetProviderModelMemoryForTest();
  });

  it('centers the setup and uses one model picker without a competing Harness control', () => {
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);

    const panel = screen.getByText('orca.createWorker.title').closest('.relative.z-10');
    const overlay = panel?.parentElement;
    expect(overlay?.className).toContain('items-center');
    expect(overlay?.className).not.toContain('items-start');
    expect(overlay?.className).not.toContain('pt-[10vh]');
    expect(panel?.className).toContain('w-[500px]');
    expect(panel?.className).toContain('p-6');

    expect(screen.queryByRole('tablist', { name: 'orca.createWorker.agentLabel' })).toBeNull();
    // 模型与权限和首条任务在同一个输入框里:一个模型面板、一个权限选择,没有另外的 Agent 切换。
    const taskBox = screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' })
      .parentElement!;
    expect(within(taskBox).getAllByTestId('model-selector')).toHaveLength(1);
    expect(
      within(within(taskBox).getByTestId('worker-permission-mode'))
        .getByTestId('permission-selector')
        .getAttribute('data-allowed'),
    ).toBe('auto,bypassPermissions');
  });

  it('keeps the draft when clicking the scrim and closes via the explicit button', () => {
    const onClose = vi.fn();
    render(<CreateWorkerPopover open onClose={onClose} onCreate={vi.fn()} />);

    const initialTask = screen.getByPlaceholderText(
      'orca.createWorker.initialTaskPlaceholder',
    ) as HTMLTextAreaElement;
    fireEvent.change(initialTask, { target: { value: 'Draft a plan' } });
    const panel = screen.getByText('orca.createWorker.title').closest('.relative.z-10');
    fireEvent.click(panel!.closest('.modal-scrim')!);

    expect(onClose).not.toHaveBeenCalled();
    expect(initialTask.value).toBe('Draft a plan');

    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.closeAria' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('focuses the first task, traps Tab, closes with Esc, and returns focus on reopen', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Add worker</button><CreateWorkerPopover open={open} onClose={() => setOpen(false)} onCreate={vi.fn()} /></>;
    }
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Add worker' });
    for (let attempt = 0; attempt < 2; attempt++) {
      await user.click(opener);
      expect(document.activeElement).toBe(screen.getByPlaceholderText('orca.createWorker.initialTaskPlaceholder'));
      const close = screen.getByRole('button', { name: 'orca.createWorker.closeAria' });
      const submit = screen.getByRole('button', { name: 'orca.createWorker.submit' });
      close.focus();
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(submit);
      await user.tab();
      expect(document.activeElement).toBe(close);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
    }
  });

  it.each([
    ['role', 'orca.createWorker.roleLabel', { isComposing: true }],
    ['role', 'orca.createWorker.roleLabel', { keyCode: 229 }],
    ['task', 'orca.createWorker.initialTaskPlaceholder', { isComposing: true }],
    ['task', 'orca.createWorker.initialTaskPlaceholder', { keyCode: 229 }],
  ] as const)('preserves the %s draft in %s on IME Esc (%j)', (_field, placeholder, ime) => {
    const onClose = vi.fn();
    render(<CreateWorkerPopover open onClose={onClose} onCreate={vi.fn()} />);
    if (_field === 'role') {
      fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.addRole' }));
    }
    const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement | HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Worker draft' } });
    input.focus();

    fireEvent.keyDown(input, { key: 'Escape', ...ime });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(input.value).toBe('Worker draft');
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks both Esc and the close button until creation settles', async () => {
    let finish!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CreateWorkerPopover open onClose={onClose} onCreate={onCreate} />);
    await user.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    expect(onCreate).toHaveBeenCalledOnce();
    const close = screen.getByRole('button', { name: 'orca.createWorker.closeAria' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    await user.keyboard('{Escape}');
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => finish());
    expect(close.disabled).toBe(false);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  // 测试价值:预设决定提交的角色名和首条任务,是这张表单对用户的主要承诺。
  // 生产入口 CreateWorkerPopover → onCreate;此前只有「角色名是个名字」的静态标签断言。
  // 最小失败输入:在已有任务里选「审查」后直接提交;换预设后保留用户改过的任务;草稿不预填。unit/jsdom。
  it('submits the preset role with its starter task and keeps a task the user edited', async () => {
    const onCreate = vi.fn();
    // 已有任务里的本机 Lead 会读取项目目录;给出一个普通仓库,让表单处于可提交状态。
    const repo = { directory: '/repo', baseRepo: '/repo', branch: 'main', exists: true, dirty: false, isWorktree: false };
    const host = window as unknown as { electronAPI?: unknown };
    host.electronAPI = { localDb: { orcaWorkflows: { projectContext: vi.fn().mockResolvedValue({
      recordedDirectory: '/repo', inherited: repo, selected: repo, dialogue: false, projects: [],
    }) } } };
    onTestFinished(() => { delete host.electronAPI; });
    render(<CreateWorkerPopover open leadSessionId="lead" onClose={vi.fn()} onCreate={onCreate} />);
    const task = screen.getByRole('textbox', {
      name: 'orca.createWorker.initialTaskLabel',
    }) as HTMLTextAreaElement;
    const pick = (id: string) =>
      fireEvent.click(screen.getByRole('radio', { name: `orca.createWorker.templates.${id}.name` }));

    // 第一次打开停在排第一的「审查」，任务框里是它自带的首条任务。
    expect(
      screen
        .getByRole('radio', { name: 'orca.createWorker.templates.reviewer.name' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(task.value).toBe('orca.createWorker.templates.reviewer.task');
    // 没动过的预设任务跟着预设换,不留上一个预设的内容。
    pick('tester');
    expect(task.value).toBe('orca.createWorker.templates.tester.task');
    pick('developer');
    expect(task.value).toBe('');

    pick('reviewer');
    fireEvent.change(task, { target: { value: 'Only check the login flow' } });
    pick('tester');
    expect(task.value).toBe('Only check the login flow');
    const submit = screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      role: 'tester',
      initialTask: 'Only check the login flow',
    });
  });

  it('does not prefill a review task in a new-task draft, where the Lead has no work yet', async () => {
    // 分离侧栏窗口不读项目，表单立即可提交；已有任务里的「审查」带着自带的一句话。
    mocks.sidebarWindow = true;
    const inTask = render(
      <CreateWorkerPopover open leadSessionId="lead" onClose={vi.fn()} onCreate={vi.fn()} />,
    );
    const task = () =>
      screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' }) as HTMLTextAreaElement;
    expect(task().value).toBe('orca.createWorker.templates.reviewer.task');
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(task().value).toBe('orca.createWorker.templates.reviewer.task'));
    inTask.unmount();

    // 原样提交的自带任务不算用户写的文字：到了还没有工作可查的草稿里，任务框仍是空的。
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(
      screen
        .getByRole('radio', { name: 'orca.createWorker.templates.reviewer.name' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(task().value).toBe('');
  });

  // 测试价值:用户要求预设可增减，并且每个角色各自记住上次的文字、模型和权限(2026-11-10)。
  // 生产入口 CreateWorkerPopover 的提交、再次打开、切换与移除;此前只有全局一份模型与权限记忆,
  // 角色与任务文字都不记。最小失败输入:自定义角色用一套设置提交 → 内置角色换另一套提交 →
  // 再次打开后在两者之间切换 → 移除自定义角色。unit/jsdom。
  it('keeps a custom role as a removable preset with its own task, model and permission', async () => {
    const user = userEvent.setup();
    const radio = (name: string) => screen.getByRole('radio', { name });
    const builtin = (id: string) => radio(`orca.createWorker.templates.${id}.name`);
    const submit = () => user.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    const task = () =>
      screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' }) as HTMLTextAreaElement;
    const model = () => screen.getByTestId('model-selector').firstChild?.textContent;
    const permission = () => screen.getByTestId('permission-selector').dataset.mode;

    // 自定义角色：自己的任务文字、Claude 模型、自动审批。
    const onCreate = vi.fn();
    const first = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await user.click(screen.getByRole('button', { name: 'orca.createWorker.addRole' }));
    await user.type(screen.getByRole('textbox', { name: 'orca.createWorker.roleLabel' }), 'researcher');
    await user.type(task(), 'Read the changelog');
    await user.click(screen.getByTestId('pick-claude-model'));
    await waitFor(() => expect(model()).toBe('claude-opus-4-7'));
    await user.click(screen.getByTestId('permission-selector'));
    expect(permission()).toBe('auto');
    await submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    first.unmount();

    // 再次打开回到它，带着上次的内容；任务框拿到焦点，角色名不再需要输入。
    const second = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(radio('researcher').getAttribute('aria-checked')).toBe('true');
    expect(task().value).toBe('Read the changelog');
    expect(model()).toBe('claude-opus-4-7');
    expect(permission()).toBe('auto');
    expect(document.activeElement).toBe(task());
    expect(screen.queryByRole('textbox', { name: 'orca.createWorker.roleLabel' })).toBeNull();
    // 换到没记过内容的内置角色：任务换成它的默认(空)，模型和权限保持不动，再给它另一套设置。
    await user.click(builtin('developer'));
    expect(task().value).toBe('');
    expect(model()).toBe('claude-opus-4-7');
    await user.click(screen.getByTestId('pick-codex-config'));
    await waitFor(() => expect(model()).toBe('codex/gpt-5.5'));
    await user.click(screen.getByTestId('permission-selector'));
    await waitFor(() => expect(permission()).toBe('bypassPermissions'));
    await submit();
    second.unmount();

    // 两个角色各记各的：在它们之间切换，文字、模型、权限一起换。
    const third = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(builtin('developer').getAttribute('aria-checked')).toBe('true');
    expect(model()).toBe('codex/gpt-5.5');
    expect(permission()).toBe('bypassPermissions');
    await user.click(radio('researcher'));
    expect(task().value).toBe('Read the changelog');
    expect(model()).toBe('claude-opus-4-7');
    expect(permission()).toBe('auto');

    // 移除正在选中的自定义角色：换到剩下的第一个(最近用的「开发」)，带回它的设置；
    // 被移除角色记下的文字不留在任务框里。
    await user.click(
      within(radio('researcher').parentElement!).getByRole('button', {
        name: 'orca.createWorker.removePreset',
      }),
    );
    expect(screen.queryByRole('radio', { name: 'researcher' })).toBeNull();
    expect(builtin('developer').getAttribute('aria-checked')).toBe('true');
    expect(task().value).toBe('');
    expect(model()).toBe('codex/gpt-5.5');
    expect(permission()).toBe('bypassPermissions');
    third.unmount();

    // 移除立即生效，不用等下一次提交。
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: 'researcher' })).toBeNull();
    expect(builtin('developer').getAttribute('aria-checked')).toBe('true');
  });

  // 任务文字是用户内容：换账号后不能看到上一个账号加的角色和它记的文字。
  it('does not show another account’s roles or remembered task', async () => {
    const user = userEvent.setup();
    onTestFinished(() => setDataOwnerGeneration(null));
    setDataOwnerGeneration('owner-a');
    const first = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'orca.createWorker.addRole' }));
    await user.type(screen.getByRole('textbox', { name: 'orca.createWorker.roleLabel' }), 'researcher');
    await user.type(
      screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' }),
      'Private notes',
    );
    await user.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    first.unmount();

    setDataOwnerGeneration('owner-b');
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: 'researcher' })).toBeNull();
    expect(
      screen
        .getByRole('radio', { name: 'orca.createWorker.templates.reviewer.name' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      (screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' }) as HTMLTextAreaElement)
        .value,
    ).toBe('');
  });

  // 测试价值:角色清单与记忆以任务所在的电脑为准(2026-11-10 用户裁决)，远程控制的任务不读写
  // 操作端自己的记忆。生产入口 CreateWorkerPopover(deviceId 表示任务在另一台电脑)。此前远程任务
  // 用的是操作端本机的记忆。最小失败输入:那台电脑有一份与本机不同的清单;那台电脑版本太旧读不到。
  // unit/jsdom,只模拟远程调用。
  describe('remote task roles', () => {
    const host = window as unknown as { electronAPI?: unknown };
    const builtin = (id: string) => `orca.createWorker.templates.${id}.name`;
    const names = () => screen.queryAllByRole('radio').map((item) => item.textContent);
    const task = () =>
      screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' }) as HTMLTextAreaElement;
    const useRemote = (invoke: ReturnType<typeof vi.fn>) => {
      host.electronAPI = { deviceLink: { invoke } };
      onTestFinished(() => { delete host.electronAPI; });
      // 那台电脑支持为 Worker 单独选权限。
      mocks.capabilitiesByAgent['claude-code'] = {
        availableModels: [{ id: 'claude-opus-4-7' }],
        supportsOrcaWorkerPermissionMode: true,
      } as never;
    };

    it('lists, restores, remembers and removes roles on the controlled computer only', async () => {
      const user = userEvent.setup();
      const invoke = vi.fn(async (_device: string, channel: string) =>
        channel === 'maker:worker-roles:get'
          ? { roles: [
              { role: 'researcher', task: 'Read the changelog', permission: 'auto' },
              { role: 'reviewer' },
              { role: 'developer' },
            ] }
          : { ok: true });
      useRemote(invoke);
      // 本机上次用的是另一个模型：远程任务不拿它垫底，那台电脑没给「上次选择」时按首次默认值。
      window.localStorage.setItem(
        'workerCreationPrefs',
        JSON.stringify({ lastAgent: 'claude-code', 'claude-code': { model: 'local-only-model', effort: 'high', fast: false } }),
      );
      // 本机自己的清单里有另一个角色，远程任务不该看到它。
      writeWorkerCreationPrefs(
        applyWorkerRolesMutation(readWorkerCreationPrefs(), null, { kind: 'remember', role: 'local-only' }),
      );
      const stored = window.localStorage.getItem('workerCreationPrefs');
      const onCreate = vi.fn();
      render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);

      // 那台电脑的清单与顺序；它移除过的「测试」不出现；第一个角色带回它记的内容。
      await waitFor(() => expect(names()).toEqual(['researcher', builtin('reviewer'), builtin('developer')]));
      expect(screen.getByRole('radio', { name: 'researcher' }).getAttribute('aria-checked')).toBe('true');
      expect(task().value).toBe('Read the changelog');
      expect(screen.getByTestId('permission-selector').dataset.mode).toBe('auto');
      expect(screen.getByTestId('model-selector').textContent).not.toContain('local-only-model');

      // 移除：改的是那台电脑的清单。
      await user.click(
        within(screen.getByRole('radio', { name: builtin('developer') }).parentElement!).getByRole('button', {
          name: 'orca.createWorker.removePreset',
        }),
      );
      expect(names()).toEqual(['researcher', builtin('reviewer')]);
      expect(invoke).toHaveBeenLastCalledWith('device-a', 'maker:worker-roles:apply', [
        { kind: 'forget', role: 'developer' },
      ]);

      // 创建：这次的内容记到那台电脑上，本机的记忆原封不动。
      await user.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
      expect(invoke).toHaveBeenLastCalledWith('device-a', 'maker:worker-roles:apply', [
        expect.objectContaining({
          kind: 'remember',
          role: 'researcher',
          task: 'Read the changelog',
          permission: 'auto',
          // 不分角色的「上次选择」也一并交给那台电脑。
          choice: expect.objectContaining({ agent: expect.any(String) }),
        }),
      ]);
      // 这台电脑的记忆一个字都没动：角色、上次用的 Agent / 模型 / 权限都没写。
      expect(window.localStorage.getItem('workerCreationPrefs')).toBe(stored);
    });

    it('opens on the controlled computer’s last choice and brings a remembered route back from it', async () => {
      // 那台电脑上次用的是 Codex 的 gpt-host、自动审批；这台电脑自己上次用的是别的。
      const remote = installRemoteHost('memoryHost', {
        ...DEFAULT_WORKER_CREATION_PREFS,
        lastAgent: 'codex',
        codex: { model: 'gpt-host', effort: 'high', fast: false, providerId: null },
        workerPermissionMode: 'auto',
      });
      // 那台电脑支持为 Worker 单独选权限(按 Lead 的 Agent 读)。
      mocks.capabilitiesByAgent['claude-code'] = {
        availableModels: [{ id: 'claude-opus-4-7' }],
        supportsOrcaWorkerPermissionMode: true,
      } as never;
      mocks.capabilitiesByAgent.codex = {
        availableModels: [{ id: 'gpt-host' }, { id: 'gpt-other' }],
        supportsOrcaWorkerPermissionMode: true,
      } as never;
      mocks.modelsByAgent.codex = [model('gpt-host'), model('gpt-other')];
      window.localStorage.setItem(
        'workerCreationPrefs',
        JSON.stringify({ lastAgent: 'claude-code', workerPermissionMode: 'bypassPermissions' }),
      );
      const stored = window.localStorage.getItem('workerCreationPrefs');
      const onCreate = vi.fn();
      const view = render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);
      await waitFor(() => expect(screen.getByTestId('model-selector').textContent).toContain('gpt-host'));
      expect(screen.getByTestId('permission-selector').dataset.mode).toBe('auto');

      fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
      expect(onCreate.mock.calls[0]![0]).toMatchObject({ agent: 'codex', model: 'gpt-host' });
      // 记在那台电脑上：它的「上次选择」仍是这次用的，这台电脑什么都没写。
      await waitFor(() => expect(remote.prefs()).toMatchObject({
        lastAgent: 'codex', codex: { model: 'gpt-host' }, workerPermissionMode: 'auto',
      }));
      expect(window.localStorage.getItem('workerCreationPrefs')).toBe(stored);
      view.unmount();
    });

    // 回归(PR #9731 review)：被控端给某个 Agent 记的来源(providerId)要带回，不能因为任务在另一台电脑
    // 就置空；否则同一个模型可能走别的来源，提交时还会把被控端记的来源写成「不指定」。
    it('brings back the provider the controlled computer remembered for its last Agent', async () => {
      const remote = installRemoteHost('memoryHost', {
        ...DEFAULT_WORKER_CREATION_PREFS,
        lastAgent: 'codex',
        codex: { model: 'gpt-host', effort: 'high', fast: false, providerId: 'xd' },
      });
      mocks.capabilitiesByAgent['claude-code'] = {
        availableModels: [{ id: 'claude-opus-4-7' }],
        supportsOrcaWorkerPermissionMode: true,
      } as never;
      mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-host' }] } as never;
      mocks.modelsByAgent.codex = [model('gpt-host')];
      mocks.remoteProviders = [{
        id: 'xd', name: 'XD', connected: true, agents: ['codex'], models: { codex: [model('gpt-host')] },
      }];
      const onCreate = vi.fn();
      render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);
      await waitFor(() => expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('xd'));
      fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
      expect(onCreate.mock.calls[0]![0]).toMatchObject({ agent: 'codex', model: 'gpt-host', providerId: 'xd' });
      await waitFor(() => expect(remote.prefs().codex.providerId).toBe('xd'));
    });

    // 回归(PR #9731 review)：用户在那台电脑的记忆读回来之前就动了表单，读回来的「上次选择」仍要接过来，
    // 之后切换 Agent 才按它的记忆恢复，而不是退回首次默认值。生产入口 CreateWorkerPopover；最小失败
    // 输入：读取未返回时点一下表单 → 读取返回(Codex 记的是 gpt-host) → 切到 Codex。
    it('keeps the controlled computer’s last choice for later switches when the form was touched before it arrived', async () => {
      mocks.remoteUnsupported = true;
      installRemoteHost('memoryHost', {
        ...DEFAULT_WORKER_CREATION_PREFS,
        codex: { model: 'gpt-host', effort: 'high', fast: false, providerId: null },
      });
      mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-other' }, { id: 'gpt-host' }] } as never;
      mocks.modelsByAgent.codex = [model('gpt-other'), model('gpt-host')];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const real = (window as unknown as { electronAPI: { deviceLink: { invoke: ReturnType<typeof installRemoteHost>['invoke'] } } })
        .electronAPI.deviceLink.invoke;
      (window as unknown as { electronAPI: { deviceLink: { invoke: unknown } } }).electronAPI.deviceLink.invoke =
        vi.fn(async (device: string, channel: string, args?: unknown[]) => {
          if (channel === 'maker:worker-roles:get') await gate;
          return real(device, channel, args);
        });
      render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={vi.fn()} />);
      fireEvent.click(screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' }));
      release();
      // 读取返回并被处理完(微任务排空)再切 Agent。
      await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
      // 先切到 Claude 再切回 Codex：回到 Codex 时按那台电脑记的模型恢复。
      fireEvent.click(screen.getByRole('tab', { name: 'Claude' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
      await waitFor(() => expect(screen.getByTestId('model-selector').textContent).toContain('gpt-host'));
    });

    it('opens on first-time defaults without touching local memory when the computer is only unreachable', async () => {
      const invoke = vi.fn(async (_device: string, channel: string) => {
        if (channel === 'maker:worker-roles:get') throw new Error('[DEVICE_LINK_TIMEOUT] no reply');
        return { ok: true };
      });
      useRemote(invoke);
      window.localStorage.setItem('workerCreationPrefs', JSON.stringify({ workerPermissionMode: 'auto' }));
      const stored = window.localStorage.getItem('workerCreationPrefs');
      const onCreate = vi.fn();
      render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('device-a', 'maker:worker-roles:get', []));
      await act(async () => {});
      // 不是这台电脑存的「自动审批」。
      expect(screen.getByTestId('permission-selector').dataset.mode).toBe('bypassPermissions');
      fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
      // 创建时仍交给那台电脑去记；这台电脑不留副本。
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('device-a', 'maker:worker-roles:apply', [
        expect.objectContaining({ kind: 'remember', choice: expect.anything() }),
      ]));
      expect(window.localStorage.getItem('workerCreationPrefs')).toBe(stored);
    });

    it('keeps working with a computer too old to hold the memory: built-in roles, last choice kept on this computer', async () => {
      const user = userEvent.setup();
      const { invoke } = installRemoteHost('oldHost');
      mocks.capabilitiesByAgent['claude-code'] = {
        availableModels: [{ id: 'claude-opus-4-7' }],
        supportsOrcaWorkerPermissionMode: true,
      } as never;
      window.localStorage.setItem('workerCreationPrefs', JSON.stringify({ workerPermissionMode: 'auto' }));
      const onCreate = vi.fn();
      render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);
      // 模型面板也会向那台电脑读数据，这里只数协同记忆的读写。
      const roleCalls = () =>
        invoke.mock.calls.map((call) => call[1]).filter((channel) => String(channel).includes('worker-roles'));
      await waitFor(() => expect(roleCalls()).toEqual(['maker:worker-roles:get']));
      // 兼容旧电脑：这台电脑原来记的「自动审批」照常带回。
      await waitFor(() => expect(screen.getByTestId('permission-selector').dataset.mode).toBe('auto'));
      expect(names()).toEqual([builtin('reviewer'), builtin('developer'), builtin('tester')]);
      // 读不到就改不了：不提供移除，创建时也不往那台电脑写，仍记在这台电脑上。
      expect(screen.queryAllByRole('button', { name: 'orca.createWorker.removePreset' })).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
      expect(roleCalls()).toEqual(['maker:worker-roles:get']);
      expect(readWorkerCreationPrefs().lastAgent).toBe(onCreate.mock.calls[0]![0].agent);
      expect(readWorkerRolePrefs(readWorkerCreationPrefs(), null).recentRoles).toEqual([]);
    });
  });

  // 被控端一侧:手机或远程控制的电脑发来的改动落到这台电脑的记忆里，这台电脑的弹窗和它镜像给
  // 远程读取的清单都看得到。生产入口 applyWorkerRolesMutation / toRemoteWorkerRoles 与弹窗。
  it('applies a change from a phone or another computer to this computer’s roles', async () => {
    const model = { agent: 'claude-code' as const, agentDeviceId: null, model: 'claude-opus-4-7', effort: 'high', fast: false, providerId: null };
    writeWorkerCreationPrefs(
      applyWorkerRolesMutation(readWorkerCreationPrefs(), null, {
        kind: 'remember', role: 'researcher', task: 'Read the changelog', permission: 'auto', model,
      }),
    );
    writeWorkerCreationPrefs(
      applyWorkerRolesMutation(readWorkerCreationPrefs(), null, { kind: 'forget', role: 'tester' }),
    );
    expect(toRemoteWorkerRoles(readWorkerCreationPrefs(), null).roles).toEqual([
      { role: 'researcher', task: 'Read the changelog', permission: 'auto', model },
      { role: 'reviewer' },
      { role: 'developer' },
    ]);
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'researcher' }).getAttribute('aria-checked')).toBe('true');
    expect(
      (screen.getByRole('textbox', { name: 'orca.createWorker.initialTaskLabel' }) as HTMLTextAreaElement).value,
    ).toBe('Read the changelog');
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').firstChild?.textContent).toBe('claude-opus-4-7'));
    expect(screen.getByTestId('permission-selector').dataset.mode).toBe('auto');
    expect(screen.queryByRole('radio', { name: 'orca.createWorker.templates.tester.name' })).toBeNull();

    // 只带角色内容的改动不碰「上次选择」；带 choice 的才更新它，路线可以记下也可以清掉。
    const before = toRemoteWorkerRoles(readWorkerCreationPrefs(), null).defaults;
    expect(before).toMatchObject({ agent: DEFAULT_WORKER_CREATION_PREFS.lastAgent, permission: 'bypassPermissions' });
    expect(before?.model).toBeUndefined();
    const agentModel = { model: 'claude-opus-4-7', effort: 'low', fast: false, providerId: null };
    writeWorkerCreationPrefs(
      applyWorkerRolesMutation(readWorkerCreationPrefs(), null, {
        kind: 'remember', role: 'researcher', permission: 'auto',
        choice: { agent: 'claude-code', agentModel, route: model },
      }),
    );
    expect(toRemoteWorkerRoles(readWorkerCreationPrefs(), null).defaults).toMatchObject({
      agent: 'claude-code', permission: 'auto', agents: { 'claude-code': agentModel }, model,
    });
    writeWorkerCreationPrefs(
      applyWorkerRolesMutation(readWorkerCreationPrefs(), null, {
        kind: 'remember', role: 'researcher', choice: { agent: 'claude-code', route: null },
      }),
    );
    expect(toRemoteWorkerRoles(readWorkerCreationPrefs(), null).defaults?.model).toBeUndefined();
  });

  // 回归(PR #9731 review)：弹窗打开期间手机或另一台电脑改了这台电脑的角色清单(App 直接写进存储)，
  // 提交不能用打开时的快照整份写回，把别处新增的角色丢掉、或让别处移除的角色重新出现。
  // 生产入口 CreateWorkerPopover 提交；最小失败输入：打开 → 存储里新增 researcher、移除 tester → 提交。
  it('keeps roles another controller changed while the dialog was open when submitting', async () => {
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    writeWorkerCreationPrefs(
      applyWorkerRolesMutation(readWorkerCreationPrefs(), null, {
        kind: 'remember', role: 'researcher', task: 'Read the changelog',
      }),
    );
    writeWorkerCreationPrefs(
      applyWorkerRolesMutation(readWorkerCreationPrefs(), null, { kind: 'forget', role: 'tester' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    const roles = toRemoteWorkerRoles(readWorkerCreationPrefs(), null).roles;
    expect(roles.map((entry) => entry.role)).toEqual(['reviewer', 'researcher', 'developer']);
    expect(roles.find((entry) => entry.role === 'researcher')?.task).toBe('Read the changelog');
  });

  // 回归(PR #9731 review)：同一个窗口期里，别处写进这台电脑的「上次选择」(手动选定的完整路线、
  // 其他 Agent 的模型)也不能被打开时的快照覆盖。生产入口 CreateWorkerPopover 提交；最小失败输入：
  // 打开 → 存储里经 choice 写入 pi 的模型与路线 → 提交，路线和 pi 的模型仍在。
  it('keeps the last choice another controller wrote while the dialog was open when submitting', async () => {
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    const agentModel = { model: 'pi-fast-1', effort: 'low', fast: false, providerId: 'pi-provider' };
    const route = { agent: 'pi' as const, agentDeviceId: null, model: 'pi-fast-1', effort: 'low', fast: false, providerId: 'pi-provider' };
    writeWorkerCreationPrefs(
      applyWorkerRolesMutation(readWorkerCreationPrefs(), null, {
        kind: 'remember', role: 'researcher', choice: { agent: 'pi', agentModel, route },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    const defaults = toRemoteWorkerRoles(readWorkerCreationPrefs(), null).defaults;
    expect(defaults?.model).toEqual(route);
    expect(defaults?.agents.pi).toEqual(agentModel);
  });

  it('requires a role name for a custom Worker and submits it trimmed', async () => {
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    const submit = screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.addRole' }));
    const role = screen.getByRole('textbox', { name: 'orca.createWorker.roleLabel' });
    expect(document.activeElement).toBe(role);
    expect(submit.disabled).toBe(true);
    fireEvent.change(role, { target: { value: ' researcher ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ role: 'researcher' });
  });

  // 测试价值:用户要求所有预设都能移除、这一排按最近使用排序(2026-11-10)。生产入口
  // CreateWorkerPopover 的移除、提交与再次打开;此前内置预设固定且顺序不变。最小失败输入:
  // 移除内置预设后重新打开 → 用「自定义」输入它的名字找回 → 全部移除。unit/jsdom。
  it('removes built-in presets too, restores one by name, and lists the most recent first', async () => {
    const user = userEvent.setup();
    const names = () => screen.queryAllByRole('radio').map((item) => item.textContent);
    const builtin = (id: string) => `orca.createWorker.templates.${id}.name`;
    const remove = (name: string) =>
      user.click(
        within(screen.getByRole('radio', { name }).parentElement!).getByRole('button', {
          name: 'orca.createWorker.removePreset',
        }),
      );
    const submit = () => user.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    const onCreate = vi.fn();
    const first = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    expect(names()).toEqual([builtin('reviewer'), builtin('developer'), builtin('tester')]);
    // 移除要先确认：取消则什么都不变。
    mocks.confirm.mockResolvedValueOnce(false);
    await remove(builtin('reviewer'));
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(names()).toEqual([builtin('reviewer'), builtin('developer'), builtin('tester')]);
    // 确认移除正在选中的第一个：换到剩下的第一个。
    await remove(builtin('reviewer'));
    expect(names()).toEqual([builtin('developer'), builtin('tester')]);
    expect(screen.getByRole('radio', { name: builtin('developer') }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: builtin('tester') }));
    await submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    first.unmount();

    // 最近用的排在最前并被选中；移除过的内置预设不回来。
    const second = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    expect(names()).toEqual([builtin('tester'), builtin('developer')]);
    expect(screen.getByRole('radio', { name: builtin('tester') }).getAttribute('aria-checked')).toBe('true');
    // 用加号添加时输入内置角色的名字(不分大小写)：按那个内置角色创建，它也就回来了。
    await user.click(screen.getByRole('button', { name: 'orca.createWorker.addRole' }));
    await user.type(screen.getByRole('textbox', { name: 'orca.createWorker.roleLabel' }), 'Reviewer');
    await submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[1]![0]).toMatchObject({ role: 'reviewer' });
    second.unmount();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    expect(names()).toEqual([builtin('reviewer'), builtin('tester'), builtin('developer')]);
    // 全部移除后这一排只剩角色名输入，等用户起名。
    await remove(builtin('reviewer'));
    await remove(builtin('tester'));
    await remove(builtin('developer'));
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'orca.createWorker.roleLabel' }));
    expect(
      (screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('does not claim Auto-review for a device-link worker controlled by an older peer', () => {
    render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={vi.fn()} />);

    expect(screen.queryByTestId('worker-permission-mode')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('defaults new Worker creation to Full access', async () => {
    const onCreate = vi.fn();
    render(
      <CreateWorkerPopover
        open
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    const selector = screen.getByTestId('permission-selector');
    expect(selector.getAttribute('data-mode')).toBe('bypassPermissions');
    expect(selector.getAttribute('data-allowed')).toBe('auto,bypassPermissions');

    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ workerPermissionMode: 'bypassPermissions' }),
      ),
    );
    expect(JSON.parse(localStorage.getItem('workerCreationPrefs') ?? '{}')).toMatchObject({
      workerPermissionMode: 'bypassPermissions',
    });
  });

  it('keeps a manually saved Auto-review preference after the product default changes', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({ workerPermissionMode: 'auto' }),
    );
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);

    const selector = screen.getByTestId('permission-selector');
    await waitFor(() => expect(selector.getAttribute('data-mode')).toBe('auto'));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ workerPermissionMode: 'auto' }),
      ),
    );
    expect(JSON.parse(localStorage.getItem('workerCreationPrefs') ?? '{}')).toMatchObject({
      workerPermissionMode: 'auto',
    });
  });

  it('blocks Worker creation when a device-link peer cannot honor permission selection', () => {
    render(
      <CreateWorkerPopover
        open
        deviceId="old-device"
        requireWorkerPermissionModeSupport
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('permission-selector')).toBeNull();
    expect(screen.getByText('newChat.collaboration.unsupportedRemoteHint')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('applies Full access directly without a confirmation', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({ workerPermissionMode: 'auto' }),
    );
    const onCreate = vi.fn();
    render(
      <CreateWorkerPopover
        open
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    const selector = screen.getByTestId('permission-selector');
    fireEvent.click(selector);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(selector.getAttribute('data-mode')).toBe('bypassPermissions');

    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ workerPermissionMode: 'bypassPermissions' }),
      ),
    );
  });

  it('disables immediately and collapses repeated click events into one request', async () => {
    let finishCreate!: () => void;
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    );
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    const submit = screen.getByRole('button', { name: 'orca.createWorker.submit' });

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(submit.getAttribute('aria-busy')).toBe('true');

    finishCreate();
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    expect(submit.getAttribute('aria-busy')).toBe('false');
  });

  it('replaces a provider-gated local preference with the first available model and valid effort', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'codex/removed', effort: 'high', fast: true },
      }),
    );
    mocks.modelsByAgent.codex = [model('gpt-5.5', ['medium'], 'medium')];
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'codex/removed' }, { id: 'gpt-5.5' }],
    };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);

    await waitFor(() => expect(screen.getByTestId('model-selector').textContent).toBe('gpt-5.5'));
    const submit = screen.getByRole('button', { name: 'orca.createWorker.submit' });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'codex', model: 'gpt-5.5', effort: 'medium' }),
      ),
    );
  });

  it('restores an available stored preference before converging a stale default model', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-remembered', effort: 'medium', fast: false },
      }),
    );
    mocks.modelsByAgent.codex = [
      model('gpt-fallback', ['high'], 'high'),
      model('gpt-remembered', ['medium'], 'medium'),
    ];
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'gpt-fallback' }, { id: 'gpt-remembered' }],
    };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);

    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toBe('gpt-remembered'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-remembered', effort: 'medium' }),
      ),
    );
  });

  it('waits for the provider catalog before replacing a stale local preference', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'codex/removed', effort: 'high', fast: false },
      }),
    );
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    mocks.providersLoading = true;
    const view = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toBe('codex/removed'),
    );
    expect(
      (screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    mocks.providersLoading = false;
    view.rerender(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('model-selector').textContent).toBe('gpt-5.5'));
  });

  it('replaces a remote preference whose provider disconnected even if capabilities still list it', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'codex/disconnected', effort: 'high', fast: false },
      }),
    );
    mocks.modelsByAgent.codex = [model('gpt-connected', ['medium'], 'medium')];
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'codex/disconnected' }, { id: 'gpt-connected' }],
    };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);

    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toBe('gpt-connected'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-connected', effort: 'medium' }),
      ),
    );
  });

  it('waits for fresh remote capabilities when the provider snapshot arrives first', async () => {
    // 那台电脑版本太旧：模型记忆沿用这台电脑自己的。
    installRemoteHost('oldHost');
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-remembered', effort: 'high', fast: false },
      }),
    );
    mocks.modelsByAgent.codex = [model('gpt-fallback')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-remembered' }] };
    mocks.capabilitiesLoading = true;
    const view = render(
      <CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={vi.fn()} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toBe('gpt-remembered'),
    );
    expect(
      (screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    mocks.capabilitiesLoading = false;
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-fallback' }] };
    view.rerender(
      <CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toBe('gpt-fallback'),
    );
  });

  it('does not announce an empty-model warning before stored preferences are restored', () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'claude-code',
        'claude-code': { model: 'claude-opus-4-7', effort: 'high', fast: false },
      }),
    );
    mocks.modelsByAgent.codex = [];
    mocks.capabilitiesByAgent.codex = { availableModels: [] };

    const initialMarkup = renderToString(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />,
    );

    expect(initialMarkup).not.toContain('orca.createWorker.noAvailableModels');
  });

  it('converges each agent preference independently after switching agents', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'codex/gpt-5.5', effort: 'high', fast: false },
        'claude-code': { model: 'claude-removed', effort: 'high', fast: false },
      }),
    );
    mocks.modelsByAgent['claude-code'] = [model('claude-sonnet-4-6')];
    mocks.capabilitiesByAgent['claude-code'] = {
      availableModels: [{ id: 'claude-sonnet-4-6' }],
    };

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toBe('codex/gpt-5.5'),
    );
    fireEvent.click(screen.getByTestId('pick-claude-model'));

    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toBe('claude-sonnet-4-6'),
    );
    expect(
      (screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('explains why creation stays disabled when no local model is available', async () => {
    mocks.modelsByAgent.codex = [];
    mocks.capabilitiesByAgent.codex = { availableModels: [] };

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);

    expect((await screen.findByRole('status')).textContent).toContain(
      'orca.createWorker.noAvailableModels',
    );
    expect(
      (screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  // #10313, unit: the real form must explain a restored, unusable selection and recover
  // after an explicit pick. Existing isolation tests only asserted the disabled submit.
  // Minimal input: saved route + unavailable model/source, with another usable row.
  it.each(['removed', 'disabled', 'disconnected', 'default-source', 'empty'] as const)(
    'explains an unavailable saved selection (%s) and submits only after a manual pick',
    async (reason) => {
      const savedModel = reason === 'default-source' ? 'removed-model' : 'gpt-5.5';
      const savedProvider = reason === 'default-source' ? null : 'saved-provider';
      writeWorkerCreationPrefs({
        ...DEFAULT_WORKER_CREATION_PREFS,
        modelSelectionByHost: {
          [JSON.stringify([null, 'local'])]: {
            agent: 'codex', agentDeviceId: null, model: savedModel,
            providerId: savedProvider, effort: 'high', fast: false,
          },
        },
      });
      mocks.modelsByAgent.codex = reason === 'empty' ? [] : [model('gpt-5.5')];
      mocks.localProviders = [
        { id: 'saved-provider', name: 'Saved', connected: reason !== 'disconnected', agents: ['codex'],
          models: { codex: reason === 'removed' || reason === 'empty' ? [] : [{ ...model('gpt-5.5'), disabled: reason === 'disabled' }] } },
        { id: 'openai', name: 'OpenAI', connected: true, agents: ['codex'],
          models: { codex: mocks.modelsByAgent.codex } },
      ];
      const onCreate = vi.fn();
      const props = { open: true, onClose: vi.fn(), onCreate };
      mocks.providersLoading = true;
      const view = render(<CreateWorkerPopover {...props} />);
      expect(screen.queryByText('orca.createWorker.savedModelUnavailable')).toBeNull();
      mocks.providersLoading = false;
      view.rerender(<CreateWorkerPopover {...props} />);

      const warning = screen.getByRole('status');
      expect(warning.textContent).toContain(reason === 'empty'
        ? 'orca.createWorker.noAvailableModels' : 'orca.createWorker.savedModelUnavailable');
      expect(screen.getByTestId('model-selector').textContent).toBe(savedModel);
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe(savedProvider ?? '');
      const submit = screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      fireEvent.click(submit);
      expect(onCreate).not.toHaveBeenCalled();
      if (reason === 'empty') return;

      fireEvent.click(screen.getByTestId('pick-openai-row-bare'));
      expect(screen.queryByRole('status')).toBeNull();
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gpt-5.5', providerId: 'openai',
      })));
      // This local host has no location capability, so its request must omit that field.
      expect(onCreate.mock.calls[0][0]).not.toHaveProperty('agentDeviceId');
    },
  );

  it('mounts the standard panel with provider sections for local creation', async () => {
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.sourcesEnabled).toBe('true');
    // Fast 收进面板行级配置列(本地 + codex),模型级记忆与 composer 共用;
    // 点「解析出的生效默认来源」行必须能钉成显式偏好。
    expect(selector.dataset.fastWired).toBe('true');
    expect(selector.dataset.memoryWired).toBe('true');
    expect(selector.dataset.reselectEmits).toBe('true');
    expect(selector.dataset.navigateWired).toBe('true');
  });

  it('uses remote provider routes without local memory for device-link creation', async () => {
    render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={vi.fn()} />);
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.sourcesEnabled).toBe('true');
    expect(selector.dataset.memoryWired).toBe('false');
  });

  it('persists the remote provider, effort and Fast without modifying local model memory', async () => {
    mocks.remoteProviders = [{ id: 'openai', name: 'OpenAI', connected: true, agents: ['codex'],
      models: { codex: [model('gpt-5.5', ['medium', 'high'], 'high')] } }];
    mocks.modelsByAgent.codex = [model('gpt-5.5', ['medium', 'high'], 'high')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }], hasFastMode: true } as never;
    const before = getProviderModelChoice('codex', 'openai');
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(await screen.findByTestId('pick-openai-row'));
    await waitFor(() => expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.5', providerId: 'openai', effort: 'medium', fast: true,
    })));
    expect(getProviderModelChoice('codex', 'openai')).toEqual(before);
  });

  it('retains the capabilities-only fallback for old remote hosts', async () => {
    mocks.remoteUnsupported = true;
    render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={vi.fn()} />);
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.sourcesEnabled).toBe('false');
    expect(selector.dataset.memoryWired).toBe('false');
  });

  it('submits the provider picked from a source section row', async () => {
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('gpt-5.5', ['medium'], 'medium')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(await screen.findByTestId('pick-openai-row'));
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'openai', effort: 'medium' }),
      ),
    );
  });

  it('narrows a restored provider that no longer offers the model to null', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'ghost-provider' },
      }),
    );
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe(''),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ providerId: null })),
    );
  });

  it('clears a restored chat-bridged Codex provider for SSH worker creation', async () => {
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'chat-bridge' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'chat-bridge',
        name: 'Chat Bridge',
        connected: true,
        agents: ['codex'],
        routing: { codex: { wireProtocol: 'openai-chat' } },
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open sshRemote onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe(''),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ providerId: null })),
    );
  });

  it('restores remembered effort and Fast for the picked row when the panel omits them', async () => {
    // 真组件选行只回传 (providerId, modelId);目标模型 hover 配置过的 effort/Fast
    // 存在模型级全局预设里,选中后必须恢复,不能沿用上一个模型的值。
    setProviderModelChoice('codex', 'openai', 'gpt-5.5', 'low');
    setProviderModelFast('codex', 'openai', 'gpt-5.5', true);
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5', supportsFastMode: true }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      model('codex/gpt-5.5'),
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: true },
    ];
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'codex/gpt-5.5' }, { id: 'gpt-5.5' }],
      hasFastMode: true,
    } as never;
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(await screen.findByTestId('pick-openai-row-bare'));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.5',
          providerId: 'openai',
          effort: 'low',
          fast: true,
        }),
      ),
    );
  });

  it('drops Fast when the picked provider does not support it for the model', async () => {
    // per-provider Fast 能力:同一 model id 在选中来源的条目上不支持 Fast 时,
    // 不能沿用拍平并集的首来源能力继续提交 fast=true。
    setProviderModelFast('codex', 'openai', 'gpt-5.5', true);
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['medium'], defaultEffort: 'medium', supportsFastMode: true },
    ];
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'gpt-5.5' }],
      hasFastMode: true,
    } as never;
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(await screen.findByTestId('pick-openai-row-bare'));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'openai', fast: undefined }),
      ),
    );
  });

  it('narrows a remembered provider whose model entry is disabled', async () => {
    // 停用轴才收窄显式来源:被停用的 (来源, 模型) 不能显式路由过去。
    // (2026-07 启用/显示双轴拆分:disabled 是 buildRegistry 烘焙的视图层标志。)
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5', disabled: true }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe(''),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ providerId: null })),
    );
  });

  it('keeps a remembered provider whose model entry is merely hidden by visibility prefs', async () => {
    // 「隐藏」只是陈列过滤,不再收窄显式来源:记忆来源被隐藏仍然合法可路由
    // (2026-07 启用/显示双轴拆分,用户裁决「隐藏可点名、可兜底」)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.hiddenModels = ['openai:gpt-5.5'];
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'openai' })),
    );
  });

  it('narrows a remembered provider whose model entry is non-chat (issue #882 第 3 点, 2026-07 review)', async () => {
    // 记忆来源上这个 model id 的具体条目是非聊天(mode='image_generation')——
    // providerOffersModel 只看 id 是否存在,不会挡住它;narrowProviderSource 必须
    // 自己叠加 isChatEligible,否则会把这个来源提交给 main,请求发到 image 端点。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5', mode: 'image_generation' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe(''),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ providerId: null })),
    );
  });

  it('resolves Fast against the effective default provider when no explicit source is set', async () => {
    // 未显式来源时 Fast 能力按生效默认来源自己的条目查,不用拍平并集的首来源值
    // (codex review:默认来源不支持时不能把 stale true 带到提交)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: true, providerId: null },
      }),
    );
    mocks.localProviders = [
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        // 该来源的条目不带 supportsFastMode → 默认来源不支持 Fast。
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('gpt-5.5')]; // 并集条目 supportsFastMode: true
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'gpt-5.5' }],
      hasFastMode: true,
    } as never;
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'orca.createWorker.submit' }),
    );
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ fast: undefined })),
    );
  });

  it('persists active-row effort edits into the shared model memory', async () => {
    // 活跃行编辑走 onEffortChange 而非 modelMemory,必须写回全局预设 ——
    // 否则切走再切回按旧值恢复,编辑被静默丢弃(codex review)。
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'codex/gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('codex/gpt-5.5', ['low', 'high'], 'high')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'codex/gpt-5.5' }] };

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('edit-active-effort'));
    await waitFor(() =>
      expect(getProviderModelEffort('codex', 'openai', 'codex/gpt-5.5')).toBe('low'),
    );
  });

  it('restores the target row preset when switching sources that share the same model', async () => {
    // 同一模型在 openai(当前生效)与 xd 都有:点 xd 行是真实来源切换,必须恢复
    // xd 行显示的预设,不能因「模型相同」被当成钉当前来源而保留 live 值(codex review)。
    setProviderModelChoice('codex', 'xd', 'gpt-5.5', 'low');
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByTestId('pick-xd-row-bare'));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'xd', effort: 'low' }),
      ),
    );
  });

  it('keeps remembered Fast when a stale source narrows to a Fast-capable default', async () => {
    // 记忆来源已失效(不在目录)但模型仍有支持 Fast 的默认来源:Fast 判定必须按
    // 收窄后的来源口径,不得在收敛 effect 前的渲染窗口里用旧失效来源清掉 fast=true
    // (codex review)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: true, providerId: 'ghost-provider' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5', supportsFastMode: true }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'gpt-5.5' }],
      hasFastMode: true,
    } as never;
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe(''),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: null, fast: true }),
      ),
    );
  });

  it('saves the complete selected configuration after switching Harness twice', async () => {
    // 切 tab 的恢复读的是 prefs:切走前必须把当前 agent 的 live 编辑快照进内存
    // prefs,否则「选好来源/改好 effort 还没提交就切了个 tab」会被静默回滚到打开
    // 弹窗时的旧值(codex review)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    mocks.modelsByAgent['claude-code'] = [model('claude-sonnet-4-6')];
    mocks.capabilitiesByAgent['claude-code'] = { availableModels: [{ id: 'claude-sonnet-4-6' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByTestId('pick-xd-row-bare'));
    fireEvent.click(screen.getByTestId('edit-active-effort'));
    fireEvent.click(screen.getByTestId('pick-claude-model'));
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toContain('claude-sonnet-4-6'),
    );
    fireEvent.click(screen.getByTestId('pick-codex-config'));
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('xd'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'xd', effort: 'low' }),
      ),
    );
  });

  it('falls back to the target row default effort when switching sources without a preset', async () => {
    // 模型预设槽为空、live effort 来自更早的 workerCreationPrefs(预设 store 之前的
    // 老数据):此时面板非活跃行显示的是 defaultEffort,切过去必须用它,不能因旧
    // live 值恰好也被支持而保留 —— 行上显示 high、创建却用 low 是显示与派发不一致
    // (codex review);与 Fast 的「无预设 = 对齐显示」同规则。(若用户编辑过 effort,
    // 预设写在 `${agent}:*` 全局槽跨来源共享,remembered 分支已保证与行显示一致。)
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'low', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByTestId('pick-xd-row-bare'));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'xd', effort: 'high' }),
      ),
    );
  });

  it('keys memory compatibility copies to the effective source while an explicit source is stale', async () => {
    // 目录仍在加载(收敛 effect 未跑)、恢复出的显式来源已失效:活跃行编辑的记忆
    // 写入按收窄后口径落 key —— 全局预设槽不受影响,但来源槽兼容副本不得写给
    // 已失效来源(copilot review;ChatInput 的 effectiveSourceId 同语义)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'ghost-provider' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    mocks.providersLoading = true;

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('ghost-provider'),
    );
    fireEvent.click(screen.getByTestId('edit-active-effort'));

    expect(getProviderModelEffort('codex', 'openai', 'gpt-5.5')).toBe('low');
    const raw = JSON.parse(window.localStorage.getItem('xdt:providerModelMemory:v2') ?? '{}');
    expect(Object.keys(raw)).toContain('codex:openai');
    expect(Object.keys(raw)).not.toContain('codex:ghost-provider');
  });

  it('resolves effort from the selected provider catalog row, not the flattened union', async () => {
    // gpt-5.5 的拍平条目(首来源 openai wins)默认 high,而 xd 自己的目录条目只有
    // low 档:选 xd 行(无共享预设)必须落 xd 条目的 defaultEffort,不能按拍平条目
    // 保留/赋予 xd 不支持的档位 —— 提交后会被 main 侧路由来源校验拒掉(codex review)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: {
          codex: [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }],
          'claude-code': [],
        },
      },
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: {
          codex: [{ id: 'gpt-5.5', efforts: ['low'], defaultEffort: 'low' }],
          'claude-code': [],
        },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByTestId('pick-xd-row-bare'));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'xd', effort: 'low' }),
      ),
    );
  });

  it('persists the picked (source, model) into the provider choice slot', async () => {
    // 选行是一次真实选定:必须写该来源槽的 lastModel(composer/其它标准选择器的
    // resolveSourceSwitch 用它做切来源落点),否则本面板的显式选择不进全局记忆,
    // 别处切到该来源仍恢复旧模型(codex review)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByTestId('pick-xd-row-bare'));

    expect(getProviderModelChoice('codex', 'xd')).toEqual({ model: 'gpt-5.5', effort: 'high' });
  });

  it('reconciles a restored stale effort against the saved provider entry on submit', async () => {
    // 恢复路径:prefs 存的 effort=high 来自旧目录,而显式来源 xd 的条目只有 low 档;
    // 收敛 effect 按拍平条目(三档)不会清 high,直接 explicit 下发会被 main 侧路由
    // 来源校验拒掉阻断创建(codex review)。提交前按来源条目对账,落其 defaultEffort。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'xd' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: {
          codex: [{ id: 'gpt-5.5', efforts: ['low'], defaultEffort: 'low' }],
          'claude-code': [],
        },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('xd'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'xd', effort: 'low' }),
      ),
    );
  });

  it('omits effort when the route provider entry has no effort switching', async () => {
    // 来源条目无档(efforts:[])而拍平条目有档:带 effort 下发会被 main 按该来源
    // 档位表 explicit 拒绝 —— 该来源本可创建(effort 省略),不能让 UI 主动触发
    // INVALID_PARAMS 阻断(copilot review)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'xd' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: {
          codex: [{ id: 'gpt-5.5', efforts: [], defaultEffort: null }],
          'claude-code': [],
        },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('xd'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', providerId: 'xd', effort: undefined }),
      ),
    );
  });

  it('records the model choice when re-pinning the current effective source row', async () => {
    // 钉/重选当前生效来源的早退分支保留 live 值,但 (来源, 模型) 仍是一次真实选定:
    // 该来源槽 lastModel 指着别的模型时必须更新,否则其它标准选择器切到该来源会
    // 恢复 stale 模型(codex review)。
    setProviderModelChoice('codex', 'openai', 'gpt-other', 'low');
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false, providerId: 'openai' },
      }),
    );
    mocks.localProviders = [
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5' }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByTestId('pick-openai-row-bare'));

    expect(getProviderModelChoice('codex', 'openai')).toEqual({ model: 'gpt-5.5', effort: 'high' });
  });

  it('resolves remote Fast against the effective device provider, not the flattened union', async () => {
    // 被控端快照可用时,Fast 按其生效默认来源自己的条目判定(与被控端 main 的
    // fastModels re-gate 同口径);拍平条目说支持而默认来源 xd 不支持 → 不提供
    // Fast,提交 fast=undefined(codex review)。快照缺失(旧 peer)仍回落拍平。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: true },
      }),
    );
    mocks.remoteProviders = [
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: { codex: [{ id: 'gpt-5.5', supportsFastMode: false }], 'claude-code': [] },
      },
    ];
    mocks.modelsByAgent.codex = [model('gpt-5.5')];
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'gpt-5.5' }],
      hasFastMode: true,
    } as never;
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toContain('gpt-5.5'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', fast: undefined }),
      ),
    );
  });

  it('keeps the modal scrim out of the Electron window drag region', () => {
    // 遮罩标 drag = 整块视口都是拖拽命中区,只给 500px 的 Content 挖洞:模型选择器面板
    // 按 align=end 贴 trigger、向左探出弹窗边框,探出部分被拖拽区吞掉(2026-10 实测:
    // 左半点不动、左侧来源 rail 选不了)。同口径见 windowDrag.tsx。
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    const overlay = document.querySelector('.modal-scrim') as HTMLElement | null;
    const panel = document.querySelector('.modal-panel') as HTMLElement | null;
    const appRegion = (element: HTMLElement) =>
      (element.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion;
    expect(overlay).not.toBeNull();
    expect(appRegion(overlay!)).toBe('no-drag');
    expect(appRegion(panel!)).toBe('no-drag');
  });

  it('does not wire provider navigation inside the detached sidebar window', async () => {
    // 分离侧栏窗口固定 /sidebar-window 壳路由:本地 navigate 会把辅助窗口整壳替换
    // 成主设置路由,与 OrcaWorkerPanel 的 settingsEnabled={!isSidebarWindow()} 同
    // 禁用口径(codex review)。
    mocks.sidebarWindow = true;
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.navigateWired).toBe('false');
    // 供应商分段本身不受影响,只禁跳转。
    expect(selector.dataset.sourcesEnabled).toBe('true');
  });

  it('reconciles remote effort against the effective device provider before showing it', async () => {
    // device-link 退化面板的显示收敛与提交共用路由来源档位表:被控端生效默认来源
    // xd 只有 low 档而拍平条目默认 high 时,面板显示的 effort 必须先收敛到 low,
    // 不能显示 high、提交时才被静默改写成 low(codex review)。
    window.localStorage.setItem(
      'workerCreationPrefs',
      JSON.stringify({
        lastAgent: 'codex',
        codex: { model: 'gpt-5.5', effort: 'high', fast: false },
      }),
    );
    mocks.remoteProviders = [
      {
        id: 'xd',
        name: 'XD Gateway',
        connected: true,
        agents: ['codex'],
        models: {
          codex: [{ id: 'gpt-5.5', efforts: ['low'], defaultEffort: 'low' }],
          'claude-code': [],
        },
      },
    ];
    mocks.modelsByAgent.codex = [
      { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false },
    ];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'gpt-5.5' }] };
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open deviceId="device-a" onClose={vi.fn()} onCreate={onCreate} />);
    // 显示先收敛:面板拿到的 effort 已是路由来源支持的档位。
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.effort).toBe('low'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5', effort: 'low' }),
      ),
    );
  });
});

describe('CreateWorkerPopover execution device', () => {
  const listExecutionDevices = vi.fn();
  const projectContext = vi.fn();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollIntoView',
  );

  beforeEach(() => {
    mocks.sidebarWindow = false;
    // Radix Select scrolls the focused option; jsdom does not implement scrolling.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    window.localStorage.clear();
    resetProviderModelMemoryForTest();
    mocks.modelsByAgent.codex = [model('codex/gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'codex/gpt-5.5' }] };
    mocks.localProviders = [];
    mocks.remoteProviders = [];
    mocks.remoteUnsupported = false;
    projectContext.mockReset().mockResolvedValue({
      recordedDirectory: '/local', dialogue: false, projects: [],
      inherited: {directory: '/local', baseRepo: '/local', branch: 'main', exists: true, dirty: false, isWorktree: false},
      selected: {directory: '/local', baseRepo: '/local', branch: 'main', exists: true, dirty: false, isWorktree: false},
    });
    listExecutionDevices.mockReset();
    listExecutionDevices.mockResolvedValue({
      devices: [
        { deviceId: 'mac-mini', name: 'Mac mini', platform: 'darwin', supported: true },
        { deviceId: 'old-pc', name: 'Old PC', platform: 'win32', supported: false },
      ],
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      localDb: { orcaWorkflows: { listExecutionDevices, projectContext } },
    };
  });

  afterEach(() => {
    mocks.sidebarWindow = false;
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  // Guard: a local-only project picker must not probe this host or add local fields to
  // controlled/SSH Leads. Existing remote model tests lacked leadSessionId and IPC spies.
  it.each([{deviceId: 'controlled-pc'}, {sshRemote: true}])(
    'submits a remote Lead without local project reads or fields: %j', async (props) => {
      const onCreate = vi.fn();
      render(<CreateWorkerPopover open leadSessionId="remote-lead" {...props} onClose={vi.fn()} onCreate={onCreate} />);
      fireEvent.click(screen.getByRole('button', {name: 'orca.createWorker.submit'}));
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
      expect(projectContext).not.toHaveBeenCalled();
      for (const field of ['workingDir', 'worktree', 'projectPath'])
        expect(onCreate.mock.calls[0]![0]).not.toHaveProperty(field);
    },
  );

  // Detached sidebar preload intentionally lacks native folder and branch tools.
  // Unit/jsdom: its creation form must retain the legacy submission and never read projects.
  it('keeps detached sidebar creation identical to the legacy form without project reads', async () => {
    const legacyCreate = vi.fn();
    // 两边都选没有预设任务的「开发」：已有任务里的检查类预设会预填首条任务，与项目字段无关。
    const pickDeveloper = () =>
      fireEvent.click(screen.getByRole('radio', {name: 'orca.createWorker.templates.developer.name'}));
    const baseline = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={legacyCreate} />);
    pickDeveloper();
    fireEvent.click(screen.getByRole('button', {name: 'orca.createWorker.submit'}));
    await waitFor(() => expect(legacyCreate).toHaveBeenCalledOnce());
    baseline.unmount();
    window.localStorage.clear();

    mocks.sidebarWindow = true;
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open leadSessionId="lead" onClose={vi.fn()} onCreate={onCreate} />);
    expect(screen.queryByText('orca.workerProject.label')).toBeNull();
    pickDeveloper();
    fireEvent.click(screen.getByRole('button', {name: 'orca.createWorker.submit'}));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(projectContext).not.toHaveBeenCalled();
    expect(onCreate.mock.calls[0]![0]).toEqual(legacyCreate.mock.calls[0]![0]);
    for (const field of ['workingDir', 'worktree', 'projectPath'])
      expect(onCreate.mock.calls[0]![0]).not.toHaveProperty(field);
  });

  // Unit/jsdom: a remote-model Lead can place files on another host and select
  // an independent model computer, without leaking the Lead's model location.
  it('keeps the selected work host when choosing a remote model for its Worker', async () => {
    listExecutionDevices.mockResolvedValue({ devices: [
      { deviceId: 'mac-mini', name: 'Mac mini', supported: true, supportsAgentDevice: true },
    ] });
    const invoke = vi.fn(async () => ({ locations: [{ agentDeviceId: 'agent-pc', name: 'Agent PC' }] }));
    Object.assign(window.electronAPI, { deviceLink: { invoke } });
    mocks.remoteProviders = [{ id: 'openai', name: 'OpenAI', connected: true,
      remoteInvocationEnabled: true, agents: ['codex'], models: { codex: [model('codex/gpt-5.5')] } }];
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open leadSessionId="lead" leadAgentDeviceId="lead-model-pc"
      remoteAgentDevices={[{deviceId: 'agent-pc', name: 'Agent PC'}]} executionDevicesEnabled onClose={vi.fn()} onCreate={onCreate} />);
    await openMoreSettings();
    const picker = await screen.findByRole('combobox', { name: 'orca.createWorker.executionDeviceLabel' });
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Mac mini/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mac-mini', 'maker:orca:remote-worker:models', [{}]));
    expect(mocks.deviceProvidersFor).toBe('mac-mini');
    await waitFor(() => expect(screen.getByTestId('model-selector').dataset.remoteHome).toBe('mac-mini'));
    fireEvent.click(screen.getByTestId('pick-remote-codex'));
    expect(mocks.deviceProvidersFor).toBe('agent-pc');
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ executionDeviceId: 'mac-mini',
      agentDeviceId: 'agent-pc', model: 'codex/gpt-5.5', providerId: 'openai' });
  });

  it('offers other computers only when enabled and the list is not empty', async () => {
    const { unmount } = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(listExecutionDevices).not.toHaveBeenCalled();
    expect(screen.queryByTestId('worker-execution-device')).toBeNull();
    unmount();

    listExecutionDevices.mockResolvedValueOnce({ devices: [] });
    render(
      <CreateWorkerPopover open executionDevicesEnabled onClose={vi.fn()} onCreate={vi.fn()} />,
    );
    await waitFor(() => expect(listExecutionDevices).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('worker-execution-device')).toBeNull();
  });

  it('creates on the chosen computer with its folder and leaves outdated computers unselectable', async () => {
    const onCreate = vi.fn();
    render(
      <CreateWorkerPopover open leadSessionId="local-lead" executionDevicesEnabled onClose={vi.fn()} onCreate={onCreate} />,
    );

    await openMoreSettings();
    const devicePicker = await screen.findByRole('combobox', {
      name: 'orca.createWorker.executionDeviceLabel',
    });
    expect(devicePicker.textContent).toContain('orca.createWorker.thisComputer');
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.keyDown(devicePicker, { key: 'ArrowDown' });
    const oldDevice = await screen.findByRole('option', { name: /Old PC/ });
    expect(oldDevice.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(oldDevice);
    expect(onCreate).not.toHaveBeenCalled();
    expect(devicePicker.textContent).toContain('orca.createWorker.thisComputer');

    fireEvent.click(screen.getByRole('option', { name: /Mac mini/ }));
    // Opening on this computer legitimately probes once; after switching, no further local reads.
    projectContext.mockClear();
    // 另一台电脑的模型目录：不接本机来源记忆，也不跳本机供应商设置。
    expect(screen.getByTestId('model-selector').dataset.memoryWired).toBe('false');
    expect(screen.getByTestId('model-selector').dataset.navigateWired).toBe('false');

    fireEvent.click(screen.getByRole('radio', { name: 'orca.createWorker.remoteDirPath' }));
    const dirPicker = screen.getByRole('button', { name: 'orca.createWorker.remoteDirLabel' });
    const submit = screen.getByRole('button', {
      name: 'orca.createWorker.submit',
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    mocks.directoryPath = 'Interviews';
    fireEvent.click(dirPicker);
    expect(screen.getByTestId('choose-worker-folder').dataset.device).toBe('mac-mini');
    fireEvent.click(screen.getByTestId('choose-worker-folder'));
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('orca.createWorker.remoteDirInvalid')).toBeTruthy();

    mocks.directoryPath = '/Users/demo/Interviews';
    fireEvent.click(dirPicker);
    fireEvent.click(screen.getByTestId('choose-worker-folder'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          executionDeviceId: 'mac-mini',
          executionDeviceName: 'Mac mini',
          workingDir: '/Users/demo/Interviews',
        }),
      ),
    );
    expect(projectContext).not.toHaveBeenCalled();
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('worktree');
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('projectPath');
  });

  it('creates a chat on the chosen computer without leaking a previously specified folder', async () => {
    const onCreate = vi.fn();
    render(
      <CreateWorkerPopover open leadSessionId="local-lead" executionDevicesEnabled onClose={vi.fn()} onCreate={onCreate} />,
    );
    await openMoreSettings();
    const picker = await screen.findByRole('combobox', {
      name: 'orca.createWorker.executionDeviceLabel',
    });
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Mac mini/ }));
    // Opening on this computer legitimately probes once; after switching, no further local reads.
    projectContext.mockClear();
    expect(
      screen
        .getByRole('radio', { name: 'orca.createWorker.remoteDirChat' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'orca.createWorker.remoteDirPath' }));
    mocks.directoryPath = '/Users/demo/Interviews';
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.remoteDirLabel' }));
    fireEvent.click(screen.getByTestId('choose-worker-folder'));
    fireEvent.click(screen.getByRole('radio', { name: 'orca.createWorker.remoteDirChat' }));
    expect(screen.queryByRole('textbox', { name: 'orca.createWorker.remoteDirLabel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ executionDeviceId: 'mac-mini' });
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('workingDir');
    expect(projectContext).not.toHaveBeenCalled();
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('worktree');
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('projectPath');

    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'orca.createWorker.thisComputer' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[1]![0]).not.toHaveProperty('executionDeviceId');
    expect(onCreate.mock.calls[1]![0]).not.toHaveProperty('workingDir');
  });

  it('clears the selected folder and resets to chat when switching remote computers', async () => {
    listExecutionDevices.mockResolvedValueOnce({ devices: [
      { deviceId: 'mac-mini', name: 'Mac mini', platform: 'darwin', supported: true },
      { deviceId: 'windows-pc', name: 'Windows PC', platform: 'win32', supported: true },
    ] });
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open executionDevicesEnabled onClose={vi.fn()} onCreate={onCreate} />);
    await openMoreSettings();
    const picker = await screen.findByRole('combobox', { name: 'orca.createWorker.executionDeviceLabel' });
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Mac mini/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'orca.createWorker.remoteDirPath' }));
    mocks.directoryPath = '/Users/demo/Interviews';
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.remoteDirLabel' }));
    fireEvent.click(screen.getByTestId('choose-worker-folder'));
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Windows PC/ }));
    expect(screen.getByRole('radio', { name: 'orca.createWorker.remoteDirChat' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ executionDeviceId: 'windows-pc' });
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('workingDir');
    fireEvent.click(screen.getByRole('radio', { name: 'orca.createWorker.remoteDirPath' }));
    expect((screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps a large device list in the dropdown and locates a device by keyboard typeahead', async () => {
    listExecutionDevices.mockResolvedValueOnce({
      devices: Array.from({ length: 100 }, (_, index) => ({
        deviceId: `device-${index}`,
        name: `Computer ${String(index).padStart(3, '0')}`,
        supported: true,
      })),
    });
    const onCreate = vi.fn();
    render(
      <CreateWorkerPopover open executionDevicesEnabled onClose={vi.fn()} onCreate={onCreate} />,
    );
    await openMoreSettings();
    const picker = await screen.findByRole('combobox', {
      name: 'orca.createWorker.executionDeviceLabel',
    });
    expect(screen.queryByText('Computer 099')).toBeNull();
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    await screen.findByRole('option', { name: /Computer 099/ });
    await userEvent.keyboard('Computer 099');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Computer 099'));
    await userEvent.keyboard('{Enter}');
    expect(picker.textContent).toContain('Computer 099');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          executionDeviceId: 'device-99',
        }),
      ),
    );
  });
});

// 远程供应商与本机供应商一视同仁(2026-10-10)：Worker 的 Agent 可以放到另一台电脑或分享上。
describe('CreateWorkerPopover remote providers', () => {
  const devices = [{ deviceId: 'agent-pc', name: 'Agent PC' }, { deviceId: 'share:s1', name: 'Shared' }];
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'orca.createWorker.submit' }));

  beforeEach(() => {
    window.localStorage.clear();
    resetProviderModelMemoryForTest();
    mocks.modelsByAgent.codex = [model('codex/gpt-5.5')];
    mocks.capabilitiesByAgent.codex = { availableModels: [{ id: 'codex/gpt-5.5' }] };
    mocks.capabilitiesByAgent['claude-code'] = { availableModels: [] };
    mocks.localProviders = [];
    mocks.remoteProviders = [];
    mocks.remoteUnsupported = false;
    mocks.deviceProvidersFor = undefined;
  });

  afterEach(() => cleanup());

  // #8010 / unit: create through the real Worker form, then return to the task host.
  // Existing cases lacked catalogHostDeviceId, so a cache key could accidentally
  // become agentDeviceId or move the Worker's work computer without being caught.
  it.each(['agent-pc', 'share:s1'])('keeps %s as the execution identity while reading its catalog through B', async source => {
    mocks.capabilitiesByAgent['claude-code'] = {
      availableModels: [], supportsOrcaWorkerAgentDevice: true,
    } as typeof mocks.capabilitiesByAgent['claude-code'];
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open deviceId="host-b" catalogHostDeviceId="host-b"
      leadAgentDeviceId={source} remoteAgentDevices={devices} onClose={vi.fn()} onCreate={onCreate} />);
    expect(mocks.deviceProvidersFor).toBe(modelCatalogKey(source, 'host-b'));
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0][0]).toMatchObject({ agentDeviceId: source, model: 'codex/gpt-5.5' });
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty('executionDeviceId');
    fireEvent.click(screen.getByTestId('pick-home-codex'));
    expect(mocks.deviceProvidersFor).toBe('host-b');
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[1][0]).toMatchObject({ agentDeviceId: null, model: 'codex/gpt-5.5' });
    expect(onCreate.mock.calls[1][0]).not.toHaveProperty('executionDeviceId');
  });

  // 模型面板底部「配置模型」：Worker 的 Agent 已选在分享上时也要能跳设置(由面板决定显示)；
  // 只有任务在远程控制的电脑上时不接线。
  it('keeps provider navigation wired while the Worker agent already uses a share', async () => {
    render(
      <CreateWorkerPopover
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        leadAgentDeviceId="share:abc"
        remoteAgentDevices={[{ deviceId: 'share:abc', name: '来自 Magi 的分享' }]}
      />,
    );
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.agentDevice).toBe('share:abc');
    expect(selector.dataset.navigateWired).toBe('true');
  });

  it("does not wire provider navigation for a Lead on a remote-controlled computer", async () => {
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} deviceId="lead-pc" />);
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.navigateWired).toBe('false');
  });

  it("reads the Lead's remote computer by default and submits that location", async () => {
    const onCreate = vi.fn();
    render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} leadAgentDeviceId="agent-pc" remoteAgentDevices={devices} />,
    );
    // 模型目录按 Lead 的 Agent 所在电脑读，面板列出远程供应商并选中那台，按钮带远程标识。
    expect(mocks.deviceProvidersFor).toBe('agent-pc');
    const selector = screen.getByTestId('model-selector');
    expect(selector.dataset.remoteSelected).toBe('agent-pc');
    expect(selector.dataset.agentDevice).toBe('agent-pc');
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ agentDeviceId: 'agent-pc' })));
  });

  it('moves the Worker between this computer and another one from the panel', async () => {
    const onCreate = vi.fn();
    render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} remoteAgentDevices={devices} />,
    );
    expect(mocks.deviceProvidersFor).toBeUndefined();
    expect(screen.getByTestId('model-selector').dataset.remoteSelected).toBe('null');

    fireEvent.click(screen.getByTestId('pick-remote-codex'));
    expect(mocks.deviceProvidersFor).toBe('agent-pc');
    // 那台电脑的档位记在那台的那份记忆里，不写本机的 Worker 偏好。
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      agentDeviceId: 'agent-pc', model: 'codex/gpt-5.5',
    })));
    expect(window.localStorage.getItem('workerCreationPrefs') ?? '').not.toContain('openai');

    fireEvent.click(screen.getByTestId('pick-home-codex'));
    expect(mocks.deviceProvidersFor).toBeUndefined();
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ agentDeviceId: null })));
  });

  // 回归 7af90460e2：真实弹窗提交后重新挂载，模型与来源应仍是 Worker 的选择。
  // 原有用例只在一次打开内换位置，漏掉再次打开被 Lead 覆盖；unit，最小输入是选行、提交、换 Lead 后重开。
  it.each([
    { pick: 'pick-remote-codex', location: 'agent-pc', provider: 'openai', nextLead: null, host: undefined },
    { pick: 'pick-shared-codex', location: 'share:s1', provider: 'openai', nextLead: null, host: 'controlled-pc' },
    { pick: 'pick-home-codex', location: null, provider: 'xd', nextLead: 'agent-pc', host: undefined },
  ])('remembers the submitted Worker selection independently of the Lead: $pick', async ({ pick, location, provider, nextLead, host }) => {
    mocks.capabilitiesByAgent['claude-code'] = { availableModels: [], supportsOrcaWorkerAgentDevice: true } as never;
    window.localStorage.setItem('workerCreationPrefs', JSON.stringify({
      lastAgent: 'codex', codex: { model: 'gpt-main', effort: 'high', fast: false },
    }));
    mocks.modelsByAgent.codex = [model('gpt-main'), model('codex/gpt-5.5')];
    mocks.localProviders = [{
      id: 'xd', name: 'XD', connected: true, agents: ['codex'],
      models: { codex: mocks.modelsByAgent.codex },
    }];
    mocks.remoteProviders = [{
      id: 'openai', name: 'OpenAI', connected: true, remoteInvocationEnabled: true,
      agents: ['codex'], models: { codex: [model('codex/gpt-5.5')] },
    }];
    // 远程控制的任务：这条路线记在任务所在的那台电脑上，再次打开时从它读回。
    const remote = host ? installRemoteHost('memoryHost') : null;
    const onCreate = vi.fn();
    const view = render(
      <CreateWorkerPopover open deviceId={host} onClose={vi.fn()} onCreate={onCreate} remoteAgentDevices={devices} />,
    );
    fireEvent.click(screen.getByTestId(pick));
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    if (remote) {
      await waitFor(() => expect(remote.invoke).toHaveBeenCalledWith(host, 'maker:worker-roles:apply', expect.anything()));
    }
    view.unmount();
    setProviderModelChoice('codex', 'xd', 'gpt-main', 'high');

    render(
      <CreateWorkerPopover open deviceId={host} onClose={vi.fn()} onCreate={onCreate} leadAgentDeviceId={nextLead} remoteAgentDevices={devices} />,
    );
    await waitFor(() => expect(screen.getByTestId('model-selector').dataset.remoteSelected).toBe(String(location)));
    expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe(provider);
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      agentDeviceId: location, providerId: provider, model: 'codex/gpt-5.5',
    })));
  });

  // 记忆恢复后目录/能力可能改变：不可静默换来源、换模型或换账号复用。
  it.each(['provider', 'model', 'old-host', 'account'])('keeps a restored route isolated when %s changes', async (change) => {
    mocks.remoteProviders = [{ id: 'openai', name: 'OpenAI', connected: true,
      remoteInvocationEnabled: true, agents: ['codex'], models: { codex: [model('codex/gpt-5.5')] } }];
    const onCreate = vi.fn();
    const view = render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} remoteAgentDevices={devices} />);
    fireEvent.click(screen.getByTestId('pick-remote-codex'));
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    view.unmount();
    if (change === 'provider') {
      mocks.remoteProviders[0]!.connected = false;
      mocks.remoteProviders.push({ id: 'fallback', name: 'Fallback', connected: true, remoteInvocationEnabled: true,
        agents: ['codex'], models: { codex: [{ ...model('codex/gpt-5.5'), efforts: ['low'], defaultEffort: 'low' }] } });
    }
    if (change === 'model') mocks.remoteProviders[0]!.models.codex = [model('other-model')];
    if (change === 'account') setDataOwnerGeneration('another-owner');
    try {
      render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate}
        remoteAgentDevices={change === 'old-host' ? undefined : devices} />);
      if (change === 'account') {
        expect(screen.getByTestId('model-selector').dataset.agentDevice).toBe('');
        expect(screen.queryByText('orca.createWorker.savedModelUnavailable')).toBeNull();
      } else {
        // #10313: blocked remote/older-host routes need an explanation too; never pick a fallback.
        expect((await screen.findByRole('status')).textContent).toContain('orca.createWorker.savedModelUnavailable');
        expect(screen.getByTestId('model-selector').dataset.agentDevice).toBe('agent-pc');
        expect(screen.getByTestId('model-selector').dataset.effort).toBe('high');
        expect((screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement).disabled).toBe(true);
        submit();
        expect(onCreate).toHaveBeenCalledTimes(1);
      }
    } finally { setDataOwnerGeneration(null); }
  });

  it('keeps following the Lead after default submission or an unsubmitted model change', async () => {
    const onCreate = vi.fn();
    const view = render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} leadAgentDeviceId="agent-pc" remoteAgentDevices={devices} />,
    );
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('pick-home-codex'));
    view.unmount();
    render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} leadAgentDeviceId="other-pc" remoteAgentDevices={devices} />,
    );
    expect(screen.getByTestId('model-selector').dataset.agentDevice).toBe('other-pc');
  });

  it('does not reuse a submitted local Worker selection on another task host or SSH', async () => {
    const onCreate = vi.fn();
    const view = render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} remoteAgentDevices={devices} />,
    );
    fireEvent.click(screen.getByTestId('pick-remote-codex'));
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    view.unmount();

    const remote = render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} deviceId="other-host" remoteAgentDevices={devices} />,
    );
    expect(screen.getByTestId('model-selector').dataset.agentDevice).toBe('');
    expect(mocks.deviceProvidersFor).toBe('other-host');
    remote.unmount();
    render(<CreateWorkerPopover open sshRemote onClose={vi.fn()} onCreate={onCreate} />);
    expect(screen.getByTestId('model-selector').dataset.agentDevice).toBe('');
  });

  it("keeps following the Lead's location until the user picks one, without wiping the form", async () => {
    const onCreate = vi.fn();
    const view = render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} leadAgentDeviceId={null} remoteAgentDevices={devices} />,
    );
    fireEvent.change(screen.getByPlaceholderText('orca.createWorker.initialTaskPlaceholder'), {
      target: { value: 'review the diff' },
    });
    // Lead 的位置稍后才解析出来：Worker 的位置跟过去，已填的初始任务不清掉。
    view.rerender(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} leadAgentDeviceId="agent-pc" remoteAgentDevices={devices} />,
    );
    expect(screen.getByTestId('model-selector').dataset.remoteSelected).toBe('agent-pc');
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      agentDeviceId: 'agent-pc', initialTask: 'review the diff',
    })));
    // 用户自己选过之后不再跟着变。
    fireEvent.click(screen.getByTestId('pick-home-codex'));
    view.rerender(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} leadAgentDeviceId="other-pc" remoteAgentDevices={devices} />,
    );
    expect(screen.getByTestId('model-selector').dataset.remoteSelected).toBe('null');
  });

  it('blocks creation instead of dropping a chosen location the computer can no longer accept', () => {
    const view = render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} remoteAgentDevices={devices} />,
    );
    fireEvent.click(screen.getByTestId('pick-remote-codex'));
    // 候选消失(例如任务所在电脑降级)：选中的位置发不出去，不能悄悄按 Lead 的位置建。
    view.rerender(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'orca.createWorker.submit' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('does not offer Worker locations on a controlled computer that cannot honor them', async () => {
    const onCreate = vi.fn();
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'codex/gpt-5.5' }],
      supportsOrcaWorkerPermissionMode: true,
    };
    render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} deviceId="dev-1" remoteAgentDevices={devices} />,
    );
    expect(screen.getByTestId('model-selector').dataset.remoteSelected).toBe('none');
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('agentDeviceId');
  });

  it('lists the controlled computer as home when it supports Worker locations', () => {
    mocks.capabilitiesByAgent.codex = {
      availableModels: [{ id: 'codex/gpt-5.5' }],
      supportsOrcaWorkerPermissionMode: true,
    } as typeof mocks.capabilitiesByAgent.codex;
    // 整台电脑的协议位按那台一定注册的 Claude Code 读，不按 Worker 选的 Agent 读。
    mocks.capabilitiesByAgent['claude-code'] = {
      ...mocks.capabilitiesByAgent['claude-code'],
      supportsOrcaWorkerPermissionMode: true,
      supportsOrcaWorkerAgentDevice: true,
    } as typeof mocks.capabilitiesByAgent['claude-code'];
    render(
      <CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} deviceId="dev-1" remoteAgentDevices={devices} />,
    );
    const selector = screen.getByTestId('model-selector');
    expect(selector.dataset.remoteSelected).toBe('null');
    expect(selector.dataset.remoteHome).toBe('dev-1');
  });
});

describe('execution device helpers', () => {
  it('parses the device list defensively', () => {
    expect(parseExecutionDevices(null)).toEqual([]);
    expect(
      parseExecutionDevices({
        devices: [{ deviceId: 'a', name: '', platform: 1, supported: 'yes' }, { name: 'no id' }],
      }),
    ).toEqual([{ deviceId: 'a', name: 'a', platform: null, supported: false }]);
  });

  it('accepts absolute paths for any operating system', () => {
    expect(isAbsoluteRemoteDir('/Users/demo')).toBe(true);
    expect(isAbsoluteRemoteDir('D:\\work')).toBe(true);
    expect(isAbsoluteRemoteDir('C:/work')).toBe(true);
    expect(isAbsoluteRemoteDir('\\\\nas\\share')).toBe(true);
    expect(isAbsoluteRemoteDir('~/work')).toBe(false);
    expect(isAbsoluteRemoteDir('work')).toBe(false);
  });
});

// Test value: the local picker must submit exactly the shown checkout and reset transient
// choices. Existing remote-directory tests do not exercise this path. Unit/jsdom, fake IPC.
describe('local Worker project selection', () => {
  const project = {directory: '/repo', baseRepo: '/repo', branch: 'main', exists: true, dirty: false, isWorktree: false};
  const context: WorkerProjectContext = {recordedDirectory: '/repo', inherited: project, selected: project, dialogue: false, projects: []};
  const projectContext = vi.fn();
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    projectContext.mockReset().mockResolvedValue(context);
    (window as unknown as {electronAPI: unknown}).electronAPI = {localDb: {orcaWorkflows: {projectContext}}, worktreeListBranches: vi.fn().mockResolvedValue({branches: ['main']})};
  });
  afterEach(() => {cleanup(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); delete (window as unknown as {electronAPI?: unknown}).electronAPI;});
  // Native picker cancellation does not select a project. Rejected IPC must also leave
  // the modal usable; previous field tests never opened the actual folder popover.
  it.each(['cancel', 'error'] as const)('keeps the selected project ready, closable and submittable after native picker %s', async (outcome) => {
    const user = userEvent.setup();
    window.localStorage.clear();
    resetProviderModelMemoryForTest();
    mocks.modelsByAgent.codex = [model('codex/gpt-5.5')];
    mocks.capabilitiesByAgent.codex = {availableModels: [{id: 'codex/gpt-5.5'}]};
    mocks.localProviders = [];
    mocks.remoteProviders = [];
    mocks.remoteUnsupported = false;
    const dialog = vi.fn();
    if (outcome === 'cancel') dialog.mockResolvedValue({canceled: true});
    else dialog.mockRejectedValueOnce(new Error('native dialog unavailable'));
    window.electronAPI.showOpenDirectoryDialog = dialog;
    const onClose = vi.fn();
    const onCreate = vi.fn();
    render(<CreateWorkerPopover open leadSessionId="lead" onClose={onClose} onCreate={onCreate} />);
    await openMoreSettings();
    const current = await screen.findByRole('button', {name: 'orca.workerProject.current'});
    await user.click(current);
    await user.click(screen.getByRole('button', {name: 'newChat.folderPicker.browseProjectFolder'}));
    expect(dialog).toHaveBeenCalledTimes(1);
    if (outcome === 'error') expect(screen.getByRole('alert').textContent).toContain('newChat.folderPicker.browseFailed');
    expect(screen.queryByText('ccAgent.common.loading')).toBeNull();
    expect(screen.getByRole('button', {name: 'orca.workerProject.current'})).toBe(current);
    expect(projectContext).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', {name: 'orca.createWorker.closeAria'}));
    expect(onClose).toHaveBeenCalledTimes(1);
    // The controlled test parent keeps the modal mounted after close, so submit also
    // exercises the same settled state without resetting the component.
    await user.click(screen.getByRole('button', {name: 'orca.createWorker.submit'}));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('workingDir');
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('projectPath');
  });
  // N07/N09, unit/jsdom: injected HEAD probe states must change visible controls without
  // changing the submitted revision. Previous tests covered only named branches.
  function ProjectForm({ onCreate }: { onCreate: (fields: unknown) => void }) {
    const selection = useWorkerProjectSelection(true, 'lead', true);
    return <>
      <WorkerProjectField selection={selection} disabled={false} />
      <button disabled={!selection.ready} onClick={() => onCreate(selection.fields)}>Create</button>
    </>;
  }
  // P3: a vanished directory must explain the disabled creation action, not claim
  // that the Worker will run there as though it were an ordinary non-Git directory.
  it('explains a missing directory before non-Git details and keeps creation disabled', async () => {
    const missing = {...project, directory: '/gone', baseRepo: null, branch: null, exists: false};
    projectContext.mockResolvedValue({...context, selected: missing});
    const onCreate = vi.fn();
    render(<Tooltip.Provider><ProjectForm onCreate={onCreate} /></Tooltip.Provider>);
    await screen.findByText('orca.workerProject.missingDirectory');
    expect(screen.queryByText('orca.workerProject.notGit /gone')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const create = screen.getByRole('button', {name: 'Create'}) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();
  });
  it('explains an empty repository, hides worktree creation and still allows direct creation', async () => {
    const empty = {...project, branch: null, headState: 'unborn'};
    projectContext.mockResolvedValue({...context, inherited: empty, selected: empty});
    const onCreate = vi.fn();
    render(<Tooltip.Provider><ProjectForm onCreate={onCreate} /></Tooltip.Provider>);
    await screen.findByText('orca.workerProject.emptyRepo /repo');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Create'}));
    expect(onCreate).toHaveBeenCalledWith({});
  });
  it('shows a shortened detached HEAD while submitting its full SHA or a picked real branch', async () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef0123';
    const detached = {...project, directory: '/other', baseRepo: '/other', branch: sha, headState: 'detached'};
    projectContext.mockResolvedValue({...context, selected: detached});
    window.electronAPI.worktreeListBranches = vi.fn().mockResolvedValue({branches: ['main']});
    const onCreate = vi.fn();
    render(<Tooltip.Provider><ProjectForm onCreate={onCreate} /></Tooltip.Provider>);
    await screen.findByText('orca.workerProject.directDetached other orca.workerProject.detachedHead abcdef01');
    fireEvent.click(screen.getByRole('checkbox'));
    const branchButton = screen.getByRole('button', {name: 'newChat.branchChip.label'});
    expect(branchButton.textContent).toContain('orca.workerProject.detachedHead abcdef01');
    expect(branchButton.textContent).not.toContain(sha);
    fireEvent.click(screen.getByRole('button', {name: 'Create'}));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({worktree: {sourceBranch: sha}}));
    fireEvent.click(branchButton);
    fireEvent.click(await screen.findByRole('option', {name: 'main'}));
    fireEvent.click(screen.getByRole('button', {name: 'Create'}));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({worktree: {sourceBranch: 'main'}}));
    expect(branchButton.textContent).toBe('main');
  });
  it('displays the remote source as origin/main but submits its full ref without fetching', async () => {
    window.electronAPI.worktreeListBranches = vi.fn().mockResolvedValue({branches: ['main'], remoteDefaultBranch: 'refs/remotes/origin/main'});
    window.electronAPI.worktreeBranchSyncStatus = vi.fn().mockResolvedValue({branch: 'main', remote: 'origin', remoteBranch: 'main', remoteOnly: false, ahead: 0, behind: 0, dirtyFiles: 0});
    window.electronAPI.worktreeSyncBranch = vi.fn();
    const onCreate = vi.fn();
    render(<Tooltip.Provider><ProjectForm onCreate={onCreate} /></Tooltip.Provider>);
    await screen.findByRole('checkbox');
    fireEvent.click(screen.getByRole('checkbox'));
    const branchButton = screen.getByRole('button', {name: 'newChat.branchChip.label'});
    expect(window.electronAPI.worktreeListBranches).not.toHaveBeenCalled();
    fireEvent.click(branchButton);
    fireEvent.click(await screen.findByRole('option', {name: 'origin/main'}));
    expect(branchButton.textContent).toBe('origin/main');
    expect(screen.getByText('orca.workerProject.splitWarning origin/main')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Create'}));
    expect(onCreate).toHaveBeenLastCalledWith({worktree: {sourceBranch: 'refs/remotes/origin/main'}});
    expect(window.electronAPI.worktreeSyncBranch).not.toHaveBeenCalled();
  });
  it('omits workingDir for unchanged inheritance and resets worktree choice on reopening', async () => {
    const {result, rerender} = renderHook(({open}) => useWorkerProjectSelection(open, 'lead', true), {initialProps: {open: true}});
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.fields).not.toHaveProperty('workingDir');
    expect(result.current.fields).not.toHaveProperty('projectPath');
    act(() => result.current.setChecked(true));
    expect(result.current.fields.worktree).toEqual({sourceBranch: 'main'});
    rerender({open: false}); rerender({open: true});
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.fields).not.toHaveProperty('worktree');
  });
  it('submits a detected checkout explicitly while keeping its own branch', async () => {
    const inherited = {...project, directory: '/checkout', branch: 'feature', isWorktree: true};
    projectContext.mockResolvedValue({...context, inherited, selected: inherited});
    const {result} = renderHook(() => useWorkerProjectSelection(true, 'lead', true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.fields.workingDir).toBe('/checkout');
    expect(result.current.branch).toBe('feature');
    expect(result.current.fields).not.toHaveProperty('projectPath');
  });
  it('ignores an old project response and resets checkbox and source on each selection', async () => {
    let resolveOld!: (value: WorkerProjectContext['selected']) => void;
    const old = new Promise<WorkerProjectContext['selected']>(resolve => {resolveOld = resolve;});
    projectContext.mockImplementation(async (_id, dir) => dir === '/old' ? old : dir ? {...project, directory: dir, baseRepo: dir, branch: 'other'} : context);
    const {result} = renderHook(() => useWorkerProjectSelection(true, 'lead', true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {result.current.setChecked(true); result.current.setSourceBranch('chosen');});
    act(() => result.current.select('/old'));
    act(() => result.current.select('/new'));
    await waitFor(() => expect(result.current.fields.workingDir).toBe('/new'));
    await act(async () => resolveOld({...project, directory: '/old'}));
    expect(result.current.fields.workingDir).toBe('/new');
    expect(result.current.checked).toBe(false);
    expect(result.current.branch).toBe('other');
    expect(result.current.fields.projectPath).toBe('/new');
    act(() => result.current.select('/repo'));
    await waitFor(() => expect(result.current.context?.selected.directory).toBe('/repo'));
    expect(result.current.fields).not.toHaveProperty('projectPath');
    expect(result.current.fields).not.toHaveProperty('workingDir');
    expect(projectContext.mock.calls.filter((call) => call.length === 1)).toHaveLength(1);
    expect(projectContext.mock.calls.map((call) => call[1])).toEqual([undefined, '/old', '/new']);
  });
  // A browsed directory reaches the same select callback without needing a recent-list row.
  it('retains explicitly browsed directories even when their repository matches the Lead', async () => {
    projectContext.mockImplementation(async (_id, dir) => dir === '/browsed' ? {...project, directory: '/browsed', baseRepo: '/browsed'} : dir ? {...project, directory: dir} : context);
    const {result} = renderHook(() => useWorkerProjectSelection(true, 'lead', true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.select('/browsed'));
    await waitFor(() => expect(result.current.fields.projectPath).toBe('/browsed'));
    act(() => result.current.select('/repo-alias', 'browse'));
    await waitFor(() => expect(result.current.fields.workingDir).toBe('/repo-alias'));
    expect(result.current.fields.projectPath).toBe('/repo');
  });
  // Review P1: explicit same-repository choices were silently replaced by inheritance.
  // Unit/jsdom: exercise the actual native-picker callback and submitted form fields.
  // PR #7933 P2: a saved release branch must not replace HEAD within the same repo.
  it.each(['/repo/apps/api', '/repo/.cindy-worktrees/other', '/repo'])(
    'submits the explicitly browsed same-repository directory %s', async (directory) => {
      const inherited = {...project, directory: '/repo/apps/web', baseRepo: '/repo/'};
      window.electronAPI.getNewMakerWorktreeBranchPreference = vi.fn().mockResolvedValue({baseRepo: '/repo', sourceBranch: 'release', revision: 1});
      window.electronAPI.worktreeListBranches = vi.fn().mockResolvedValue({branches: ['selected-branch', 'release']});
      const opening = {...context, recordedDirectory: inherited.directory, inherited, selected: inherited};
      projectContext.mockImplementation(async (_id, dir) => dir
        ? {...project, directory: dir, branch: 'selected-branch'} : opening);
      window.electronAPI.showOpenDirectoryDialog = vi.fn().mockResolvedValue({canceled: false, path: directory});
      const onCreate = vi.fn();
      render(<Tooltip.Provider><ProjectForm onCreate={onCreate} /></Tooltip.Provider>);
      fireEvent.click(await screen.findByRole('button', {name: 'orca.workerProject.current'}));
      fireEvent.click(screen.getByRole('button', {name: 'newChat.folderPicker.browseProjectFolder'}));
      await waitFor(() => expect(projectContext).toHaveBeenLastCalledWith('lead', directory));
      await waitFor(() => expect((screen.getByRole('button', {name: 'Create'}) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', {name: 'Create'}));
      expect(onCreate).toHaveBeenCalledWith({workingDir: directory, projectPath: '/repo'});
      expect(window.electronAPI.getNewMakerWorktreeBranchPreference).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('orca.workerProject.newWorktree'));
      fireEvent.click(screen.getByRole('button', {name: 'Create'}));
      expect(onCreate).toHaveBeenLastCalledWith({workingDir: directory, projectPath: '/repo', worktree: {sourceBranch: 'selected-branch'}});
    },
  );
  // Unit/jsdom: production form selection now reads a repository's main-task branch memory.
  // Previous cases only covered checkout HEAD. Missing refs/read failures must display and submit HEAD.
  it.each(['remembered', 'remote-default', 'missing', 'read-failed'])('uses actual default branch for another project: %s', async scenario => {
    window.electronAPI.getNewMakerWorktreeBranchPreference = vi.fn().mockImplementation(async () => {
      if (scenario === 'read-failed') throw new Error('old host');
      return { baseRepo: '/other', sourceBranch: scenario === 'remote-default' ? 'refs/remotes/origin/main' : 'release', revision: 1 };
    });
    window.electronAPI.worktreeListBranches = vi.fn().mockResolvedValue({ branches: scenario === 'missing' ? ['main'] : ['main', 'release'], remoteDefaultBranch: 'refs/remotes/origin/main' });
    projectContext.mockImplementation(async (_id, dir) => dir ? { ...project, directory: '/other', baseRepo: '/other' } : context);
    const { result } = renderHook(() => useWorkerProjectSelection(true, 'lead', true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(window.electronAPI.getNewMakerWorktreeBranchPreference).not.toHaveBeenCalled();
    act(() => result.current.select('/other'));
    await waitFor(() => expect(result.current.context?.selected.directory).toBe('/other'));
    const expected = scenario === 'remote-default' ? 'refs/remotes/origin/main' : scenario === 'remembered' ? 'release' : project.branch;
    expect(result.current.branch).toBe(expected);
    act(() => result.current.setChecked(true));
    expect(result.current.fields.worktree?.sourceBranch).toBe(expected);
    act(() => result.current.setSourceBranch('manual'));
    expect(result.current.fields.worktree?.sourceBranch).toBe('manual');
  });
  it('allows a Git project selected from a dialogue Lead and never probes a disabled remote form', async () => {
    projectContext.mockResolvedValue({...context, dialogue: true, selected: {...project, directory: '/other', baseRepo: '/other'}});
    const {result} = renderHook(() => useWorkerProjectSelection(true, 'lead', true));
    await waitFor(() => expect(result.current.canWorktree).toBe(true));
    projectContext.mockClear();
    renderHook(() => useWorkerProjectSelection(true, 'remote', false));
    expect(projectContext).not.toHaveBeenCalled();
  });
});

// Unit: only submitted local host routes count, never synthetic or legacy per-agent defaults.
it('exports only the current owner local route for tool defaults', () => {
  const route = { agent: 'pi', model: 'test-model', providerId: 'provider', agentDeviceId: null, effort: '', fast: false };
  localStorage.setItem('workerCreationPrefs', JSON.stringify({ lastAgent: 'pi', pi: route }));
  expect(readLocalWorkerCreationSelection('owner')).toBeNull();
  localStorage.setItem('workerCreationPrefs', JSON.stringify({ modelSelectionByHost: {
    [JSON.stringify(['owner', 'device'])]: route,
    [JSON.stringify(['other', 'local'])]: route,
  } }));
  expect(readLocalWorkerCreationSelection('owner')).toBeNull();
  localStorage.setItem('workerCreationPrefs', JSON.stringify({ modelSelectionByHost: { [JSON.stringify(['owner', 'local'])]: route } }));
  expect(readLocalWorkerCreationSelection('owner')).toEqual(route);
});
