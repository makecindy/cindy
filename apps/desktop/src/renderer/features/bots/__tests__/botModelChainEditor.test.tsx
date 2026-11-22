// @vitest-environment jsdom
vi.mock('@/hooks/useModelRouteDevices', () => ({
  useModelRouteDevices: ({ leadAgentDeviceId, sshRemote }: { leadAgentDeviceId?: string | null; sshRemote?: boolean }) => ({
    devices: sshRemote ? undefined : [{ deviceId: 'share:one', name: 'Shared account' }],
    leadAgentDeviceId: leadAgentDeviceId ?? null,
  }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [] }) }));
const { pluginEngineState } = vi.hoisted(() => ({
  pluginEngineState: {
    local: [] as any[],
    remote: null as any[] | null,
    selectableDevices: [] as Array<{ deviceId: string; name: string; online: boolean }>,
    sharedPluginDevices: [] as Array<{ deviceId: string; name: string }>,
    deviceCatalogues: new Map<string, any[] | null>(),
    readDevicePluginEngines: vi.fn(),
  },
}));
vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: pluginEngineState.selectableDevices }),
}));
vi.mock('@/features/provider-share/useProviderShareAgentDevices', () => ({
  useProviderShareAgentDevices: () => ({
    devices: [],
    pluginEngineDevices: pluginEngineState.sharedPluginDevices,
    loaded: true,
    nameFor: (id: string | null | undefined) =>
      pluginEngineState.sharedPluginDevices.find((item) => item.deviceId === id)?.name ?? null,
    isKnown: () => true,
    isReceived: () => true,
  }),
}));
vi.mock('@/hooks/usePluginEngines', () => ({
  findPluginEngine: (list: readonly any[], providerId: string | null | undefined) =>
    list.find((item) => item.providerId === providerId) ?? null,
  requestPluginEnginesRefresh: vi.fn(),
  useDevicesPluginEngines: (deviceIds: readonly string[]) => ({
    catalogues: new Map(deviceIds.map((id) => [id, pluginEngineState.deviceCatalogues.get(id) ?? null])),
    read: pluginEngineState.readDevicePluginEngines,
  }),
  usePluginEngines: () => pluginEngineState.local,
  useRemotePluginEngines: () => ({ engines: pluginEngineState.remote, refresh: vi.fn() }),
}));


import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { modelSelectorProps, roster, defaultModel } = vi.hoisted(() => ({
  modelSelectorProps: vi.fn(),
  defaultModel: { model: 'default-model' },
  roster: { availableVendors: new Set(['cc', 'codex', 'pi']), loaded: true },
}));

vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => roster }));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    onEffortChange: (effort: string) => void;
    onFastModeChange: (enabled: boolean) => void;
    onUnifiedSelect: (selection: {
      providerId: string;
      modelId: string;
      effort?: string;
      engine: 'cc' | 'codex' | 'pi';
      fast: boolean;
      favoriteUid: string | null;
    }) => void;
  }) => {
    modelSelectorProps(props);
    return (
      <div data-testid={`model-selector-${props.modelId}`}>
        <button onClick={() => props.onEffortChange("high")}>set-high-effort</button>
        <button onClick={() => props.onFastModeChange(true)}>enable-fast-mode</button>
        <button
          type="button"
          onClick={() =>
            props.onUnifiedSelect({
              providerId: 'openai',
              modelId: 'gpt-5.6-sol',
              effort: 'medium',
              engine: 'codex',
              fast: true,
              favoriteUid: null,
            })
          }
        >
          choose-official-codex-model
        </button>
        <button
          type="button"
          onClick={() =>
            props.onUnifiedSelect({
              providerId: 'anthropic',
              modelId: 'claude-opus-5',
              engine: 'cc',
              fast: false,
              favoriteUid: null,
            })
          }
        >
          choose-official-claude-model
        </button>
      </div>
    );
  },
}));

vi.mock('../botStore', () => ({
  getEffectiveBotModelSettings: () => ({
    model: defaultModel.model,
    providerId: null,
    effort: '',
    fastMode: false,
  }),
}));

