import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE, MAKER_PUSH, MAKER_SEND } from '../channels.js';

/**
 * 「电脑使用」10 个通道的注册行为（不是源码文本断言）。
 *
 * 客户端模式跳过 `registerMakerIpc`，所以这 10 个通道搬进了 `registerComputerUseIpc`：内嵌模式在
 * 原位置调用它，客户端模式由 bootstrap 在 splash 之后调用。两边都在无法整体导入的大文件里，这里
 * 沿用仓库既有的「切源码 + 编译 + new Function 注入依赖」手法真实执行，用假的 ipcMain 记录注册。
 */
const registerSource = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bootstrapSource = readFileSync(new URL('../../bootstrap-electron.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function slice(source: string, from: string, through: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(through, start);
  if (start < 0 || end < 0) throw new Error(`slice anchor missing: ${start < 0 ? from : through}`);
  return source.slice(start, end + through.length);
}

function compile<T>(code: string, bindings: Record<string, unknown>): T {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as T;
}

function createFakeIpcMain(order: string[]) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      order.push(`handle ${channel}`);
      handlers.set(channel, fn);
    }),
    on: vi.fn((channel: string) => {
      order.push(`on ${channel}`);
    }),
  };
}

/** Order before the move, read off the original `registerMakerIpc` block. */
const COMPUTER_USE_REGISTRATIONS = [
  'handle maker:computer:status',
  'handle maker:computer:install-driver',
  'handle maker:computer:grant-permissions',
  'handle maker:computer:driver-icon',
  'handle maker:computer:permission-guide-status',
  'on maker:computer:permission-app-drag-start',
  'handle maker:computer:permission-app-drag-end',
  'handle maker:computer:cancel-permission-grant',
  'handle maker:computer:check-update',
  'handle maker:computer:update-driver',
];

function loadRegisterComputerUseIpc(ipcMain: ReturnType<typeof createFakeIpcMain>, deps: Record<string, unknown> = {}) {
  const fnSource = slice(registerSource, 'export function registerComputerUseIpc(): void {', '\n}\n')
    .replace(/^export /, '');
  const stub = () => vi.fn();
  return compile<() => void>(`${fnSource}\nreturn registerComputerUseIpc;`, {
    ipcMain,
    MAKER_INVOKE,
    MAKER_SEND,
    MAKER_PUSH,
    BrowserWindow: { fromWebContents: stub(), getAllWindows: () => [] },
    throwIpcError: (code: string, message: string) => { throw new Error(`[${code}] ${message}`); },
    assertTrustedAppRendererEvent: stub(),
    readComputerStatusForSettings: stub(),
    getComputerDriverStatus: stub(),
    refreshComputerPermissionGuideWindow: stub(),
    installComputerDriver: stub(),
    parseComputerPermissionGrantRequest: stub(),
    shouldUseComputerPermissionGuide: stub(),
    getComputerDriverAppBundlePath: stub(),
    seedOpenedPermissionPane: stub(),
    openComputerPermissionPaneForStatus: stub(),
    pauseComputerDriverPermissionProbe: stub(),
    showComputerPermissionGuideWindow: stub(),
    grantComputerDriverPermissions: stub(),
    closeComputerPermissionGuideWindow: stub(),
    getComputerDriverAppIcon: stub(),
    getComputerPermissionGuideStatus: stub(),
    startComputerPermissionAppDrag: stub(),
    finishComputerPermissionAppDrag: stub(),
    isComputerPermissionGuideWebContents: stub(),
    cancelComputerDriverPermissionGrant: stub(),
    checkComputerDriverUpdate: stub(),
    updateComputerDriver: stub(),
    ...deps,
  });
}

describe('computer-use IPC registration', () => {
  it('registers exactly the ten Computer Use channels, in their original order, with the same handlers', async () => {
    const order: string[] = [];
    const ipcMain = createFakeIpcMain(order);
    const readComputerStatusForSettings = vi.fn(async () => ({ installed: true }));
    const getComputerDriverStatus = vi.fn();
    const refreshComputerPermissionGuideWindow = vi.fn();
    loadRegisterComputerUseIpc(ipcMain, {
      readComputerStatusForSettings,
      getComputerDriverStatus,
      refreshComputerPermissionGuideWindow,
    })();

    expect(order).toEqual(COMPUTER_USE_REGISTRATIONS);
    // The status handler is the moved one: it still reads through the settings helper with the driver deps.
    await expect(ipcMain.handlers.get('maker:computer:status')?.({}, { force: true })).resolves.toEqual({ installed: true });
    expect(readComputerStatusForSettings).toHaveBeenCalledWith({ force: true }, {
      getStatus: getComputerDriverStatus,
      refreshPermissionGuide: refreshComputerPermissionGuideWindow,
    });
  });

  it('embedded mode keeps the tail of registerMakerIpc in the same order', () => {
    const order: string[] = [];
    const ipcMain = createFakeIpcMain(order);
    const registerComputerUseIpc = loadRegisterComputerUseIpc(ipcMain);
    const tail = slice(
      registerSource,
      '  // ── Android automation (Settings',
      "  log.info('maker:* IPC handlers registered');",
    );
    compile<() => void>(`return () => {\n${tail}\n};`, {
      ipcMain,
      MAKER_INVOKE,
      registerComputerUseIpc,
      registerAndroidAutomationHandlers: () => order.push('android automation handlers'),
      createElectronIpcHandlerRegistry: () => ({}),
      getBrowserAvailability: vi.fn(),
      openBrowserForLogin: vi.fn(),
      isBrowserOpenForLoginError: vi.fn(),
      throwIpcError: vi.fn(),
      log: { info: (message: string) => order.push(`log ${message}`), warn: vi.fn() },
    })();

    expect(order).toEqual([
      'android automation handlers',
      'handle maker:browser:status',
      'handle maker:browser:open-for-login',
      ...COMPUTER_USE_REGISTRATIONS,
      'log maker:* IPC handlers registered',
    ]);
  });

  it('client mode registers only the Computer Use channels after splash and never throws out of startup', () => {
    const branch = slice(
      bootstrapSource,
      '    if (hostClientMode) {\n      makerIpcsRegistered = true;',
      '      return;\n    }\n',
    );
    // The branch ends in `return;`, so reaching the code after it means the desktop runtime would be assembled.
    const run = (registerComputerUseIpc: () => void, consoleError = vi.fn()) =>
      compile<() => { runtimeAssembled: boolean; registered: boolean }>(
        `return () => {\n  let makerIpcsRegistered = false;\n  const runtimeAssembled = (() => {\n${branch}\n    return true;\n  })() === true;\n  return { runtimeAssembled, registered: makerIpcsRegistered };\n};`,
        { hostClientMode: true, registerComputerUseIpc, console: { error: consoleError } },
      )();

    const register = vi.fn();
    expect(run(register)).toEqual({ runtimeAssembled: false, registered: true });
    expect(register).toHaveBeenCalledTimes(1);

    const consoleError = vi.fn();
    const failing = vi.fn(() => { throw new Error('Attempted to register a second handler'); });
    expect(run(failing, consoleError)).toEqual({ runtimeAssembled: false, registered: true });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
