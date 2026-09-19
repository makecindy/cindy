import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../bootstrap-electron.ts', import.meta.url), 'utf8');
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing source boundary: ${start}`);
  return text.slice(from, to);
}
function compile(text: string, deps: Record<string, unknown>) {
  const js = transpileModule(text, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}

describe('capture background activity is isolated from the chat window', () => {
  it('keeps capture unthrottled without changing the main-window workload policy', () => {
    const capture = readFileSync(new URL('../captureWindow.ts', import.meta.url), 'utf8');
    expect(capture).toContain('backgroundThrottling: false');
    expect(
      between(
        bootstrap,
        'function applyMainWindowBackgroundThrottling',
        'function focusMainWindow',
      ),
    ).not.toContain('isRemoteDesktopVideoActive');
  });
});

describe('remote desktop state polling', () => {
  it('does not probe Windows for routine polls, but checks fresh status on explicit requests', async () => {
    const readWindowsDesktopSupport = vi.fn(async () => 'ready');
    const assertTrustedAppRendererEvent = vi.fn();
    const app = { isPackaged: false };
    let handler: (event: unknown, check?: unknown) => Promise<Record<string, unknown>>;
    compile(
      between(
        source,
        '  ipcMain.handle(DESKTOP_LOCAL.STATE',
        '  ipcMain.handle(DESKTOP_LOCAL.WINDOWS_SUPPORT',
      ),
      {
        ipcMain: {
          handle: (_name: string, callback: typeof handler) => {
            handler = callback;
          },
        },
        DESKTOP_LOCAL: { STATE: 'state' },
        app,
        process: { platform: 'win32' },
        assertTrustedAppRendererEvent,
        readDeviceLinkSettings: () => ({ remoteDesktopEnabled: false }),
        remoteDesktop: { state: null },
        permissions: { guideOpen: false },
        readWindowsDesktopSupport,
        windowsSetup: {
          read: () => ({
            phase: null,
            error: null,
            failedEnabled: null,
            startedAt: null,
            revision: 0,
          }),
        },
        throwIpcError: (code: string) => {
          throw new Error(code);
        },
      },
    );
    for (let poll = 0; poll < 60; poll++) {
      expect(await handler!({}, poll % 2 ? false : undefined)).not.toHaveProperty('windowsSupport');
    }
    expect(readWindowsDesktopSupport).not.toHaveBeenCalled();
    expect(await handler!({}, true)).toMatchObject({
      windowsSupport: 'ready',
      windowsDevelopment: true,
    });
    readWindowsDesktopSupport.mockResolvedValue('missing');
    app.isPackaged = true;
    expect(await handler!({}, true)).toMatchObject({
      windowsSupport: 'missing',
      windowsDevelopment: false,
    });
    expect(readWindowsDesktopSupport).toHaveBeenCalledTimes(2);
    await expect(handler!({}, 'true')).rejects.toThrow('INVALID_PARAMS');
    expect(readWindowsDesktopSupport).toHaveBeenCalledTimes(2);
    expect(assertTrustedAppRendererEvent).toHaveBeenCalledTimes(63);
  });
});
