// @vitest-environment jsdom
/**
 * Regression coverage for `usePluginModelPickerEngines` remote/shared discovery when editing a
 * plugin on a controlled computer (`hostDeviceId`).
 *
 * Test value:
 * - Production entrypoint: `usePluginModelPickerEngines`.
 * - Bug fixed: when `hostDeviceId` was set and `allowRemote` was true, the hook only listed the
 *   controlled computer's own engines plus an already-selected remote engine, making first-time
 *   selection of another computer's or shared plugin engine impossible while on a built-in model.
 * - Minimal failing input: `hostDeviceId = 'mac-mini'`, `allowRemote = true`, built-in `active`
 *   route, controlled host reports another computer (`studio`) and a plugin-engine share
 *   (`share:s1`). Both must be queried via `modelCatalogKey(id, 'mac-mini')` and offered as choices.
 * - Tier: unit (jsdom).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginEnginesPickerProps } from '@/components/new-chat/PluginEnginesSection';
import { usePluginModelPickerEngines } from '../usePluginModelPickerEngines';
import { modelCatalogKey, type ControlledModelLocation } from '../../../shared/controlledModelCatalog';
import type { PluginEngineView } from '../../../shared/pluginEngines';

const state = vi.hoisted(() => ({
  selfDeviceId: 'self-mac' as string | null,
  hostLocations: undefined as ControlledModelLocation[] | undefined,
  remoteHostEngines: [] as PluginEngineView[],
  localEngines: [] as PluginEngineView[],
  deviceCatalogues: new Map<string, readonly PluginEngineView[] | null>(),
  requestedKeys: [] as string[],
  readDevicePluginEngines: vi.fn(),
  refreshRemoteHostEngines: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthDeviceId: () => state.selfDeviceId,
}));
vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: [] }),
}));
vi.mock('@/features/provider-share/useProviderShareAgentDevices', () => ({
  useProviderShareAgentDevices: () => ({
    pluginEngineDevices: [],
    nameFor: (id: string) => (id === 'share:s1' ? '来自 Alice 的分享' : null),
    isReceived: (id: string) => id === 'share:s1',
  }),
}));
vi.mock('@/hooks/useControlledModelLocations', () => ({
  useControlledModelLocations: (deviceId: string | null | undefined) =>
    (deviceId ? state.hostLocations : undefined),
}));
vi.mock('@/hooks/usePluginEngines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/usePluginEngines')>()),
  usePluginEngines: () => state.localEngines,
  useRemotePluginEngines: (deviceId: string | undefined) => ({
    engines: deviceId ? state.remoteHostEngines : [],
    refresh: state.refreshRemoteHostEngines,
  }),
  useDevicesPluginEngines: (keys: readonly string[]) => {
    state.requestedKeys = [...keys];
    return {
      catalogues: state.deviceCatalogues,
      read: state.readDevicePluginEngines,
    };
  },
}));

function makeEngine(providerId: string, name: string, allowRemote = true): PluginEngineView {
  const key = providerId.replace(/^acp-plugin:/, '');
  return {
    key,
    providerId,
    ghostId: 'example',
    harnessId: key.split(':').pop() ?? 'h1',
    name,
    availability: { state: 'available' },
    models: [{ id: 'model-1', displayName: 'Model 1', efforts: ['low', 'high'], defaultEffort: 'high' }],
    permissionModes: [{ id: 'ask', displayName: 'Ask' }],
    defaultPermissionMode: 'ask',
    remoteUse: { supported: true, enabled: allowRemote },
  };
}

describe('usePluginModelPickerEngines', () => {
  beforeEach(() => {
    state.selfDeviceId = 'self-mac';
    state.hostLocations = undefined;
    state.remoteHostEngines = [];
    state.localEngines = [];
    state.deviceCatalogues = new Map();
    state.requestedKeys = [];
    state.readDevicePluginEngines.mockReset();
    state.refreshRemoteHostEngines.mockReset();
  });

  afterEach(cleanup);

  it('discovers remote and shared plugin engines of a controlled computer for first-time selection', () => {
    const hostEngine = makeEngine('acp-plugin:host:h1', 'Host Engine', false);
    const studioEngine = makeEngine('acp-plugin:studio:s1', 'Studio Engine', true);
    const sharedEngine = makeEngine('acp-plugin:shared:sh1', 'Shared Engine', true);

    state.remoteHostEngines = [hostEngine];
    state.hostLocations = [
      { agentDeviceId: 'mac-mini', name: 'Mac Mini' },
      { agentDeviceId: 'studio', name: 'Mac Studio' },
      {
        agentDeviceId: 'share:s1',
        name: 'Alice Host Label',
        favoriteSource: {
          shareId: 's1',
          providerId: 'acp-plugin:shared:sh1',
          memberId: 'm1',
          owner: { region: 'global' },
        },
      },
      {
        agentDeviceId: 'share:builtin',
        name: 'Builtin Share',
        favoriteSource: {
          shareId: 'builtin',
          providerId: 'openai',
          memberId: 'm2',
          owner: { region: 'global' },
        },
      },
    ];
    const studioKey = modelCatalogKey('studio', 'mac-mini')!;
    const shareKey = modelCatalogKey('share:s1', 'mac-mini')!;
    state.deviceCatalogues = new Map([
      [studioKey, [studioEngine]],
      [shareKey, [sharedEngine]],
    ]);

    let result: PluginEnginesPickerProps | undefined;
    function Harness() {
      result = usePluginModelPickerEngines({
        enabled: true,
        allowRemote: true,
        hostDeviceId: 'mac-mini',
        active: { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.4' },
        onSelect: vi.fn(),
      });
      return null;
    }

    render(<Harness />);

    expect(state.requestedKeys).toEqual([studioKey, shareKey]);
    expect(result?.engines.map((engine) => ({
      providerId: engine.providerId,
      deviceId: engine.deviceId,
      deviceName: engine.deviceName,
    }))).toEqual([
      { providerId: hostEngine.providerId, deviceId: undefined, deviceName: undefined },
      { providerId: studioEngine.providerId, deviceId: 'studio', deviceName: 'Mac Studio' },
      { providerId: sharedEngine.providerId, deviceId: 'share:s1', deviceName: '来自 Alice 的分享' },
    ]);
  });

  it('keeps only the controlled computer engines when allowRemote is false', () => {
    const hostEngine = makeEngine('acp-plugin:host:h1', 'Host Engine', false);
    const studioEngine = makeEngine('acp-plugin:studio:s1', 'Studio Engine', true);
    state.remoteHostEngines = [hostEngine];
    state.hostLocations = [{ agentDeviceId: 'studio', name: 'Mac Studio' }];
    state.deviceCatalogues = new Map([[modelCatalogKey('studio', 'mac-mini')!, [studioEngine]]]);

    let result: PluginEnginesPickerProps | undefined;
    function Harness() {
      result = usePluginModelPickerEngines({
        enabled: true,
        allowRemote: false,
        hostDeviceId: 'mac-mini',
        active: null,
        onSelect: vi.fn(),
      });
      return null;
    }

    render(<Harness />);

    expect(state.requestedKeys).toEqual([]);
    expect(result?.engines.map((engine) => engine.providerId)).toEqual([hostEngine.providerId]);
  });
});
