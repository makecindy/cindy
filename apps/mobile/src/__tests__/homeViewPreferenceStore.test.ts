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

const defaultPrefs = {
  groupByProject: true,
  groupDialogue: false,
  selectedDevice: null,
  sortBy: 'recency',
  statusFilter: 'active',
  projectOrder: 'activity',
  manualProjectOrder: [],
} as const;

describe('homeViewPreferenceStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store.clear();
    const { clearHomeViewPreferences } = await import('@/session/homeViewPreferenceStore');
    await clearHomeViewPreferences();
    store.clear();
  });

  it('stores the selected device filter and display-menu toggles', async () => {
    const {
      __testing,
      readHomeViewPreferences,
      saveHomeViewPreferences,
    } = await import('@/session/homeViewPreferenceStore');

    await saveHomeViewPreferences({
      selectedDevice: { deviceId: 'devA', name: 'Mac A' },
    });
    await saveHomeViewPreferences({
      groupByProject: true,
      groupDialogue: true,
      sortBy: 'priority',
      statusFilter: 'archived',
      projectOrder: 'custom',
      manualProjectOrder: ['proj-b', 'proj-a'],
    });

    await expect(readHomeViewPreferences()).resolves.toEqual({
      groupByProject: true,
      groupDialogue: true,
      selectedDevice: { deviceId: 'devA', name: 'Mac A' },
      sortBy: 'priority',
      statusFilter: 'archived',
      projectOrder: 'custom',
      manualProjectOrder: ['proj-b', 'proj-a'],
    });
    expect(JSON.parse(store.get(__testing.storageKey) ?? '{}')).toEqual({
      groupByProject: true,
      groupDialogue: true,
      sortBy: 'priority',
      statusFilter: 'archived',
      projectOrder: 'custom',
      manualProjectOrder: ['proj-b', 'proj-a'],
      deviceId: 'devA',
      deviceName: 'Mac A',
    });
  });

  it('treats explicit null selectedDevice as switching back to all sessions', async () => {
    const { readHomeViewPreferences, saveHomeViewPreferences } =
      await import('@/session/homeViewPreferenceStore');

    await saveHomeViewPreferences({
      groupByProject: true,
      selectedDevice: { deviceId: 'devA', name: 'Mac A' },
    });
    await saveHomeViewPreferences({ selectedDevice: null });

    await expect(readHomeViewPreferences()).resolves.toEqual({
      ...defaultPrefs,
      selectedDevice: null,
    });
  });

  it('serializes concurrent saves so neither patch overwrites the other', async () => {
    const { readHomeViewPreferences, saveHomeViewPreferences } =
      await import('@/session/homeViewPreferenceStore');

    // 不 await 第一个写入,直接并发触发第二个:未串行化时两者读到同一份旧快照,后写覆盖先写。
    await Promise.all([
      saveHomeViewPreferences({ selectedDevice: { deviceId: 'devA', name: 'Mac A' } }),
      saveHomeViewPreferences({ groupByProject: true }),
    ]);

    await expect(readHomeViewPreferences()).resolves.toEqual({
      ...defaultPrefs,
      selectedDevice: { deviceId: 'devA', name: 'Mac A' },
    });
  });

  it('keeps old-blob defaults: project on, dialogue group off, time sort, active', async () => {
    const { __testing, readHomeViewPreferences } =
      await import('@/session/homeViewPreferenceStore');

    store.set(__testing.storageKey, JSON.stringify({
      groupByProject: 'yes',
      deviceId: '  devB  ',
      deviceName: '',
    }));

    await expect(readHomeViewPreferences()).resolves.toEqual({
      ...defaultPrefs,
      selectedDevice: { deviceId: 'devB', name: 'devB' },
    });

    store.set(__testing.storageKey, 'not-json');
    await expect(readHomeViewPreferences()).resolves.toEqual({ ...defaultPrefs });
  });
});
