import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseBrowserTabReferenceHref,
  parseDesktopWindowReferenceHref,
} from '@cindy/maker-shared/agent-input-projection';

import {
  AT_FILE_PICKER_RESOURCE,
  createAtResourceFromNativePath,
  filterAtResources,
  getAtDirectoryCompletionQuery,
  mergeAtResourceItems,
  scanAtResources,
  scanPluginAtResources,
} from '@/lib/atResourceService';

function stubApi(options: {
  workspace?: unknown;
  context?: unknown;
  tasks?: unknown;
  taskSearch?: unknown;
  deviceTasks?: unknown;
  deviceTaskSearch?: unknown;
  deviceTaskSearchError?: Error;
  workspaceError?: Error;
  contextError?: Error;
  taskError?: Error;
  pluginProviders?: unknown;
  pluginResources?: unknown;
}) {
  vi.stubGlobal('window', {
    electronAPI: {
      maker: {
        scanAtResources: options.workspaceError
          ? vi.fn().mockRejectedValue(options.workspaceError)
          : vi.fn().mockResolvedValue(options.workspace),
        listAtContext: options.contextError
          ? vi.fn().mockRejectedValue(options.contextError)
          : vi.fn().mockResolvedValue(options.context),
      },
      deviceLink: {
        invoke: vi.fn((_deviceId: string, channel: string) => {
          if (channel === 'local-db:sessions:list') return Promise.resolve(options.deviceTasks);
          if (channel === 'local-db:conversations:search') {
            if (options.deviceTaskSearchError) return Promise.reject(options.deviceTaskSearchError);
            return Promise.resolve(options.deviceTaskSearch);
          }
          return Promise.resolve(options.workspace);
        }),
      },
      localDb: {
        sessions: {
          list: options.taskError
            ? vi.fn().mockRejectedValue(options.taskError)
            : vi.fn().mockResolvedValue(options.tasks),
        },
        conversations: {
          search: options.taskError
            ? vi.fn().mockRejectedValue(options.taskError)
            : vi.fn().mockResolvedValue(options.taskSearch),
        },
      },
      ghosts: {
        listAtResourceProviders: vi.fn().mockResolvedValue(
          options.pluginProviders ?? { items: [] },
        ),
        queryAtResources: vi.fn().mockResolvedValue(
          options.pluginResources ?? { success: true, items: [], truncated: false },
        ),
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('filterAtResources', () => {
  const items = [
    AT_FILE_PICKER_RESOURCE,
    { type: 'file' as const, name: 'README.md', relPath: 'README.md' },
    { type: 'dir' as const, name: 'apps', relPath: 'apps' },
    { type: 'session' as const, name: 'Release planning', relPath: 'cindy://session/1' },
    { type: 'agent' as const, name: 'reviewer', relPath: '.claude/agents/reviewer.md' },
    { type: 'plugin-provider' as const, name: 'Issues', relPath: 'issues' },
  ];

  it('hides files and directories until the user types a query', () => {
    expect(filterAtResources(items, '').map((item) => item.type)).toEqual([
      'file-picker',
      'agent',
      'plugin-provider',
    ]);
  });

  it('keeps each empty-query source compact', () => {
    const providers = Array.from({ length: 5 }, (_, index) => ({
      type: 'plugin-provider' as const,
      name: `Provider ${index}`,
      relPath: `provider-${index}`,
    }));

    expect(filterAtResources(providers, '')).toHaveLength(3);
  });

  it('shows browser tabs immediately but searches desktop windows on demand', () => {
    const contextual = [
      { type: 'browser-tab' as const, name: 'Docs', relPath: 'cindy://browser-tab/tab-1' },
      { type: 'desktop-window' as const, name: 'Editor', relPath: 'cindy://desktop-window/1/2' },
    ];

    expect(filterAtResources(contextual, '').map((item) => item.type)).toEqual([
      'browser-tab',
    ]);
    expect(filterAtResources(contextual, 'editor').map((item) => item.type)).toEqual([
      'desktop-window',
    ]);
  });

  it('searches historical tasks after the user types a query', () => {
    expect(filterAtResources(items, 'release').map((item) => item.type)).toEqual([
      'session',
    ]);
  });

  it('searches files and directories and caps the global result list', () => {
    const files = Array.from({ length: 12 }, (_, index) => ({
      type: 'file' as const,
      name: `file-${index}.ts`,
      relPath: `src/file-${index}.ts`,
    }));
    const results = filterAtResources(files, 'file');

    expect(results).toHaveLength(8);
    expect(results.every((item) => item.type === 'file')).toBe(true);
  });
});

describe('createAtResourceFromNativePath', () => {
  it('stores project files as workdir-relative POSIX paths on Windows', () => {
    expect(createAtResourceFromNativePath(
      'D:\\Repo\\src\\main.ts',
      'file',
      'd:\\repo',
    )).toEqual({
      type: 'file',
      name: 'main.ts',
      relPath: 'src/main.ts',
    });
  });

  it('keeps files outside the workdir as absolute paths', () => {
    expect(createAtResourceFromNativePath(
      'D:\\Downloads\\notes.txt',
      'file',
      'D:\\Repo',
    )).toEqual({
      type: 'file',
      name: 'notes.txt',
      relPath: 'D:\\Downloads\\notes.txt',
    });
  });

  it('creates directory resources selected in the macOS picker', () => {
    expect(createAtResourceFromNativePath('/repo/docs', 'directory', '/repo')).toEqual({
      type: 'dir',
      name: 'docs',
      relPath: 'docs',
    });
  });

  it('rejects an empty picker result', () => {
    expect(createAtResourceFromNativePath('  ', 'file', 'D:\\Repo')).toBeNull();
  });
});

describe('getAtDirectoryCompletionQuery', () => {
  it('turns a directory into a path prefix for continued search', () => {
    expect(getAtDirectoryCompletionQuery({
      type: 'dir',
      name: 'desktop',
      relPath: 'apps/desktop',
    })).toBe('apps/desktop/');
  });

  it('falls back to a mention for directory paths that cannot stay in an @ query', () => {
    expect(getAtDirectoryCompletionQuery({
      type: 'dir',
      name: 'design notes',
      relPath: 'docs/design notes',
    })).toBeNull();
    expect(getAtDirectoryCompletionQuery({
      type: 'dir',
      name: 'design notes',
      relPath: 'docs/design notes',
    }, true)).toBe('docs/design notes/');
  });
});

describe('mergeAtResourceItems', () => {
  it('keeps previous candidates while preferring refreshed duplicates', () => {
    const previous = [
      { type: 'dir' as const, name: 'prompts', relPath: 'packages/prompts' },
      { type: 'file' as const, name: 'profile.ts', relPath: 'src/profile.ts' },
    ];
    const incoming = [
      { type: 'dir' as const, name: 'prompts', relPath: 'packages/prompts', description: 'new' },
      { type: 'session' as const, name: 'PR review', relPath: 'cindy://session/pr-review' },
    ];

    expect(mergeAtResourceItems(previous, incoming)).toEqual([
      incoming[0],
      incoming[1],
      previous[1],
    ]);
  });
});

describe('scanAtResources context providers', () => {
  it('emits workspace results without waiting for slower context providers', async () => {
    const slowContext = deferred<{
      success: boolean;
      browserTabs: never[];
      desktopWindows: never[];
      unavailable: never[];
    }>();
    stubApi({
      workspace: {
        success: true,
        items: [{ type: 'dir', name: 'prompts', relPath: 'packages/prompts' }],
      },
      context: slowContext.promise,
    });
    const partials: Array<{ items: Array<{ type: string; name: string }> }> = [];

    const resultPromise = scanAtResources('D:\\repo', 'codex', 2000, 'pr', undefined, {
      includeLocalContext: true,
      onPartial: (result) => partials.push(result),
    });
    await vi.waitFor(() => {
      expect(partials.some((result) => result.items.some((item) => item.name === 'prompts')))
        .toBe(true);
    });

    slowContext.resolve({
      success: true,
      browserTabs: [],
      desktopWindows: [],
      unavailable: [],
    });
    const result = await resultPromise;
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dir', name: 'prompts' }),
    ]));
  });

  it('prepends browser tabs and desktop windows without treating them as files', async () => {
    stubApi({
      workspace: {
        success: true,
        items: [{ type: 'file', name: 'README.md', relPath: 'README.md' }],
      },
      context: {
        success: true,
        browserTabs: [{ tabId: 'tab-1', title: 'Docs', url: 'https://example.com/docs' }],
        desktopWindows: [
          {
            windowId: 21,
            pid: 10,
            appName: 'chrome.exe',
            title: 'Docs - Google Chrome',
          },
          {
            windowId: 22,
            pid: 11,
            appName: 'Code.exe',
            title: 'Cindy',
          },
        ],
        unavailable: [],
      },
    });

    const result = await scanAtResources('D:\\repo', 'codex', 2000, undefined, undefined, {
      sessionId: 'session-1',
      includeLocalContext: true,
    });

    expect(result.success).toBe(true);
    expect(result.items.map((item) => item.type)).toEqual([
      'browser-tab',
      'desktop-window',
      'file',
    ]);
    expect(result.items[0].relPath).toBe(
      'cindy://browser-tab/tab-1?url=https%3A%2F%2Fexample.com%2Fdocs',
    );
    expect(result.items[1].relPath).toBe(
      'cindy://desktop-window/11/22?app=Code.exe',
    );
  });

  it('strictly encodes Markdown delimiters in context reference links', async () => {
    const tabId = "tab-('!*)";
    const url = "https://example.com/docs_(v1)!'";
    const appName = "Cindy ('!*)";
    stubApi({
      workspace: { success: true, items: [] },
      context: {
        success: true,
        browserTabs: [{ tabId, title: 'Docs', url }],
        desktopWindows: [{ windowId: 22, pid: 11, appName, title: 'Cindy' }],
        unavailable: [],
      },
    });

    const result = await scanAtResources('D:\\repo', 'codex', 2000, undefined, undefined, {
      sessionId: 'session-1',
      includeLocalContext: true,
    });
    const browserTab = result.items.find((item) => item.type === 'browser-tab');
    const desktopWindow = result.items.find((item) => item.type === 'desktop-window');

    expect(browserTab?.relPath).not.toMatch(/[!'()*]/);
    expect(desktopWindow?.relPath).not.toMatch(/[!'()*]/);
    expect(parseBrowserTabReferenceHref(browserTab?.relPath ?? '')).toEqual({ tabId, url });
    expect(parseDesktopWindowReferenceHref(desktopWindow?.relPath ?? '')).toEqual({
      pid: 11,
      windowId: 22,
      appName,
    });
  });

  it('keeps local context when the workspace provider fails', async () => {
    stubApi({
      workspaceError: new Error('workspace unavailable'),
      context: {
        success: true,
        browserTabs: [{ tabId: 'tab-1', title: 'Docs', url: 'https://example.com' }],
        desktopWindows: [],
        unavailable: [],
      },
    });

    const result = await scanAtResources('D:\\repo', 'codex', 2000, undefined, undefined, {
      sessionId: 'session-1',
      includeLocalContext: true,
    });

    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].type).toBe('browser-tab');
  });

  it('keeps workspace resources when the local context provider fails', async () => {
    stubApi({
      workspace: {
        success: true,
        items: [{ type: 'dir', name: 'src', relPath: 'src' }],
      },
      contextError: new Error('context unavailable'),
    });

    const result = await scanAtResources('D:\\repo', 'codex', 2000, undefined, undefined, {
      includeLocalContext: true,
    });

    expect(result.success).toBe(true);
    expect(result.items.map((item) => item.type)).toEqual(['dir']);
  });

  it('lists only active historical tasks without a workspace', async () => {
    stubApi({
      tasks: [
        {
          id: 'current',
          title: 'Current',
          status: 'active',
          userSendAt: '2026-08-03T00:00:00.000Z',
        },
        {
          id: 'history-1',
          title: '  Release\nplanning ',
          status: 'active',
          userSendAt: '2026-08-02T00:00:00.000Z',
          summary: 'Plan\nthe release',
          workingDir: 'D:\\repo',
        },
        {
          id: 'archived-history',
          title: 'Archived release planning',
          status: 'archived',
          userSendAt: '2026-08-01T00:00:00.000Z',
        },
        {
          id: 'empty-draft',
          title: 'Empty',
          status: 'active',
          userSendAt: null,
          _count: { messages: 0 },
        },
      ],
    });

    const result = await scanAtResources('', 'codex', 2000, undefined, undefined, {
      sessionId: 'current',
      includeTaskHistory: true,
    });

    expect(result).toMatchObject({
      success: true,
      items: [
        {
          type: 'session',
          name: 'Release planning',
          relPath: 'cindy://session/history-1',
          description: 'Plan the release',
        },
      ],
    });
    expect(window.electronAPI.localDb.sessions.list).toHaveBeenCalledWith(100, 'active');
  });

  it('lists device-link task history on the controlled device and freezes its device id', async () => {
    stubApi({
      deviceTasks: [{
        id: 'remote-history',
        title: 'Remote task',
        status: 'active',
        userSendAt: '2026-08-03T00:00:00.000Z',
      }],
    });

    const result = await scanAtResources('', 'codex', 2000, undefined, 'device-1', {
      includeTaskHistory: true,
    });

    expect(result.items).toMatchObject([
      {
        type: 'session',
        relPath: 'cindy://session/remote-history?device=device-1',
      },
    ]);
    expect(window.electronAPI.deviceLink.invoke).toHaveBeenCalledWith(
      'device-1',
      'local-db:sessions:list',
      [100, 'active'],
    );
  });

  it('searches all active task history through the indexed conversation search', async () => {
    stubApi({
      taskSearch: {
        query: '未命名',
        results: [{
          session: {
            id: 'older-than-sidebar-cap',
            title: 'New Maker',
            status: 'active',
            workingDir: 'D:\\repo',
          },
          contentHit: null,
        }],
        vectorUsed: false,
        vectorSkipReason: null,
        poolCapped: false,
      },
    });

    const result = await scanAtResources('', 'codex', 2000, '未命名', undefined, {
      includeTaskHistory: true,
      unnamedLabel: '未命名任务',
    });

    expect(result.items).toMatchObject([{
      type: 'session',
      name: '未命名任务',
      relPath: 'cindy://session/older-than-sidebar-cap',
    }]);
    expect(window.electronAPI.localDb.conversations.search).toHaveBeenCalledWith({
      query: '未命名',
      limit: 20,
      sortBy: 'relevance',
      semanticMode: 'keyword',
      filters: { status: 'active' },
      unnamedLabel: '未命名任务',
    });
    expect(window.electronAPI.localDb.sessions.list).not.toHaveBeenCalled();
  });

  it('uses indexed task search on the controlled device', async () => {
    stubApi({
      deviceTaskSearch: {
        query: 'untitled',
        results: [{
          session: {
            id: 'remote-history',
            title: 'New Maker',
            status: 'active',
            workingDir: '/repo',
          },
          contentHit: null,
        }],
        vectorUsed: false,
        vectorSkipReason: null,
        poolCapped: false,
      },
    });

    const result = await scanAtResources('', 'codex', 2000, 'untitled', 'device-1', {
      includeTaskHistory: true,
      unnamedLabel: 'Untitled session',
    });

    expect(result.items).toMatchObject([{
      type: 'session',
      name: 'Untitled session',
      relPath: 'cindy://session/remote-history?device=device-1',
    }]);
    expect(window.electronAPI.deviceLink.invoke).toHaveBeenCalledWith(
      'device-1',
      'local-db:conversations:search',
      [{
        query: 'untitled',
        limit: 20,
        sortBy: 'relevance',
        semanticMode: 'keyword',
        filters: { status: 'active' },
        unnamedLabel: 'Untitled session',
      }],
    );
  });

  it('falls back to the bounded task list for an older controlled device', async () => {
    stubApi({
      deviceTaskSearchError: new Error('CHANNEL_NOT_ALLOWED'),
      deviceTasks: [{
        id: 'legacy-remote-history',
        title: 'Legacy remote task',
        status: 'active',
        userSendAt: '2026-08-03T00:00:00.000Z',
      }],
    });

    const result = await scanAtResources('', 'codex', 2000, 'legacy', 'device-1', {
      includeTaskHistory: true,
    });

    expect(result.items).toMatchObject([{
      type: 'session',
      relPath: 'cindy://session/legacy-remote-history?device=device-1',
    }]);
    expect(window.electronAPI.deviceLink.invoke).toHaveBeenNthCalledWith(
      2,
      'device-1',
      'local-db:sessions:list',
      [100, 'active'],
    );
  });

  it('lists Plugin entries without running them, then searches only the selected provider', async () => {
    stubApi({
      workspace: { success: true, items: [] },
      pluginProviders: {
        items: [{ ghostId: 'issues', name: 'Issue Tracker', description: 'Project issues' }],
      },
      pluginResources: {
        success: true,
        pluginName: 'Issue Tracker',
        items: [{
          id: 'ISSUE-1',
          label: 'Fix login',
          description: 'Open issue',
          href: 'cindy://plugin-resource/issues/search_issues/ISSUE-1',
        }],
        truncated: false,
      },
    });

    const catalog = await scanAtResources(
      'D:\\repo',
      'codex',
      2000,
      undefined,
      undefined,
      { sessionId: 'session-1' },
    );
    expect(catalog.items).toMatchObject([{
      type: 'plugin-provider',
      name: 'Issue Tracker',
      pluginId: 'issues',
    }]);
    expect(window.electronAPI.ghosts.queryAtResources).not.toHaveBeenCalled();

    const searched = await scanPluginAtResources(
      catalog.items[0],
      'login',
      'D:\\repo',
      'session-1',
    );
    expect(window.electronAPI.ghosts.queryAtResources).toHaveBeenCalledWith({
      ghostId: 'issues',
      sessionId: 'session-1',
      workingDir: 'D:\\repo',
      query: 'login',
      limit: 20,
    });
    expect(searched.items).toMatchObject([{
      type: 'plugin-resource',
      name: 'Fix login',
      sourceLabel: 'Issue Tracker',
    }]);
  });
});
