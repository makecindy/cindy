import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  },
}));

const {
  defaultOrcaWorkerCreationPrefs,
  hasLoadedOrcaWorkerCreationPrefs,
  readOrcaWorkerCreationPrefs,
  rememberOrcaWorkerChoice,
  resetOrcaWorkerCreationPrefsMemory,
  sanitizeOrcaWorkerCreationPrefs,
  saveOrcaWorkerCreationPrefs,
} = await import('@/session/orcaWorkerPrefs');

beforeEach(() => {
  storage.clear();
  resetOrcaWorkerCreationPrefsMemory();
});

describe('Worker creation preferences', () => {
  it('starts from the same first-time defaults as the desktop create panel', () => {
    expect(defaultOrcaWorkerCreationPrefs()).toEqual({
      lastAgent: 'codex',
      agents: {
        codex: { model: 'codex/gpt-5.5', effort: 'high', fast: false },
        'claude-code': { model: 'claude-opus-4-7', effort: 'high', fast: false },
        pi: { model: 'claude-sonnet-4-6', effort: 'high', fast: false },
      },
      workerPermissionMode: 'bypassPermissions',
    });
  });

  it('falls back field by field for damaged memory', () => {
    const prefs = sanitizeOrcaWorkerCreationPrefs({
      lastAgent: 'nope',
      agents: { pi: { model: 'my-model', effort: '', fast: 'yes' } },
      workerPermissionMode: 'auto',
    });
    expect(prefs.lastAgent).toBe('codex');
    expect(prefs.agents.pi).toEqual({ model: 'my-model', effort: 'high', fast: false });
    expect(prefs.agents.codex.model).toBe('codex/gpt-5.5');
    expect(prefs.workerPermissionMode).toBe('auto');
  });

  it('persists per account and reads the saved choice back', async () => {
    const next = { ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'pi' as const, workerPermissionMode: 'auto' as const };
    saveOrcaWorkerCreationPrefs('user-1', next);
    await Promise.resolve();
    resetOrcaWorkerCreationPrefsMemory();
    await expect(readOrcaWorkerCreationPrefs('user-1')).resolves.toEqual(next);
    await expect(readOrcaWorkerCreationPrefs('user-2')).resolves.toEqual(defaultOrcaWorkerCreationPrefs());
  });

  it('keeps a choice saved while an older read was still in flight', async () => {
    storage.set('cindy:orcaWorkerCreationPrefs:v1:user-1', JSON.stringify({
      ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'bypassPermissions',
    }));
    const pending = readOrcaWorkerCreationPrefs('user-1');
    const next = { ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'pi' as const, workerPermissionMode: 'auto' as const };
    saveOrcaWorkerCreationPrefs('user-1', next);
    await expect(pending).resolves.toEqual(next);
    await expect(readOrcaWorkerCreationPrefs('user-1')).resolves.toEqual(next);
  });

  it('does not cache defaults when the stored preferences cannot be read', async () => {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    storage.set('cindy:orcaWorkerCreationPrefs:v1:user-1', JSON.stringify({
      ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'auto',
    }));
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('disk busy'));
    await expect(readOrcaWorkerCreationPrefs('user-1')).resolves.toEqual(defaultOrcaWorkerCreationPrefs());
    expect(hasLoadedOrcaWorkerCreationPrefs('user-1')).toBe(false);
    // 下次打开再读,拿到的是真正存过的选择。
    await expect(readOrcaWorkerCreationPrefs('user-1')).resolves.toMatchObject({ workerPermissionMode: 'auto' });
    expect(hasLoadedOrcaWorkerCreationPrefs('user-1')).toBe(true);
  });

  it('persists a choice submitted before the stored preferences finished loading', async () => {
    storage.set('cindy:orcaWorkerCreationPrefs:v1:user-1', JSON.stringify({
      ...defaultOrcaWorkerCreationPrefs(), lastAgent: 'pi',
    }));
    // 预读还在路上时就提交了一次选择。
    const preload = readOrcaWorkerCreationPrefs('user-1');
    const remembered = rememberOrcaWorkerChoice('user-1', {
      agent: 'codex', permissionMode: 'auto', model: { id: 'codex/gpt-5.5', effort: 'low', fast: false },
    });
    await preload;
    await expect(remembered).resolves.toMatchObject({ lastAgent: 'codex', workerPermissionMode: 'auto' });
    await Promise.resolve();
    resetOrcaWorkerCreationPrefsMemory();
    await expect(readOrcaWorkerCreationPrefs('user-1')).resolves.toMatchObject({
      lastAgent: 'codex', workerPermissionMode: 'auto',
    });
  });
});

