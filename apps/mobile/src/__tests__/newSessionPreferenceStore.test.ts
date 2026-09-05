import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

describe('newSessionPreferenceStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store.clear();
    const { clearNewSessionPreferences } = await import('@/session/newSessionPreferenceStore');
    await clearNewSessionPreferences();
    store.clear();
  });

  it('persists grok-build as the last selected new-session harness', async () => {
    const { readNewSessionPreferences, saveNewSessionPreferences } = await import(
      '@/session/newSessionPreferenceStore'
    );

    await saveNewSessionPreferences({ agentKind: 'grok-build' });
    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: 'grok-build',
      device: null,
      permissionModeByAgent: {},
    });
  });

  it('stores the last selected device and agent for new sessions', async () => {
    const {
      __testing,
      readNewSessionPreferences,
      saveNewSessionPreferences,
    } = await import('@/session/newSessionPreferenceStore');

    await saveNewSessionPreferences({
      device: { deviceId: 'devA', name: 'Mac A' },
    });
    await saveNewSessionPreferences({ agentKind: 'codex' });

    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: 'codex',
      device: { deviceId: 'devA', name: 'Mac A' },
      permissionModeByAgent: {},
    });
    expect(JSON.parse(store.get(__testing.storageKey) ?? '{}')).toEqual({
      agentKind: 'codex',
      deviceId: 'devA',
      deviceName: 'Mac A',
    });
  });

  it('normalizes invalid or stale persisted data without blocking the page', async () => {
    const {
      __testing,
      readNewSessionPreferences,
      saveNewSessionPreferences,
    } = await import('@/session/newSessionPreferenceStore');

    store.set(__testing.storageKey, JSON.stringify({
      agentKind: 'unknown',
      deviceId: '  devB  ',
      deviceName: '',
    }));

    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: { deviceId: 'devB', name: 'devB' },
      permissionModeByAgent: {},
    });

    store.set(__testing.storageKey, '{broken');
    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: null,
      permissionModeByAgent: {},
    });

    await saveNewSessionPreferences({
      device: { deviceId: '  devC  ', name: '  ' },
    });
    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: { deviceId: 'devC', name: 'devC' },
      permissionModeByAgent: {},
    });
  });

  it('remembers per-agent permission modes and drops plan / stale entries', async () => {
    const {
      __testing,
      readNewSessionPreferences,
      saveNewSessionPreferences,
    } = await import('@/session/newSessionPreferenceStore');

    await saveNewSessionPreferences({
      permissionModeForAgent: { agentKind: 'claude-code', mode: 'bypassPermissions' },
    });
    await saveNewSessionPreferences({
      permissionModeForAgent: { agentKind: 'codex', mode: 'ask' },
    });
    // plan 是计划模式实现细节,不入记忆(忽略而非报错)。
    await saveNewSessionPreferences({
      permissionModeForAgent: { agentKind: 'claude-code', mode: 'plan' },
    });

    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: null,
      permissionModeByAgent: { 'claude-code': 'bypassPermissions', codex: 'ask' },
    });

    // 落盘的 plan / 非法 agent 键在读取时被清洗。
    store.set(__testing.storageKey, JSON.stringify({
      permissionModeByAgent: { 'claude-code': 'plan', codex: 'auto', other: 'ask' },
    }));
    await expect(readNewSessionPreferences()).resolves.toEqual({
      agentKind: null,
      device: null,
      permissionModeByAgent: { codex: 'auto' },
    });
  });
});
