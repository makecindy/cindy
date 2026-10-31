import { describe, expect, it, vi } from 'vitest';

import type { SetupMigrationPlan, SetupMigrationProgress } from '../../../../shared/setupMigration';
import { applyRendererItems, rendererApplyCount } from '../applyRendererItems';
import { getSwallowActivationClickEnabled } from '../../../hooks/useSwallowActivationClickSettings';
import { applyPortableRendererPrefs, readPortableRendererPrefs } from '../rendererPrefs';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

function plan(overrides: Partial<SetupMigrationPlan> = {}): SetupMigrationPlan {
  return {
    planId: 'p',
    source: { deviceId: 'd', name: 'Mac mini', platform: 'darwin' },
    createdAt: 0,
    plugins: [],
    skills: [],
    settings: [],
    rendererPrefs: null,
    providers: [],
    mcpServers: [],
    builtinTools: [],
    access: [],
    secrets: null,
    sshHosts: [],
    checklist: [],
    unavailable: [],
    ...overrides,
  };
}

function api() {
  return {
    isCurrent: vi.fn(() => true),
    createProvider: vi.fn(async () => ({ ok: true })),
    createMcpServer: vi.fn(async () => ({ ok: true })),
    setBuiltinTool: vi.fn(async () => ({})),
    setRemoteControl: vi.fn(async () => ({})),
    setKeepAwake: vi.fn(async () => ({})),
    applyPrefs: vi.fn(() => 1),
  };
}

describe('applyRendererItems', () => {
  it('creates providers and MCP without credentials and only touches selected ready items', async () => {
    const target = plan({
      providers: [
        { key: 'provider:or', state: 'ready', provider: { id: 'or', name: 'OR', auth: 'apiKey', config: { id: 'or', runtimes: {} } } },
        { key: 'provider:local', state: 'unavailable', reason: 'local-only', provider: { id: 'local', name: 'L', auth: 'none', config: { id: 'local' } } },
      ],
      mcpServers: [
        { key: 'mcp:docs', state: 'ready', server: { id: 'docs', name: 'Docs', transport: 'http', url: 'https://m.example.com', headers: { 'X-Team': 'a' }, hasToken: true } },
      ],
      access: [{ key: 'access:remote-control', id: 'remote-control', state: 'ready' }],
    });
    const calls = api();
    const progress: SetupMigrationProgress[] = [];
    const keys = new Set(['provider:or', 'provider:local', 'mcp:docs']);
    expect(rendererApplyCount(target, keys)).toBe(2);
    const result = await applyRendererItems(target, keys, calls, (p) => progress.push(p), { completed: 3, total: 5 });
    expect(calls.createProvider).toHaveBeenCalledWith({ id: 'or', runtimes: {} });
    expect(calls.createMcpServer).toHaveBeenCalledWith({
      id: 'docs',
      name: 'Docs',
      transport: 'http',
      url: 'https://m.example.com',
      headers: { 'X-Team': 'a' },
    });
    // Remote control was not selected, so it stays as it is.
    expect(calls.setRemoteControl).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      { key: 'provider:or', outcome: 'done' },
      { key: 'mcp:docs', outcome: 'done' },
    ]);
    expect(progress.at(-1)).toMatchObject({ completed: 5, total: 5 });
  });

  it('records a failure and continues with the next item', async () => {
    const target = plan({
      builtinTools: [
        { key: 'builtin-tool:browser', id: 'browser', enabled: false, state: 'ready' },
        { key: 'builtin-tool:docs', id: 'docs', enabled: true, state: 'ready' },
      ],
    });
    const calls = api();
    calls.setBuiltinTool.mockRejectedValueOnce(Object.assign(new Error('[PERMISSION_DENIED] no'), { code: 'PERMISSION_DENIED' }));
    const result = await applyRendererItems(target, new Set(['builtin-tool:browser', 'builtin-tool:docs']), calls, () => {}, { completed: 0, total: 2 });
    expect(result.results).toEqual([
      { key: 'builtin-tool:browser', outcome: 'failed', code: 'PERMISSION_DENIED' },
      { key: 'builtin-tool:docs', outcome: 'done' },
    ]);
  });

  it('writes nothing more once the account that previewed the plan is no longer signed in', async () => {
    const target = plan({
      builtinTools: [
        { key: 'builtin-tool:browser', id: 'browser', enabled: false, state: 'ready' },
        { key: 'builtin-tool:docs', id: 'docs', enabled: true, state: 'ready' },
      ],
    });
    const calls = api();
    calls.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    const result = await applyRendererItems(target, new Set(['builtin-tool:browser', 'builtin-tool:docs']), calls, () => {}, { completed: 0, total: 2 });
    expect(calls.setBuiltinTool).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([
      { key: 'builtin-tool:browser', outcome: 'done' },
      { key: 'builtin-tool:docs', outcome: 'failed', code: 'SETUP_PLAN_EXPIRED' },
    ]);
  });

  it('turns on access switches only, and reports whether interface preferences changed', async () => {
    const target = plan({
      access: [
        { key: 'access:remote-control', id: 'remote-control', state: 'ready' },
        { key: 'access:keep-awake', id: 'keep-awake', state: 'ready' },
      ],
      rendererPrefs: { key: 'renderer-prefs', state: 'ready', values: { theme: 'dark' } },
    });
    const calls = api();
    const result = await applyRendererItems(
      target,
      new Set(['access:remote-control', 'access:keep-awake', 'renderer-prefs']),
      calls,
      () => {},
      { completed: 0, total: 3 },
    );
    expect(calls.setRemoteControl).toHaveBeenCalledWith(true);
    expect(calls.setKeepAwake).toHaveBeenCalledWith(true);
    expect(result.prefsChanged).toBe(true);
  });
});