vi.mock('../botPronounContext', () => ({
  useBotTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

import { BotModelChainEditor } from '../BotModelChainEditor';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  roster.availableVendors = new Set(['cc', 'codex', 'pi']);
  roster.loaded = true;
  defaultModel.model = 'default-model';
  pluginEngineState.local = [];
  pluginEngineState.remote = null;
  pluginEngineState.selectableDevices = [];
  pluginEngineState.sharedPluginDevices = [];
  pluginEngineState.deviceCatalogues = new Map();
  pluginEngineState.readDevicePluginEngines.mockReset();
});

describe('BotModelChainEditor', () => {
  const primary = { harness: 'codex' as const, model: 'primary-model', providerId: 'openai', effort: 'medium', fastMode: false };
  const firstFallback = { ...primary, model: 'first-fallback' };
  const secondFallback = { ...primary, model: 'second-fallback' };

  it.each(['inline', 'settings'] as const)('keeps the caller setting ID on the %s editor', (layout) => {
    render(<BotModelChainEditor data-setting-id="general.botModelChain" layout={layout}
      settingsRows={{ primaryLabel: 'Primary', primaryHint: 'Preferred model' }}
      value={[primary]} onChange={vi.fn()} />);
    expect(screen.getByTestId('bot-model-chain-editor').getAttribute('data-setting-id')).toBe('general.botModelChain');
  });

  function fallbackList(container: HTMLElement) {
    return within(container.querySelector('[data-testid="bot-model-fallbacks"]')!);
  }

  it('immediately lists and numbers only fallbacks, and edits the second route without replacing the primary', () => {
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[primary, firstFallback]} onChange={onChange} />);
    const fallbacks = fallbackList(view.container);

    expect(screen.getAllByTestId('model-selector-primary-model')).toHaveLength(1);
    expect(fallbacks.queryByTestId('model-selector-primary-model')).toBeNull();
    expect(fallbacks.getByText('bots.modelChain.options:{"count":1}')).toBeTruthy();
    expect(fallbacks.getByText('1')).toBeTruthy();
    expect(fallbacks.queryByText('2')).toBeNull();
    const picker = within(fallbacks.getByTestId('model-selector-first-fallback'));
    fireEvent.click(picker.getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenLastCalledWith([primary, {
      harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: true,
    }]);
    fireEvent.click(picker.getByText('set-high-effort'));
    expect(onChange).toHaveBeenLastCalledWith([primary, { ...firstFallback, effort: 'high' }]);
    fireEvent.click(picker.getByText('enable-fast-mode'));
    expect(onChange).toHaveBeenLastCalledWith([primary, { ...firstFallback, fastMode: true }]);
  });

  it('reorders and removes fallbacks while keeping the primary in place', () => {
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[primary, firstFallback, secondFallback]} onChange={onChange} />);
    const fallbacks = fallbackList(view.container);
    const up = fallbacks.getAllByLabelText('bots.modelChain.moveUp');
    expect((up[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(up[0]!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(up[1]!);
    expect(onChange).toHaveBeenLastCalledWith([primary, secondFallback, firstFallback]);
    fireEvent.click(fallbacks.getAllByLabelText('bots.modelChain.moveDown')[0]!);
    expect(onChange).toHaveBeenLastCalledWith([primary, secondFallback, firstFallback]);
    fireEvent.click(fallbacks.getAllByLabelText('bots.modelChain.remove')[0]!);
    expect(onChange).toHaveBeenLastCalledWith([primary, secondFallback]);

    view.rerender(<BotModelChainEditor value={[primary, secondFallback]} onChange={onChange} />);
    expect(fallbacks.getByText('1')).toBeTruthy();
    expect(fallbacks.queryByText('2')).toBeNull();
    fireEvent.click(fallbacks.getByLabelText('bots.modelChain.remove'));
    expect(onChange).toHaveBeenLastCalledWith([primary]);
  });

  it('shows no fallback rows for a primary-only chain and appends the first fallback', () => {
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[primary]} onChange={onChange} />);
    const fallbacks = fallbackList(view.container);
    expect(fallbacks.getByText('bots.modelChain.options:{"count":0}')).toBeTruthy();
    expect(fallbacks.queryByTestId('model-selector-primary-model')).toBeNull();
    expect(fallbacks.queryByLabelText('bots.modelChain.remove')).toBeNull();
    fireEvent.click(fallbacks.getByText('bots.modelChain.add'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(fallbacks.getByTestId('model-selector-')).getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenLastCalledWith([primary, expect.objectContaining({ model: 'gpt-5.6-sol' })]);
  });

  it('uses the standard configurable picker for the current harness', () => {
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'z-ai/glm-5.3-flash',
            providerId: 'xd',
            effort: 'high',
            fastMode: false,
          },
        ]}
        onChange={vi.fn()}
        hiddenVendors={['codex']}
      />,
    );

    expect(modelSelectorProps).toHaveBeenCalledTimes(1);
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedLayout).toBeUndefined();
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedLayoutControls).toBeUndefined();
    expect(modelSelectorProps.mock.calls[0]?.[0]).toMatchObject({
      configurationEnabled: true,
      vendorKey: 'pi',
      unifiedPanel: true,
      unifiedAgents: ['pi', 'claude-code'],
      triggerVariant: 'settings',
    });
  });

  it('blocks picker callbacks and chain controls when disabled', () => {
    const route = { harness: 'codex' as const, model: 'saved-model', providerId: 'openai', effort: '', fastMode: false };
    const onChange = vi.fn();
    const restore = vi.fn();
    render(<BotModelChainEditor value={[route, { ...route, model: 'backup' }]} onChange={onChange} onRestoreDefault={restore} disabled />);
    expect(modelSelectorProps.mock.lastCall?.[0].disabled).toBe(true);
    // Simulate callbacks from content portaled outside the disabled trigger.
    fireEvent.click(within(screen.getByTestId('model-selector-saved-model')).getByText('choose-official-codex-model'));
    fireEvent.click(within(screen.getByTestId('model-selector-saved-model')).getByText('set-high-effort'));
    fireEvent.click(within(screen.getByTestId('model-selector-saved-model')).getByText('enable-fast-mode'));
    for (const label of ['bots.modelChain.moveUp', 'bots.modelChain.moveDown', 'bots.modelChain.remove']) {
      for (const button of screen.getAllByLabelText(label)) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(button);
      }
    }
    fireEvent.click(screen.getByText('bots.modelChain.add'));
    fireEvent.click(screen.getByText('bots.model.restoreDefault'));
    expect(onChange).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('allows selecting the first route when the default chain is empty', () => {
    const onChange = vi.fn();
    render(<BotModelChainEditor value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenCalledWith([{ harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: true }]);
  });

  it('allows shared models without a locally installed harness and waits for an explicit backup choice', () => {
    roster.availableVendors = new Set();
    roster.loaded = false;
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor value={[]} onChange={onChange} />);
    const props = modelSelectorProps.mock.lastCall?.[0];
    expect(props).toMatchObject({ disabled: false, unifiedAgents: ['pi', 'codex', 'claude-code'],
      remoteAgent: { devices: [{ deviceId: 'share:one', name: 'Shared account' }] } });
    props.onUnifiedSelect({ engine: 'codex', modelId: 'remote-model', providerId: 'openai', effort: 'medium', fast: false,
      agentDevice: { deviceId: 'share:one', name: 'Shared account' } });
    expect(onChange).toHaveBeenLastCalledWith([{ harness: 'codex', model: 'remote-model', providerId: 'openai',
      effort: 'medium', fastMode: false, agentDeviceId: 'share:one' }]);
    view.rerender(<BotModelChainEditor value={onChange.mock.lastCall![0]} onChange={onChange} />);
    expect(modelSelectorProps.mock.lastCall?.[0]).toMatchObject({ deviceId: 'share:one',
      remoteAgent: { selectedDeviceId: 'share:one', homeDeviceId: undefined } });
    onChange.mockClear();
    fireEvent.click(screen.getByText('bots.modelChain.add'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('writes depth and fast mode to the selected route without changing its model', () => {
    const route = { harness: 'codex' as const, model: 'gpt-5.6-sol',
      providerId: 'openai', effort: 'medium', fastMode: false };
    const fallback = { ...route, model: 'fallback-model' };
    const onChange = vi.fn();
    render(<BotModelChainEditor value={[route, fallback]} onChange={onChange} />);
    fireEvent.click(within(screen.getByTestId('model-selector-gpt-5.6-sol')).getByText('set-high-effort'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...route, effort: 'high' }, fallback]);
    fireEvent.click(within(screen.getByTestId('model-selector-gpt-5.6-sol')).getByText('enable-fast-mode'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...route, fastMode: true }, fallback]);
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedSelectionPolicy).toBeUndefined();
  });

  it('keeps remote routes editable when the roster is unknown, then applies the recovered roster', () => {
    // useAvailableAgents retains this state after a rejected tunnel request.
    roster.availableVendors = new Set();
    roster.loaded = false;
    const onChange = vi.fn();
    const props = { deviceId: 'remote-host', value: [primary], onChange };
    const view = render(<BotModelChainEditor {...props} hiddenVendors={['pi']} />);
    expect(modelSelectorProps.mock.lastCall?.[0]).toMatchObject({
      deviceId: 'remote-host', disabled: false, unifiedAgents: ['codex', 'claude-code'],
    });
    fireEvent.click(screen.getByText('set-high-effort'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...primary, effort: 'high' }]);
    fireEvent.click(screen.getByText('enable-fast-mode'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...primary, fastMode: true }]);
    fireEvent.click(screen.getByText('choose-official-claude-model'));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ harness: 'claude', providerId: 'anthropic' })]);

    const fallbacks = fallbackList(view.container);
    fireEvent.click(fallbacks.getByText('bots.modelChain.add'));
    onChange.mockClear();
    fireEvent.click(fallbacks.getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenCalledWith([primary, expect.objectContaining({ harness: 'codex', providerId: 'openai' })]);

    roster.loaded = true;
    roster.availableVendors = new Set(['codex']);
    onChange.mockClear();
    view.rerender(<BotModelChainEditor {...props} hiddenVendors={['pi']} />);
    expect(modelSelectorProps.mock.lastCall?.[0].unifiedAgents).toEqual(['codex', 'claude-code']);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('choose-official-claude-model'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ harness: 'claude' })]);
  });

  it('keeps remote catalog selection available when the home roster is empty', () => {
    roster.availableVendors = new Set();
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor deviceId="remote-host" value={[]} onChange={onChange} />);
    expect(modelSelectorProps.mock.lastCall?.[0].unifiedAgents).toEqual(['pi', 'codex', 'claude-code']);
    expect((fallbackList(view.container).getByText('bots.modelChain.add') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('choose-official-codex-model'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ harness: 'codex' })]);
  });

  it('honors disabled remote settings even with an unknown roster', () => {
    roster.availableVendors = new Set();
    roster.loaded = false;
    const onChange = vi.fn();
    const view = render(<BotModelChainEditor deviceId="remote-host" value={[primary]} onChange={onChange} disabled />);
    expect(modelSelectorProps.mock.lastCall?.[0].disabled).toBe(true);
    fireEvent.click(screen.getByText('choose-official-codex-model'));
    fireEvent.click(screen.getByText('set-high-effort'));
    fireEvent.click(screen.getByText('enable-fast-mode'));
    fireEvent.click(fallbackList(view.container).getByText('bots.modelChain.add'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('atomically stores the official harness, provider, model, effort, and fast mode', () => {
    const onChange = vi.fn();
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'model-with-effort',
            providerId: 'xd',
            effort: 'high',
            fastMode: false,
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('choose-official-codex-model'));

    expect(onChange).toHaveBeenCalledWith([
      {
        harness: 'codex',
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'medium',
        fastMode: true,
      },
    ]);
  });

  it('maps the Claude Code recommendation and clears an unavailable effort', () => {
    const onChange = vi.fn();
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'model-with-effort',
            providerId: 'xd',
            effort: 'high',
            fastMode: true,
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('choose-official-claude-model'));

    expect(onChange).toHaveBeenCalledWith([
      {
        harness: 'claude',
        model: 'claude-opus-5',
        providerId: 'anthropic',
        effort: '',
        fastMode: false,
      },
    ]);
  });
});

