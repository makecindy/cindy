// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Bucket = {
  tabs: Array<{ id: string; kind: string; state: unknown }>;
  activeTabId: string | null;
};

let bucket: Bucket = { tabs: [], activeTabId: null };
let focusListener:
  ((request: { sessionId: string; instanceId?: string; userInitiated?: boolean }) => void) | null =
  null;
let installedGhosts: Array<{
  enabled: boolean;
  manifest: { id: string; slots: string[] };
}> = [];

vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => false }));
vi.mock('../../store', () => ({
  addTab: vi.fn(async () => ({ id: 'new-tab', kind: 'ios-simulator', state: null })),
  ensureHydrated: vi.fn(async () => undefined),
  getBucket: vi.fn(() => bucket),
  patchTabState: vi.fn(async () => undefined),
  setActiveTab: vi.fn(async () => undefined),
}));
vi.mock('../sidebarCommands', () => ({ requestRightSidebarVisibility: vi.fn() }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  readInstalledGhostsSnapshot: () => installedGhosts,
}));

import { addTab, ensureHydrated, patchTabState, setActiveTab } from '../../store';
import {
  _resetIOSSimulatorFocusBridgeForTests,
  focusIOSSimulatorPanel,
  initIOSSimulatorFocusBridge,
} from '../iosSimulatorFocusBridge';
import { requestRightSidebarVisibility } from '../sidebarCommands';

describe('iOS Simulator focus bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIOSSimulatorFocusBridgeForTests();
    bucket = { tabs: [], activeTabId: null };
    installedGhosts = [
      {
        enabled: true,
        manifest: { id: 'ios-simulator', slots: ['ios-simulator'] },
      },
    ];
    focusListener = null;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          iosSimulator: {
            onFocusRequest(callback: typeof focusListener) {
              focusListener = callback;
              return () => {
                focusListener = null;
              };
            },
          },
        },
      },
    });
  });

  it('ignores focus requests while the product plugin is absent or disabled', async () => {
    installedGhosts = [];
    initIOSSimulatorFocusBridge();
    focusListener?.({ sessionId: 'session-a', instanceId: 'instance-a' });
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureHydrated).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).not.toHaveBeenCalled();

    installedGhosts = [
      {
        enabled: false,
        manifest: { id: 'ios-simulator', slots: ['ios-simulator'] },
      },
    ];
    focusListener?.({ sessionId: 'session-a', instanceId: 'instance-a' });
    await Promise.resolve();
    await Promise.resolve();
    expect(ensureHydrated).not.toHaveBeenCalled();
  });

  it('creates and reveals a simulator tab for the launched instance', async () => {
    initIOSSimulatorFocusBridge();
    focusListener?.({ sessionId: 'session-a', instanceId: 'instance-a' });

    await vi.waitFor(() => {
      expect(addTab).toHaveBeenCalledWith('session-a', 'ios-simulator', {
        instanceId: 'instance-a',
      });
    });
    expect(ensureHydrated).toHaveBeenCalledWith('session-a');
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'session-a',
      userInitiated: true,
    });
  });

  it('creates an unbound simulator tab for a Host capability launcher', async () => {
    initIOSSimulatorFocusBridge();
    focusListener?.({ sessionId: 'session-a', userInitiated: false });

    await vi.waitFor(() => {
      expect(addTab).toHaveBeenCalledWith('session-a', 'ios-simulator', {});
    });
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'session-a',
      userInitiated: false,
    });
  });

  it('direct plugin entry shares the same Host viewer path', async () => {
    await focusIOSSimulatorPanel({ sessionId: 'session-a', userInitiated: true });

    expect(addTab).toHaveBeenCalledWith('session-a', 'ios-simulator', {});
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'session-a',
      userInitiated: true,
    });
  });

  it('reuses an existing simulator tab and routes it to the launched instance', async () => {
    bucket = {
      tabs: [{ id: 'sim-tab', kind: 'ios-simulator', state: { instanceId: 'old-instance' } }],
      activeTabId: 'other-tab',
    };
    initIOSSimulatorFocusBridge();
    focusListener?.({ sessionId: 'session-a', instanceId: 'instance-a' });

    await vi.waitFor(() => expect(setActiveTab).toHaveBeenCalledWith('session-a', 'sim-tab'));
    expect(patchTabState).toHaveBeenCalledWith('session-a', 'sim-tab', expect.any(Function));
    expect(addTab).not.toHaveBeenCalled();
  });
});
