// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetForTest as resetProviderModelMemoryForTest,
  getProviderModelChoice,
  getProviderModelEffort,
  setProviderModelChoice,
  setProviderModelFast,
} from '@/state/providerModelMemory';
import { CreateWorkerPopover } from '../CreateWorkerPopover';

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
    codex: null as { availableModels: Array<{ id: string }> } | null,
    'claude-code': null as { availableModels: Array<{ id: string }> } | null,
  },
  capabilitiesLoading: false,
  providersLoading: false,
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
}));

function model(id: string, efforts = ['high'], defaultEffort = 'high') {
  return { id, efforts, defaultEffort, supportsFastMode: true };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  useDeviceProviders: () => ({
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
    effort?: string;
    currentProviderId?: string | null;
    onProviderChange?: (providerId: string | null, modelId?: string, effort?: string) => void;
    onEffortChange: (effort: string) => void;
    reselectEmitsChange?: boolean;
    fastMode?: boolean;
    onFastModeChange?: (enabled: boolean) => void;
    onNavigateToProviders?: () => void;
    modelMemory?: unknown;
  }) => (
    <div
      data-testid="model-selector"
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
      <button
        type="button"
        data-testid="pick-openai-row"
        onClick={() => props.onProviderChange?.('openai', 'gpt-5.5', 'medium')}
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

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: (_agent: string, providerId: string, m: { id: string }) =>
    !mocks.hiddenModels.includes(`${providerId}:${m.id}`),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('../workerModelAvailability', () => ({
  selectWorkerModels: ({ agent }: { agent: 'codex' | 'claude-code' }) => mocks.modelsByAgent[agent],
}));

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
    mocks.hiddenModels = [];
    mocks.sidebarWindow = false;
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetProviderModelMemoryForTest();
  });

  it('centers the setup and keeps agent and model on one row without changing its size', () => {
    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={vi.fn()} />);

    const panel = screen.getByText('orca.createWorker.title').closest('.relative.z-10');
    const overlay = panel?.parentElement;
    expect(overlay?.className).toContain('items-center');
    expect(overlay?.className).not.toContain('items-start');
    expect(overlay?.className).not.toContain('pt-[10vh]');
    expect(panel?.className).toContain('w-[500px]');
    expect(panel?.className).toContain('p-6');

    const agentSwitcher = screen.getByRole('tablist', {
      name: 'orca.createWorker.agentLabel',
    });
    const pairedFields = agentSwitcher.closest('.grid');
    expect(pairedFields?.className).toContain('grid-cols-[220px_minmax(0,1fr)]');
    expect(pairedFields?.contains(screen.getByTestId('model-selector'))).toBe(true);

    const initialTask = screen.getByPlaceholderText('orca.createWorker.initialTaskPlaceholder');
    expect(initialTask.className).toContain('h-[96px]');
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
    fireEvent.click(screen.getByRole('tab', { name: 'Claude' }));

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

  it('keeps the degraded flat panel for device-link remote creation', async () => {
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

  it('keeps live source and effort edits across agent tab switches', async () => {
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
    const onCreate = vi.fn();

    render(<CreateWorkerPopover open onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').dataset.currentProvider).toBe('openai'),
    );
    fireEvent.click(screen.getByTestId('pick-xd-row-bare'));
    fireEvent.click(screen.getByTestId('edit-active-effort'));
    fireEvent.click(screen.getByRole('tab', { name: 'Claude' }));
    await waitFor(() =>
      expect(screen.getByTestId('model-selector').textContent).toContain('claude-opus-4-7'),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
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