it('allows explicitly choosing a backup when no valid default is available', () => {
  defaultModel.model = '';
  const primary = { harness: 'codex' as const, model: 'primary-model', providerId: 'openai', effort: 'medium', fastMode: false };
  const change = vi.fn();
  render(<BotModelChainEditor value={[primary]} onChange={change} />);
  fireEvent.click(screen.getByText('bots.modelChain.add'));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByTestId('bot-model-fallbacks')).getByRole('button', { name: 'choose-official-codex-model' }));
  expect(change).toHaveBeenLastCalledWith([primary, { harness: 'codex', model: 'gpt-5.6-sol', providerId: 'openai', effort: 'medium', fastMode: true }]);
});

it('uses the selected device catalog without SSH subscription exclusions or local default fallbacks', () => {
  const change = vi.fn();
  render(<BotModelChainEditor deviceId="remote-host" value={[]} onChange={change} />);
  expect(modelSelectorProps.mock.lastCall?.[0]).toMatchObject({ deviceId: 'remote-host', excludeSubscriptionDirect: false, excludeChatBridgedCodex: false });
  fireEvent.click(screen.getByText('bots.modelChain.add'));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByTestId('bot-model-fallbacks')).getByRole('button', { name: 'choose-official-codex-model' }));
  expect(change).toHaveBeenCalledWith([expect.objectContaining({ providerId: 'openai', harness: 'codex' })]);
});

