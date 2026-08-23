/**
 * deepLink: argv 解析 + URL 解析 + 新增的 --open-folder 解析单测。
 *
 * 只覆盖 pure function:dispatch / pending buffer 依赖 Electron app + BrowserWindow,
 * 端到端"点链接 / 右键唤起"需要 packaged build 手验,本单测不涵盖。
 */

import { describe, it, expect } from 'vitest';
import { app, type BrowserWindow } from 'electron';

// vitest 跑测试时不会真的初始化 Electron app, 单 import 需要 mock electron。
// deepLink.ts 只在 registerDeepLinkProtocol / dispatchDeepLink 用到 app /
// BrowserWindow, 本单测只测 pure parse function 不会触达,给个最小 mock 满足 import。
vi.mock('electron', () => ({
  app: { focus: vi.fn(), setAsDefaultProtocolClient: () => {} },
  BrowserWindow: class {},
}));

// logger 依赖 electron-log + app path, 在测试里要么 mock 要么吞日志。给个 noop logger。
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { vi } from 'vitest';
import {
  parseDeepLink,
  buildFocusDeepLink,
  buildProjectDeepLink,
  buildSessionDeepLink,
  buildSessionMessageDeepLink,
  findDeepLinkInArgv,
  findOpenFolderInArgv,
  findOpenShareFileInArgv,
  DEEP_LINK_PROTOCOL,
  OPEN_FOLDER_FLAG,
  OPEN_SHARE_FILE_FLAG,
  focusMainWindow,
  openMainWindowVoiceSettings,
  setDeepLinkMainWindow,
} from '../deepLink';

describe('user-initiated main-window focus', () => {
  it('activates and raises the target window before focusing on Windows', () => {
    const calls: string[] = [];
    const mainWindow = {
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => true,
      show: vi.fn(() => calls.push('show')),
      restore: vi.fn(() => calls.push('restore')),
      moveTop: vi.fn(() => calls.push('moveTop')),
      focus: vi.fn(() => calls.push('window.focus')),
    };
    vi.mocked(app.focus).mockImplementation(() => calls.push('app.focus'));
    setDeepLinkMainWindow(mainWindow as unknown as BrowserWindow);

    expect(focusMainWindow('win32')).toBe(true);

    expect(calls).toEqual(['show', 'restore', 'app.focus', 'moveTop', 'window.focus']);
    setDeepLinkMainWindow(null);
  });
});

describe('internal main-window navigation', () => {
  it('focuses the main window and routes voice settings to the requested tab', () => {
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => true,
      show: vi.fn(),
      restore: vi.fn(),
      moveTop: vi.fn(),
      focus: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      webContents: {
        isLoading: () => false,
        send,
      },
    };
    setDeepLinkMainWindow(mainWindow as unknown as BrowserWindow);

    openMainWindowVoiceSettings('providers');

    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(mainWindow.restore).toHaveBeenCalledOnce();
    expect(mainWindow.focus).toHaveBeenCalledOnce();
    if (process.platform === 'win32') {
      expect(mainWindow.moveTop).toHaveBeenCalledOnce();
      expect(mainWindow.setAlwaysOnTop).not.toHaveBeenCalled();
    } else {
      expect(mainWindow.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true);
      expect(mainWindow.setAlwaysOnTop).toHaveBeenNthCalledWith(2, false);
    }
    expect(send).toHaveBeenCalledWith('deep-link:navigate', {
      type: 'settings',
      tab: 'providers',
    });
    setDeepLinkMainWindow(null);
  });
});

