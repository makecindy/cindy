import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanAtResources } from '@/lib/atResourceService';

function stubApi(options: {
  workspace?: unknown;
  context?: unknown;
  tasks?: unknown;
  deviceTasks?: unknown;
  workspaceError?: Error;
  contextError?: Error;
  taskError?: Error;
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
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
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
});