it.each([undefined, 'controlled-host'])('keeps home %s separate from the selected shared catalog', (deviceId) => {
  render(<BotModelChainEditor deviceId={deviceId} value={[{ harness: 'codex', model: 'shared-model',
    providerId: 'openai', effort: 'high', fastMode: false, agentDeviceId: 'share:one' }]} onChange={vi.fn()} />);
  expect(modelSelectorProps.mock.lastCall?.[0]).toMatchObject({ deviceId: 'share:one',
    remoteAgent: { selectedDeviceId: 'share:one', homeDeviceId: deviceId } });
});

it('preserves the SSH catalog when execution locations cannot be browsed', () => {
  render(<BotModelChainEditor remote value={[{ harness: 'codex', model: 'ssh-model',
    providerId: 'openai', effort: 'high', fastMode: false, agentDeviceId: 'share:one' }]} onChange={vi.fn()} />);
  expect(modelSelectorProps.mock.lastCall?.[0]).toMatchObject({ deviceId: undefined,
    remoteAgent: undefined, excludeSubscriptionDirect: true, excludeChatBridgedCodex: true });
});

// A companion's settings must save the host plugin's exact model and show it when reopened.
// Unit regression: use one plugin with no built-in providers in the real primary and backup editor.
it.each([undefined, 'controlled-host'])('saves and reopens a model offered by the companion host %s', deviceId => {
  const engine = {
    key: 'sample:engine', providerId: 'acp-plugin:sample:engine', ghostId: 'sample', harnessId: 'engine',
    name: 'Sample', availability: { state: 'available' }, models: [{ id: 'sample-model', displayName: 'Sample Model' }],
  };
  if (deviceId) pluginEngineState.remote = [engine];
  else pluginEngineState.local = [engine];
  const onChange = vi.fn();
  const view = render(<BotModelChainEditor deviceId={deviceId} value={[]} onChange={onChange} />);
  const picker = () => modelSelectorProps.mock.lastCall![0].pluginEngines;
  expect(picker().engines).toEqual([engine]);
  picker().onSelect({ providerId: engine.providerId, modelId: 'sample-model', effort: 'high' });
  const saved = onChange.mock.lastCall![0];
  expect(saved).toEqual([{ harness: 'acp', providerId: engine.providerId, model: 'sample-model', effort: 'high', fastMode: false }]);
  view.rerender(<BotModelChainEditor deviceId={deviceId} value={saved} onChange={onChange} />);
  expect(picker().active).toEqual({ providerId: engine.providerId, modelId: 'sample-model', effort: 'high' });
});

