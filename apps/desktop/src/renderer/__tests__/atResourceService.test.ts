import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AT_FILE_BROWSER_RESOURCE,
  filterAtFileResources,
  filterAtResources,
  getAtDirectoryCompletionQuery,
  scanAtResources,
  scanPluginAtResources,
} from '@/lib/atResourceService';

function stubApi(options: {
  workspace?: unknown;
  context?: unknown;
  tasks?: unknown;
  deviceTasks?: unknown;
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
        invoke: vi.fn((_deviceId: string, channel: string) => (
          channel === 'local-db:sessions:list'
            ? Promise.resolve(options.deviceTasks)
            : Promise.resolve(options.workspace)
        )),
      },
      localDb: {
        sessions: {
          list: options.taskError
            ? vi.fn().mockRejectedValue(options.taskError)
            : vi.fn().mockResolvedValue(options.tasks),
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

describe('filterAtResources', () => {
  const items = [
    AT_FILE_BROWSER_RESOURCE,
    { type: 'file' as const, name: 'README.md', relPath: 'README.md' },
    { type: 'dir' as const, name: 'apps', relPath: 'apps' },
    { type: 'session' as const, name: 'Release planning', relPath: 'cindy://session/1' },
    { type: 'agent' as const, name: 'reviewer', relPath: '.claude/agents/reviewer.md' },
    { type: 'plugin-provider' as const, name: 'Issues', relPath: 'issues' },
  ];

  it('hides files and directories until the user types a query', () => {
    expect(filterAtResources(items, '').map((item) => item.type)).toEqual([
      'file-browser',
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

describe('filterAtFileResources', () => {
  const workspaceItems = [
    { type: 'file' as const, name: 'README.md', relPath: 'README.md' },
    { type: 'dir' as const, name: 'apps', relPath: 'apps' },
    { type: 'dir' as const, name: 'desktop', relPath: 'apps/desktop' },
    { type: 'file' as const, name: 'package.json', relPath: 'apps/package.json' },
    { type: 'file' as const, name: 'package.json', relPath: 'apps/desktop/package.json' },
    { type: 'session' as const, name: 'Task', relPath: 'cindy://session/1' },
  ];

  it('starts with project root files and directories only', () => {
    expect(filterAtFileResources(workspaceItems, '').map((item) => item.relPath)).toEqual([
      'apps',
      'README.md',
    ]);
  });

  it('searches within a selected directory prefix', () => {
    expect(filterAtFileResources(workspaceItems, 'apps/').map((item) => item.relPath)).toEqual([
      'apps/desktop',
      'apps/package.json',
    ]);
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

describe('scanAtResources context providers', () => {
  it('prepends browser tabs and desktop windows without treating them as files', async () => {
    stubApi({
      workspace: {
        success: true,
        items: [{ type: 'file', name: 'README.md', relPath: 'README.md' }],
      },
      context: {
        success: true,
        browserTabs: [{ tabId: 'tab-1', title: 'Docs', url: 'https://example.com/docs' }],
        desktopWindows: [{
          windowId: 22,
          pid: 11,
          appName: 'Code.exe',
          title: 'Cindy',
        }],
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

  it('lists historical tasks without a workspace and excludes the current task and empty drafts', async () => {
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
          status: 'archived',
          userSendAt: '2026-08-02T00:00:00.000Z',
          summary: 'Plan\nthe release',
          workingDir: 'D:\\repo',
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