describe('parseDeepLink', () => {
  it('parses session payload', () => {
    expect(parseDeepLink('xdt-maker://session/abc-123')).toEqual({
      type: 'session',
      id: 'abc-123',
    });
  });

  it('parses project payload with URL-encoded workingDir', () => {
    const encoded = encodeURIComponent('C:\\Some Path\\proj');
    expect(parseDeepLink(`xdt-maker://project/${encoded}`)).toEqual({
      type: 'project',
      workingDir: 'C:\\Some Path\\proj',
    });
  });

  it('builds project links with RFC 3986 strict encoding and round-trips (review P2)', () => {
    // encodeURIComponent 放行 `!'()*`,含裸括号 / 引号的链接会被粘贴 /
    // linkify 的文本白名单拒绝或截断——builder 必须把这五个字符也转 %XX。
    const link = buildProjectDeepLink("/tmp/foo (copy)'s*!");
    expect(link).not.toMatch(/[!'()*]/);
    expect(parseDeepLink(link)).toEqual({
      type: 'project',
      workingDir: "/tmp/foo (copy)'s*!",
    });
  });

  it('returns null for non-xdt-maker schemes', () => {
    expect(parseDeepLink('https://example.com')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(parseDeepLink('xdt-maker://unknown/x')).toBeNull();
  });

  it('returns null when value is empty', () => {
    expect(parseDeepLink('xdt-maker://session/')).toBeNull();
  });

  it('parses session payload with message anchor', () => {
    expect(parseDeepLink('xdt-maker://session/abc-123?message=client-9')).toEqual({
      type: 'session',
      id: 'abc-123',
      messageClientId: 'client-9',
    });
    expect(parseDeepLink(buildSessionMessageDeepLink('abc-123', 'client/9'))).toEqual({
      type: 'session',
      id: 'abc-123',
      messageClientId: 'client/9',
    });
  });

  it('tolerates the device-frozen link format when routing a click', () => {
    // 远程会话深链带 `?device=`(renderer 生成);main 端点击路由按 sessionId
    // 导航即可,未知参数不拖累 session / message 解析。
    expect(parseDeepLink(buildSessionDeepLink('abc-123', { deviceId: 'dev-1' }))).toEqual({
      type: 'session',
      id: 'abc-123',
    });
    expect(
      parseDeepLink(buildSessionMessageDeepLink('abc-123', 'm1', { deviceId: 'dev-1' })),
    ).toEqual({
      type: 'session',
      id: 'abc-123',
      messageClientId: 'm1',
    });
  });

  it('ignores empty or malformed message anchor but keeps session id', () => {
    expect(parseDeepLink('xdt-maker://session/abc-123?message=')).toEqual({
      type: 'session',
      id: 'abc-123',
    });
    // 非法 % 序列:锚点作废,sessionId 不受拖累
    expect(parseDeepLink('xdt-maker://session/abc-123?message=%E4%ZZ')).toEqual({
      type: 'session',
      id: 'abc-123',
    });
    // 其它 query 参数忽略(向前兼容)
    expect(parseDeepLink('xdt-maker://session/abc-123?foo=bar&message=m1')).toEqual({
      type: 'session',
      id: 'abc-123',
      messageClientId: 'm1',
    });
  });

  it('keeps project query-stripping behavior unchanged', () => {
    expect(parseDeepLink('xdt-maker://project/dir?message=x')).toEqual({
      type: 'project',
      workingDir: 'dir',
    });
  });

  it('parses focus payload regardless of source value', () => {
    expect(parseDeepLink('xdt-maker://focus/google-auth')).toEqual({ type: 'focus' });
    expect(parseDeepLink(buildFocusDeepLink('google-auth'))).toEqual({ type: 'focus' });
  });

  it('returns null for focus without a source value', () => {
    expect(parseDeepLink('xdt-maker://focus/')).toBeNull();
  });

  it('parses settings/providers payload with and without a connect target', () => {
    expect(parseDeepLink('cindy://settings/providers')).toEqual({
      type: 'settings',
      tab: 'providers',
    });
    expect(parseDeepLink('cindy://settings/providers/')).toEqual({
      type: 'settings',
      tab: 'providers',
    });
    expect(parseDeepLink('cindy://settings/providers?connect=openrouter')).toEqual({
      type: 'settings',
      tab: 'providers',
      connect: 'openrouter',
    });
    // connect 同时覆盖 provider id 与 preset id 的字符契约;其它 query 参数忽略。
    expect(parseDeepLink('cindy://settings/providers?foo=bar&connect=Vendor_2')).toEqual({
      type: 'settings',
      tab: 'providers',
      connect: 'Vendor_2',
    });
    // 历史 scheme 同样可用
    expect(parseDeepLink('xdt-maker://settings/providers?connect=deepseek')).toEqual({
      type: 'settings',
      tab: 'providers',
      connect: 'deepseek',
    });
  });

  it('rejects settings deep links outside the providers tab', () => {
    // voice-input 仍是主进程内部专用 payload,不开放给外部 URL 注入
    expect(parseDeepLink('cindy://settings/voice-input')).toBeNull();
    expect(parseDeepLink('cindy://settings/anything-else')).toBeNull();
    expect(parseDeepLink('cindy://settings/providers/anything-else')).toBeNull();
    expect(parseDeepLink('cindy://settings/')).toBeNull();
  });

  it('rejects settings deep links whose connect value fails the shared id whitelist', () => {
    // 深链是不可信输入:非法 connect 整条拒绝,不做"半执行"。
    expect(parseDeepLink('cindy://settings/providers?connect=')).toBeNull();
    expect(parseDeepLink('cindy://settings/providers?connect=a.b')).toBeNull();
    expect(parseDeepLink('cindy://settings/providers?connect=a%20b')).toBeNull();
    expect(parseDeepLink('cindy://settings/providers?connect=%3Cscript%3E')).toBeNull();
    expect(parseDeepLink('cindy://settings/providers?connect=%E4%ZZ')).toBeNull();
    expect(
      parseDeepLink(`cindy://settings/providers?connect=${'a'.repeat(129)}`),
    ).toBeNull();
  });
});

// 双 scheme 收敛(2026-07 品牌翻转):解析 cindy 主 + 历史 xdt-maker 都认,
// 生成一律主 scheme cindy://。上面的 xdt-maker:// 用例即历史 scheme 回归。
describe('dual scheme (cindy primary + legacy xdt-maker)', () => {
  it('parses primary-scheme cindy:// links for every payload type', () => {
    expect(parseDeepLink('cindy://session/abc-123')).toEqual({
      type: 'session',
      id: 'abc-123',
    });
    expect(parseDeepLink('cindy://session/abc-123?message=client-9')).toEqual({
      type: 'session',
      id: 'abc-123',
      messageClientId: 'client-9',
    });
    expect(parseDeepLink(`cindy://project/${encodeURIComponent('C:\\Some Path\\proj')}`)).toEqual({
      type: 'project',
      workingDir: 'C:\\Some Path\\proj',
    });
    expect(parseDeepLink('cindy://focus/google-auth')).toEqual({ type: 'focus' });
    expect(parseDeepLink('cindy://unknown/x')).toBeNull();
    expect(parseDeepLink('cindy://session/')).toBeNull();
  });

  it('generates all builders with the primary cindy:// scheme', () => {
    expect(DEEP_LINK_PROTOCOL).toBe('cindy');
    expect(buildSessionDeepLink('abc-123')).toBe('cindy://session/abc-123');
    expect(buildSessionMessageDeepLink('abc-123', 'm1')).toBe(
      'cindy://session/abc-123?message=m1',
    );
    expect(buildProjectDeepLink('/tmp/x')).toBe('cindy://project/%2Ftmp%2Fx');
    expect(buildFocusDeepLink('google-auth')).toBe('cindy://focus/google-auth');
  });
});

describe('findDeepLinkInArgv', () => {
  it('returns the last xdt-maker URL in argv', () => {
    expect(
      findDeepLinkInArgv(['electron.exe', '--flag', 'xdt-maker://session/a']),
    ).toBe('xdt-maker://session/a');
  });

  it('returns null when no xdt-maker URL present', () => {
    expect(findDeepLinkInArgv(['electron.exe', '--flag'])).toBeNull();
  });

  it('accepts both cindy and legacy xdt-maker schemes in argv', () => {
    expect(findDeepLinkInArgv(['electron.exe', 'cindy://session/a'])).toBe('cindy://session/a');
    expect(findDeepLinkInArgv(['electron.exe', 'xdt-maker://session/a'])).toBe(
      'xdt-maker://session/a',
    );
  });
});

describe('findOpenFolderInArgv', () => {
  it('parses --open-folder followed by a separate path arg', () => {
    expect(
      findOpenFolderInArgv([
        'electron.exe',
        OPEN_FOLDER_FLAG,
        'C:\\Users\\me\\projects\\foo',
      ]),
    ).toBe('C:\\Users\\me\\projects\\foo');
  });

  it('parses --open-folder=<path> compact form', () => {
    expect(
      findOpenFolderInArgv(['electron.exe', `${OPEN_FOLDER_FLAG}=C:\\Users\\me\\dir`]),
    ).toBe('C:\\Users\\me\\dir');
  });

  it('returns null when flag missing entirely', () => {
    expect(findOpenFolderInArgv(['electron.exe', '--other', 'value'])).toBeNull();
  });

  it('returns null when --open-folder is the very last arg (no value)', () => {
    expect(findOpenFolderInArgv(['electron.exe', OPEN_FOLDER_FLAG])).toBeNull();
  });

  it('returns null when --open-folder= has empty value', () => {
    expect(findOpenFolderInArgv(['electron.exe', `${OPEN_FOLDER_FLAG}=`])).toBeNull();
  });

  it('recovers when Electron second-instance argv interleaves Chromium flags before the folder path', () => {
    expect(
      findOpenFolderInArgv([
        'xdt-maker.exe',
        OPEN_FOLDER_FLAG,
        '--allow-file-access-from-files',
        '--enable-features=SharedArrayBuffer',
        'C:\\Users\\me\\Downloads\\temp',
      ]),
    ).toBe('C:\\Users\\me\\Downloads\\temp');
  });

  it('ignores Windows Chromium slash switches when recovering folder path', () => {
    expect(
      findOpenFolderInArgv([
        'xdt-maker.exe',
        OPEN_FOLDER_FLAG,
        '/prefetch:1',
        'C:\\Users\\me\\Downloads\\temp',
      ]),
    ).toBe('C:\\Users\\me\\Downloads\\temp');
  });

  it('returns null when only a Windows Chromium slash switch follows --open-folder', () => {
    expect(findOpenFolderInArgv(['xdt-maker.exe', OPEN_FOLDER_FLAG, '/prefetch:1'])).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('keeps POSIX absolute paths while skipping slash switches', () => {
    expect(
      findOpenFolderInArgv([
        'xdt-maker',
        OPEN_FOLDER_FLAG,
        '/prefetch:1',
        '/tmp/xdt-maker-project',
      ]),
    ).toBe('/tmp/xdt-maker-project');
  });

  it('returns the first occurrence (deterministic when caller emits multiple)', () => {
    expect(
      findOpenFolderInArgv([
        OPEN_FOLDER_FLAG,
        'C:\\first\\path',
        OPEN_FOLDER_FLAG,
        'C:\\second\\path',
      ]),
    ).toBe('C:\\first\\path');
  });

  it('handles CJK / spaces in path verbatim (no URL decoding)', () => {
    const path = 'C:\\Users\\张三\\我的 项目';
    expect(findOpenFolderInArgv(['electron.exe', OPEN_FOLDER_FLAG, path])).toBe(
      path,
    );
  });
});

describe('findOpenShareFileInArgv', () => {
  it('parses --open-share-file followed by a .cshare path', () => {
    expect(
      findOpenShareFileInArgv([
        'xdt-maker.exe',
        OPEN_SHARE_FILE_FLAG,
        'C:\\Users\\me\\Downloads\\session.cshare',
      ]),
    ).toBe('C:\\Users\\me\\Downloads\\session.cshare');
  });

  it('parses --open-share-file=<path> compact form for legacy .xdtshare', () => {
    expect(
      findOpenShareFileInArgv([
        'xdt-maker.exe',
        `${OPEN_SHARE_FILE_FLAG}=D:\\shares\\old.xdtshare`,
      ]),
    ).toBe('D:\\shares\\old.xdtshare');
  });

  it('recovers when Electron second-instance argv interleaves Chromium flags before the share file path', () => {
    expect(
      findOpenShareFileInArgv([
        'xdt-maker.exe',
        OPEN_SHARE_FILE_FLAG,
        '--allow-file-access-from-files',
        'D:\\shares\\team.cshare',
      ]),
    ).toBe('D:\\shares\\team.cshare');
  });

  it('returns null when --open-share-file is the very last arg (no value)', () => {
    expect(findOpenShareFileInArgv(['xdt-maker.exe', OPEN_SHARE_FILE_FLAG])).toBeNull();
  });

  it('returns null when --open-share-file= has empty value', () => {
    expect(findOpenShareFileInArgv(['xdt-maker.exe', `${OPEN_SHARE_FILE_FLAG}=`])).toBeNull();
  });

  it('ignores Windows Chromium slash switches when recovering share file path', () => {
    expect(
      findOpenShareFileInArgv([
        'xdt-maker.exe',
        OPEN_SHARE_FILE_FLAG,
        '/prefetch:1',
        'D:\\shares\\team.cshare',
      ]),
    ).toBe('D:\\shares\\team.cshare');
  });

  it('returns null when only a Windows Chromium slash switch follows --open-share-file', () => {
    expect(findOpenShareFileInArgv(['xdt-maker.exe', OPEN_SHARE_FILE_FLAG, '/prefetch:1'])).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('keeps POSIX share file paths while skipping slash switches', () => {
    expect(
      findOpenShareFileInArgv([
        'xdt-maker',
        OPEN_SHARE_FILE_FLAG,
        '/prefetch:1',
        '/tmp/team.cshare',
      ]),
    ).toBe('/tmp/team.cshare');
  });
});
