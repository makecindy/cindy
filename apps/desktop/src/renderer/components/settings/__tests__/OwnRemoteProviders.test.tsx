// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OwnRemoteProviderDetail,
  OwnRemoteProviderRows,
  ownRemoteProviderKey,
  useOwnRemoteProviderList,
  useOwnRemoteProviders,
  type OwnRemoteProvider,
} from '../OwnRemoteProviders';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
const devices = vi.hoisted(() => ({ value: [] as Array<{ deviceId: string; name: string; platform: string | null }> }));
vi.mock('@/hooks/useControllableDevices', () => ({ useControllableDevices: () => devices.value }));
const catalogs = vi.hoisted(() => ({ value: new Map<string, unknown>() }));
const requestedIds = vi.hoisted(() => [] as string[][]);
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (ids: readonly string[]) => {
    requestedIds.push([...ids]);
    return catalogs.value;
  },
}));

function provider(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === 'anthropic' ? 'Anthropic' : 'OpenAI',
    agents: ['claude-code'],
    connected: true,
    remoteInvocationEnabled: true,
    routing: {},
    models: { 'claude-code': [{ id: 'opus', name: 'Opus 5.5' }, { id: 'hidden', name: 'Hidden' }] },
    ...overrides,
  };
}

beforeEach(() => {
  devices.value = [];
  catalogs.value = new Map();
  requestedIds.length = 0;
});

afterEach(() => cleanup());

describe('useOwnRemoteProviders', () => {
  it('lists the connected providers my online computers open for remote use', () => {
    devices.value = [
      { deviceId: 'mini-a', name: "Magi's Mac Mini", platform: 'darwin' },
      { deviceId: 'mini-b', name: 'Studio', platform: 'darwin' },
    ];
    catalogs.value = new Map([
      ['mini-a', {
        providers: [
          provider('anthropic'),
          provider('openai', { remoteInvocationEnabled: false }),
          provider('xai', { connected: false }),
          provider('xd', { suspended: true }),
        ],
        modelVisibilityOverrides: { 'claude-code:anthropic:hidden': false },
        loading: false,
        error: null,
      }],
      ['mini-b', { providers: [], loading: true, error: null }],
    ]);
    const { result } = renderHook(() => useOwnRemoteProviders());
    expect(requestedIds.at(-1)).toEqual(['mini-a', 'mini-b']);
    expect(result.current.map((entry) => [entry.deviceName, entry.provider.id])).toEqual([
      ["Magi's Mac Mini", 'anthropic'],
    ]);
    expect(result.current[0].key).toBe(ownRemoteProviderKey('mini-a', 'anthropic'));
  });

  it('shows only the group when another computer put providers and shares in a provider group', () => {
    devices.value = [
      { deviceId: 'mini-a', name: "Magi's Mac Mini", platform: 'darwin' },
      { deviceId: 'mini-b', name: 'Studio', platform: 'darwin' },
    ];
    catalogs.value = new Map([
      ['mini-a', {
        providers: [provider('anthropic', {
          group: {
            strategy: 'least',
            members: [
              { kind: 'local' },
              { kind: 'device', agentDeviceId: 'mini-b', providerId: 'anthropic' },
              { kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic' },
            ],
          },
        })],
        loading: false,
        error: null,
      }],
      ['mini-b', { providers: [provider('anthropic'), provider('openai')], loading: false, error: null }],
    ]);
    const { result } = renderHook(() => useOwnRemoteProviderList());
    expect(result.current.entries.map((entry) => [entry.deviceId, entry.provider.id, entry.group?.members.length ?? 0])).toEqual([
      ['mini-a', 'anthropic', 3],
      ['mini-b', 'openai', 0],
    ]);
    expect([...result.current.hiddenShareIds]).toEqual(['s1']);
  });

  it('keeps the group listed when the group computer’s own provider is logged out or paused', () => {
    devices.value = [
      { deviceId: 'mini-a', name: "Magi's Mac Mini", platform: 'darwin' },
      { deviceId: 'mini-b', name: 'Studio', platform: 'darwin' },
    ];
    const group = {
      strategy: 'least',
      members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini-b', providerId: 'anthropic' }],
    };
    for (const state of [{ connected: false }, { suspended: true }]) {
      catalogs.value = new Map([
        ['mini-a', { providers: [provider('anthropic', { ...state, group })], loading: false, error: null }],
        ['mini-b', { providers: [provider('anthropic')], loading: false, error: null }],
      ]);
      const { result, unmount } = renderHook(() => useOwnRemoteProviderList());
      expect(result.current.entries.map((entry) => [entry.deviceId, entry.provider.id, entry.group?.members.length ?? 0])).toEqual([
        ['mini-a', 'anthropic', 2],
      ]);
      unmount();
    }
  });
});

describe('OwnRemoteProviderRows / OwnRemoteProviderDetail', () => {
  const entry: OwnRemoteProvider = {
    key: ownRemoteProviderKey('mini-a', 'anthropic'),
    deviceId: 'mini-a',
    deviceName: "Magi's Mac Mini",
    provider: provider('anthropic') as unknown as OwnRemoteProvider['provider'],
    modelVisibilityOverrides: { 'claude-code:anthropic:hidden': false },
  };

  it('renders nothing without remote providers', () => {
    const { container } = render(<OwnRemoteProviderRows entries={[]} selectedKey={null} onSelect={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('marks the row as remote, names the computer only in the tip and selects it', () => {
    const onSelect = vi.fn();
    render(<OwnRemoteProviderRows entries={[entry]} selectedKey={null} onSelect={onSelect} />);
    const row = screen.getByTestId('own-remote-provider-row');
    expect(row.textContent).toContain('Anthropic');
    expect(row.textContent).not.toContain("Magi's Mac Mini");
    expect(row.getAttribute('aria-label')).toContain("Magi's Mac Mini");
    expect(row.textContent).toContain('settings.providers.models.modelCount:{"count":1}');
    expect(row.querySelector('[data-remote-source-mark]')).not.toBeNull();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(entry.key);
  });

  it('shows the models that computer leaves visible, read-only', () => {
    render(<OwnRemoteProviderDetail entry={entry} />);
    const list = screen.getByTestId('own-remote-provider-models');
    expect(Array.from(list.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['Opus 5.5']);
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
