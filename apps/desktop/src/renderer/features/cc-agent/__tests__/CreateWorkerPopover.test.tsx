// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetForTest as resetProviderModelMemoryForTest,
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
    models: Record<string, Array<{ id: string; supportsFastMode?: boolean }>>;
  }>,
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
  useProviders: () => ({ providers: mocks.localProviders, loading: mocks.providersLoading }),
}));

vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: [], loading: mocks.providersLoading, error: null }),
}));

// 只覆写 useNavigate,保留真实导出:全量 mock 会连带打断任何间接依赖(copilot review)。
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    currentProviderId?: string | null;
    onProviderChange?: (providerId: string | null, modelId?: string, effort?: string) => void;
    onEffortChange: (effort: string) => void;
    reselectEmitsChange?: boolean;
    fastMode?: boolean;
    onFastModeChange?: (enabled: boolean) => void;
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
    mocks.hiddenModels = [];
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetProviderModelMemoryForTest();
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

  it('narrows a remembered provider whose model entry is hidden by visibility prefs', async () => {
    // 同模型多来源:用户隐藏了记忆来源那份条目后,面板已不显示该行,
    // 不能仍显式路由过去(codex review)。
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
});
