import { describe, expect, it, vi } from 'vitest';

import {
  listAtBrowserTabs,
  parseAtContextCatalogRequest,
  readAtDesktopWindows,
  resolveAtBrowserTabSessionId,
} from '../atContextCatalog.js';

describe('at context catalog', () => {
  it('only resolves browser tabs when the renderer request matches Main active scope', () => {
    expect(resolveAtBrowserTabSessionId('session-1', 'session-1')).toBe('session-1');
    expect(resolveAtBrowserTabSessionId('session-1', 'session-2')).toBeUndefined();
    expect(resolveAtBrowserTabSessionId('session-1', null)).toBeUndefined();
    expect(resolveAtBrowserTabSessionId(undefined, 'session-1')).toBeUndefined();
  });

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

  it('falls back to the application name instead of exposing a broken window title', () => {
    expect(readAtDesktopWindows({
      windows: [{ window_id: 7, pid: 17, app_name: 'chrome.exe', title: 'Issue ���' }],
    }, 'chrome', 10, 10)).toEqual([{
      windowId: 7,
      pid: 17,
      appName: 'chrome.exe',
      title: 'chrome.exe',
    }]);
  });

  it('hides Cindy, minimized and off-screen windows and de-duplicates stable ids', () => {
    expect(readAtDesktopWindows({
      windows: [
        { window_id: 1, pid: 11, app_name: 'Cindy.exe', title: 'Cindy' },
        { window_id: 2, pid: 12, app_name: 'electron.exe', title: 'CindyDev' },
        { window_id: 3, pid: 13, app_name: 'chrome.exe', title: 'Minimized', is_minimized: true },
        { window_id: 4, pid: 14, app_name: 'Code.exe', title: 'Off screen', is_on_screen: false },
        { window_id: 5, pid: 15, app_name: 'WindowsTerminal.exe', title: 'PowerShell' },
        { window_id: 5, pid: 15, app_name: 'WindowsTerminal.exe', title: 'Duplicate' },
      ],
    }, '', 10, 10)).toEqual([{
      windowId: 5,
      pid: 15,
      appName: 'WindowsTerminal.exe',
      title: 'PowerShell',
    }]);
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
