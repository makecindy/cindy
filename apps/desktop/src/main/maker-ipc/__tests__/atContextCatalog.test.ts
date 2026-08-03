import { describe, expect, it, vi } from 'vitest';

import {
  listAtBrowserTabs,
  parseAtContextCatalogRequest,
  readAtDesktopWindows,
} from '../atContextCatalog.js';

describe('at context catalog', () => {
  it('reads only live public browser tabs from the requested task', () => {
    const registry = {
      listBySession: vi.fn(() => [
        { sessionId: 'session-1', tabId: 'tab-1', webContentsId: 1 },
        { sessionId: 'session-1', tabId: 'tab-2', webContentsId: 2 },
      ]),
      getWebContentsByTabId: vi.fn((tabId: string) => tabId === 'tab-1'
        ? {
            getURL: () => 'https://user:secret@example.com/docs?token=private#section',
            getTitle: () => '  Docs\nHome ',
          }
        : { getURL: () => 'file:///secret', getTitle: () => 'Secret' }),
    };

    expect(listAtBrowserTabs(registry as never, 'session-1', 'docs', 10)).toEqual([
      {
        tabId: 'tab-1',
        title: 'Docs Home',
        url: 'https://example.com/docs',
      },
    ]);
  });

  it('sanitizes, filters and caps desktop windows', () => {
    const raw = {
      windows: [
        { window_id: 1, pid: 10, app_name: 'Code.exe', title: ' Cindy ' },
        { window_id: 2, pid: 11, app_name: 'Terminal.exe', title: 'PowerShell\nProject' },
        { window_id: 3, pid: 12, app_name: 'Hidden.exe', title: 'Hidden', is_visible: false },
        { window_id: 'bad', pid: 13, app_name: 'Bad.exe', title: 'Bad' },
      ],
    };

    expect(readAtDesktopWindows(raw, 'project', 1, 10)).toEqual([
      {
        windowId: 2,
        pid: 11,
        appName: 'Terminal.exe',
        title: 'PowerShell Project',
      },
    ]);
  });

  it('rejects malformed requests and bounds optional text', () => {
    expect(parseAtContextCatalogRequest(null)).toBeNull();
    expect(parseAtContextCatalogRequest({ limit: 0 })).toBeNull();
    expect(parseAtContextCatalogRequest({
      sessionId: ' session-1 ',
      workingDir: ' D:\\repo ',
      query: 'x'.repeat(300),
      limit: 25,
    })).toEqual({
      sessionId: 'session-1',
      workingDir: 'D:\\repo',
      query: 'x'.repeat(200),
      limit: 25,
    });
  });
});