describe('portable renderer preferences', () => {
  it('reads only the whitelist and the signed-in account\'s own prompt', () => {
    const storage = new MemoryStorage();
    storage.setItem('theme', 'dark');
    storage.setItem('language', 'ja');
    storage.setItem('sidebar-collapsed', 'true');
    storage.setItem('experimental.lsp', '1');
    storage.setItem('userPrompt.value.owner-a', 'mine');
    // Another account that once signed in on this computer keeps its prompt here.
    storage.setItem('userPrompt.value.owner-b', 'not mine');
    storage.setItem('userPrompt.value', 'legacy');
    expect(readPortableRendererPrefs(storage, 'owner-a')).toEqual({
      theme: 'dark',
      language: 'ja',
      'experimental.lsp': '1',
      'userPrompt.value.owner-a': 'mine',
    });
    expect(readPortableRendererPrefs(storage, null)).not.toHaveProperty('userPrompt.value.owner-a');
  });

  it('writes only whitelisted values this computer has not set itself', () => {
    const target = new MemoryStorage();
    target.setItem('theme', 'light');
    expect(
      applyPortableRendererPrefs(
        {
          theme: 'dark',
          language: 'ko',
          'cc-agent.sidebar.selectedMachines': 'x',
          'userPrompt.value.owner-a': 'mine',
          'userPrompt.value.owner-b': 'not mine',
        },
        target,
        'owner-a',
      ),
    ).toBe(2);
    expect(target.getItem('theme')).toBe('light');
    expect(target.getItem('language')).toBe('ko');
    expect(target.getItem('userPrompt.value.owner-a')).toBe('mine');
    expect(target.getItem('userPrompt.value.owner-b')).toBeNull();
    expect(target.getItem('cc-agent.sidebar.selectedMachines')).toBeNull();
  });

  it('moves the misclick protection switch that the click handler actually reads', () => {
    // Two-computer acceptance: only the main-side cache file moved, so the switch and
    // Windows click handling stayed off on the new computer.
    const source = new MemoryStorage();
    source.setItem('input.swallowActivationClick', 'true');
    const target = new MemoryStorage();
    expect(applyPortableRendererPrefs(readPortableRendererPrefs(source, null), target, null)).toBe(1);
    vi.stubGlobal('localStorage', target);
    try {
      expect(getSwallowActivationClickEnabled()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
