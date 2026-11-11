import { createXboxGamepadDefaultSettings } from '../../../src/shared/xboxGamepad';
import { WORKLOUDER_CODEX_EMPTY_DEVICE_STATE, createWorkLouderCodexDefaultSettings } from '../../../src/shared/workLouderCodex';

const noop = () => {};

export const useXboxGamepad = () => ({
  state: {
    connectionStatus: 'connected',
    devicePresent: true,
    deviceName: 'Xbox Wireless Controller',
    device: { name: 'Xbox Wireless Controller', category: 'Xbox One', family: 'xbox', transport: 'usb', batteryPercentage: 80, batteryState: 'discharging' },
    settings: createXboxGamepadDefaultSettings(),
  },
  loading: false,
  saving: false,
  error: null,
  setSettings: noop,
  resetSettings: noop,
  reload: noop,
});

export const useWorkLouderCodex = () => ({
  state: {
    connectionStatus: 'connected',
    connectionReason: null,
    devicePresent: true,
    device: { ...WORKLOUDER_CODEX_EMPTY_DEVICE_STATE, deviceType: 'codex-micro', isUsbConnection: true },
    settings: createWorkLouderCodexDefaultSettings('codex-micro'),
    agentSlots: Array.from({ length: 6 }, (_, slot) => ({ slot, sessionId: null, title: null, action: null })),
    taskOptions: [],
    agentSlotCount: 6,
  },
  loading: false,
  saving: false,
  error: null,
  setSettings: noop,
  resetSettings: noop,
  openInputMonitoringSettings: noop,
  reload: noop,
});

export const useCodexMicroGuard = () => ({ state: null, loading: false, saving: false, error: null, setEnabled: noop, recover: noop });

export const useSkillhub = () => ({ skills: [], bootstrapped: true, refresh: noop });