// 依据：伙伴模型列表与会话模型列表一致，本机未安装对应插件时也能列出、选择并回显同账号远程电脑和好友分享的插件供应商。
// 覆盖缺口：BotModelChainEditor 此前只读本机 usePluginEngines，且选中插件引擎时清空 agentDeviceId。
// 最小失败输入：本机无插件，仅存在一条 share:friend 插件分享与一台在线同账号电脑；tier：unit。
it('lists, saves and reopens shared and same-account remote plugin engines without local install', () => {
  const sharedEngine = {
    key: 'friend:engine', providerId: 'acp-plugin:friend:engine', ghostId: 'friend', harnessId: 'engine',
    name: 'Friend Engine', availability: { state: 'available' },
    remoteUse: { supported: true, enabled: true, shareSupported: true },
    models: [{ id: 'shared-model', displayName: 'Shared Model' }],
  };
  const peerEngine = {
    key: 'peer:engine', providerId: 'acp-plugin:peer:engine', ghostId: 'peer', harnessId: 'engine',
    name: 'Peer Engine', availability: { state: 'available' },
    remoteUse: { supported: true, enabled: true },
    models: [{ id: 'peer-model', displayName: 'Peer Model' }],
  };
  pluginEngineState.selectableDevices = [{ deviceId: 'mac-mini', name: 'Mac mini', online: true }];
  pluginEngineState.sharedPluginDevices = [{ deviceId: 'share:friend', name: '来自好友的分享' }];
  // Initial render before picker opens: catalogues not yet fetched, yet pluginEngines must still be wired so readCatalogue fires on open.
  const onChange = vi.fn();
  const view = render(<BotModelChainEditor value={[]} onChange={onChange} />);
  const picker = () => modelSelectorProps.mock.lastCall![0].pluginEngines;
  expect(picker()).toBeDefined();
  picker().readCatalogue();
  expect(pluginEngineState.readDevicePluginEngines).toHaveBeenCalledTimes(1);

  pluginEngineState.deviceCatalogues = new Map([
    ['share:friend', [sharedEngine]],
    ['mac-mini', [peerEngine]],
  ]);
  view.rerender(<BotModelChainEditor value={[]} onChange={onChange} />);
  expect(picker().engines).toEqual([
    expect.objectContaining({ providerId: peerEngine.providerId, deviceId: 'mac-mini', deviceName: 'Mac mini' }),
    expect.objectContaining({ providerId: sharedEngine.providerId, deviceId: 'share:friend', deviceName: '来自好友的分享' }),
  ]);

  picker().onSelect({ providerId: sharedEngine.providerId, deviceId: 'share:friend', modelId: 'shared-model', effort: 'high' });
  const saved = onChange.mock.lastCall![0];
  expect(saved).toEqual([{
    harness: 'acp',
    agentDeviceId: 'share:friend',
    providerId: sharedEngine.providerId,
    model: 'shared-model',
    effort: 'high',
    fastMode: false,
  }]);

  view.rerender(<BotModelChainEditor value={saved} onChange={onChange} />);
  expect(picker().active).toEqual({
    providerId: sharedEngine.providerId,
    deviceId: 'share:friend',
    modelId: 'shared-model',
    effort: 'high',
  });
  expect(pluginEngineState.readDevicePluginEngines).toHaveBeenCalledWith('share:friend');
});
