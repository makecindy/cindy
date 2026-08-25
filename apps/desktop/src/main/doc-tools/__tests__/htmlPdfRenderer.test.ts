/**
 * htmlPdfRenderer 测试:用可控的 electron 桩驱动隐藏渲染窗。
 *
 * 覆盖 electron-security §3 / §3.1 里对这扇窗真正适用的那几条:
 *  - 安全字段全部显式写死、无 preload、不 show;
 *  - 导航与弹窗 fail closed;
 *  - 即用即毁(成功、失败、超时三条路径都销毁窗口);
 *  - 同刻并发 1、其余排队;
 *  - 30s 超时;
 *  - 加载失败 / 渲染进程崩溃只让这次渲染失败,不升级、不自动重建。
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindowOptions {
  webPreferences?: Record<string, unknown>;
  show?: boolean;
  [k: string]: unknown;
}

class FakeSession extends EventEmitter {
  permissionRequestHandler: ((...args: any[]) => void) | undefined;
  permissionCheckHandler: ((...args: any[]) => boolean) | undefined;
  beforeRequestHandler:
    | ((
        details: { url: string; resourceType?: string },
        callback: (response: { cancel: boolean }) => void,
      ) => void)
    | undefined;
  webRequest = {
    onBeforeRequest: vi.fn(
      (
        handler: (
          details: { url: string; resourceType?: string },
          callback: (response: { cancel: boolean }) => void,
        ) => void,
      ) => {
        this.beforeRequestHandler = handler;
      },
    ),
  };

  constructor() {
    super();
  }

  setPermissionRequestHandler(handler: (...args: any[]) => void): void {
    this.permissionRequestHandler = handler;
  }

  setPermissionCheckHandler(handler: (...args: any[]) => boolean): void {
    this.permissionCheckHandler = handler;
  }
}

class FakeWebContents extends EventEmitter {
  windowOpenHandler: ((details: unknown) => unknown) | undefined;
  readonly session = new FakeSession();

  printToPDF = vi.fn(async (_opts: unknown) => {
    FakeBrowserWindow.calls.push('printToPDF');
    return FakeBrowserWindow.pdfResult();
  });

  executeJavaScript = vi.fn(async (script: string) => {
    FakeBrowserWindow.calls.push(`executeJavaScript:${script}`);
    return FakeBrowserWindow.fontsBehavior();
  });

  setWindowOpenHandler(handler: (details: unknown) => unknown): void {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = [];
  /** 调用顺序流水,用来断言「加载 → 等字体 → 打印」这条硬顺序。 */
  static calls: string[] = [];
  static pdfResult: () => Promise<Buffer> | Buffer = () => Buffer.from('%PDF-ok');
  static fontsBehavior: () => Promise<unknown> | unknown = () => true;
  static loadBehavior: (win: FakeBrowserWindow, file: string) => Promise<void> = async () => {};

  readonly webContents = new FakeWebContents();
  readonly options: FakeWindowOptions;
  destroyed = false;
  shown = false;
  loadedFile: string | undefined;

  constructor(options: FakeWindowOptions) {
    super();
    this.options = options;
    FakeBrowserWindow.instances.push(this);
  }

  async loadFile(file: string): Promise<void> {
    this.loadedFile = file;
    FakeBrowserWindow.calls.push('loadFile');
    await FakeBrowserWindow.loadBehavior(this, file);
  }

  show(): void {
    this.shown = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

let tempRoot: string;

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  app: { getPath: () => tempRoot },
  nativeTheme: { shouldUseDarkColors: false },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { renderHtmlToPdf, __getActiveRenderCount } = await import('../htmlPdfRenderer.js');

const BASE_INPUT = {
  pageSize: 'A4' as const,
  landscape: false,
  printBackground: true,
  margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
  timeoutMs: 30_000,
  fontTimeoutMs: 5_000,
};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-renderer-'));
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.calls = [];
  FakeBrowserWindow.pdfResult = () => Buffer.from('%PDF-ok');
  FakeBrowserWindow.fontsBehavior = () => true;
  FakeBrowserWindow.loadBehavior = async () => {};
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('渲染窗的安全配置', () => {
  it('§3 的安全字段全部显式写死,且没有 preload、不 show', async () => {
    await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>x</p>' });
    const win = FakeBrowserWindow.instances[0]!;
    const prefs = win.options.webPreferences!;

    expect(win.options.show).toBe(false);
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      webviewTag: false,
    });
    expect(prefs.preload).toBeUndefined();
    expect(prefs.enableBlinkFeatures).toBeUndefined();
    expect(prefs.partition).toMatch(/^temp:cindy-docs-/);
    expect(win.webContents.session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(win.webContents.session.permissionRequestHandler).toBeDefined();
    expect(win.webContents.session.permissionCheckHandler).toBeDefined();
    const permissionCallback = vi.fn();
    win.webContents.session.permissionRequestHandler!({}, 'geolocation', permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
    expect(win.webContents.session.permissionCheckHandler!()).toBe(false);
    const downloadEvent = { preventDefault: vi.fn() };
    win.webContents.session.emit('will-download', downloadEvent, {});
    expect(downloadEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.shown).toBe(false);
  });

  it('本地资源路径含 symlink 时 fail closed,不把 file URL 交给 Chromium', async () => {
    const sourceDir = path.join(tempRoot, 'source');
    const outsideDir = path.join(tempRoot, 'outside');
    await Promise.all([fs.mkdir(sourceDir), fs.mkdir(outsideDir)]);
    await fs.writeFile(path.join(sourceDir, 'src.html'), '<p>x</p>');
    await fs.writeFile(path.join(outsideDir, 'secret.png'), 'secret');
    const link = path.join(sourceDir, 'secret.png');
    await fs.symlink(
      path.join(outsideDir, 'secret.png'),
      link,
      process.platform === 'win32' ? 'file' : undefined,
    );
    await renderHtmlToPdf({
      ...BASE_INPUT,
      htmlBytes: await fs.readFile(path.join(sourceDir, 'src.html')),
    }).catch(() => undefined);
    const handler = FakeBrowserWindow.instances[0]!.webContents.session.beforeRequestHandler!;
    const response = await new Promise<{ cancel: boolean }>((resolve) =>
      handler({ url: pathToFileURL(link).href }, resolve),
    );
    expect(response.cancel).toBe(true);
  });

  it('请求级 URL 策略只放行内联 URL,阻断本地 file URL 与网络', async () => {
    const localAsset = path.join(tempRoot, 'asset.txt');
    await fs.writeFile(localAsset, 'asset', 'utf8');
    await fs.writeFile(path.join(tempRoot, 'src.html'), '<p>x</p>');
    await renderHtmlToPdf({
      ...BASE_INPUT,
      htmlBytes: await fs.readFile(path.join(tempRoot, 'src.html')),
    }).catch(() => undefined);
    const win = FakeBrowserWindow.instances[0]!;
    const handler = win.webContents.session.beforeRequestHandler!;
    const decide = async (url: string): Promise<boolean> => {
      const response = await new Promise<{ cancel: boolean }>((resolve) =>
        handler({ url }, resolve),
      );
      return !response.cancel;
    };
    expect(await decide(`file://${localAsset}`)).toBe(false);
    expect(await decide('data:text/plain,ok')).toBe(true);
    expect(await decide('https://example.com/font.woff2')).toBe(false);
    expect(await decide('http://127.0.0.1:8080/secret')).toBe(false);
    expect(await decide('file:///etc/passwd')).toBe(false);
  });

  it('只放行已准备好的主文档入口,不放行其它 file 子资源', async () => {
    await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>x</p>' });
    const win = FakeBrowserWindow.instances[0]!;
    const handler = win.webContents.session.beforeRequestHandler!;
    const entry = pathToFileURL(win.loadedFile!).href;
    const mainFrame = await new Promise<{ cancel: boolean }>((resolve) =>
      handler({ url: entry, resourceType: 'mainFrame' }, resolve),
    );
    const subresource = await new Promise<{ cancel: boolean }>((resolve) =>
      handler({ url: entry, resourceType: 'image' }, resolve),
    );
    expect(mainFrame.cancel).toBe(false);
    expect(subresource.cancel).toBe(true);
  });

  it('弹窗与 Renderer 发起的导航一律 deny', async () => {
    await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>x</p>' });
    const win = FakeBrowserWindow.instances[0]!;
    expect(win.webContents.windowOpenHandler!({ url: 'https://evil.example' })).toEqual({
      action: 'deny',
    });

    // will-navigate 只对 Renderer 发起的导航触发,首帧 loadFile 不经过它,
    // 所以这里全拒 —— 包括页面想重新加载自己。
    for (const url of ['https://evil.example', `file://${win.loadedFile}`, 'about:blank']) {
      const event = { preventDefault: vi.fn() };
      win.webContents.emit('will-navigate', event, url);
      expect(event.preventDefault, `${url} should be blocked`).toHaveBeenCalled();
    }
  });
});

describe('渲染主流程', () => {
  it('内联 HTML 落到临时文件被加载,渲染完临时目录被清理', async () => {
    let loadedContent = '';
    FakeBrowserWindow.loadBehavior = async (_win, file) => {
      loadedContent = await fs.readFile(file, 'utf-8');
    };
    const { buffer } = await renderHtmlToPdf({ ...BASE_INPUT, html: '<h1>hello</h1>' });
    expect(buffer.toString()).toBe('%PDF-ok');
    expect(loadedContent).toBe('<h1>hello</h1>');

    const tempFile = FakeBrowserWindow.instances[0]!.loadedFile!;
    await expect(fs.stat(path.dirname(tempFile))).rejects.toThrow();
  });

  it('只加载传入的 HTML 快照,不按调用方路径重新打开源文件', async () => {
    const source = path.join(tempRoot, 'src.html');
    await fs.writeFile(source, '<p>x</p>', 'utf-8');
    await renderHtmlToPdf({ ...BASE_INPUT, htmlBytes: await fs.readFile(source) });
    expect(FakeBrowserWindow.instances[0]!.loadedFile).not.toBe(source);
    await expect(fs.stat(source)).resolves.toBeTruthy();
  });

  it('主文档快照完成后源路径被换成外部链接也不会改变待打印内容', async () => {
    const source = path.join(tempRoot, 'src.html');
    const outside = path.join(tempRoot, 'outside.html');
    const moved = path.join(tempRoot, 'src-original.html');
    await fs.writeFile(source, '<p>safe</p>', 'utf-8');
    await fs.writeFile(outside, '<p>outside</p>', 'utf-8');
    const snapshot = await fs.readFile(source);
    await fs.rename(source, moved);
    await fs.symlink(outside, source, process.platform === 'win32' ? 'file' : undefined);
    let loadedContent = '';
    FakeBrowserWindow.loadBehavior = async (_win, file) => {
      loadedContent = await fs.readFile(file, 'utf-8');
    };

    await renderHtmlToPdf({ ...BASE_INPUT, htmlBytes: snapshot });

    expect(loadedContent).toBe('<p>safe</p>');
  });

  it('排版参数原样交给 printToPDF(margins 用 custom)', async () => {
    await renderHtmlToPdf({
      ...BASE_INPUT,
      html: '<p/>',
      pageSize: 'Letter',
      landscape: true,
      printBackground: false,
      margins: { top: 1, bottom: 0.2, left: 0.3, right: 0.4 },
    });
    expect(FakeBrowserWindow.instances[0]!.webContents.printToPDF).toHaveBeenCalledWith({
      pageSize: 'Letter',
      landscape: true,
      printBackground: false,
      margins: { marginType: 'custom', top: 1, bottom: 0.2, left: 0.3, right: 0.4 },
    });
  });

  it('成功后窗口即刻销毁(不隐藏复用)', async () => {
    await renderHtmlToPdf({ ...BASE_INPUT, html: '<p/>' });
    expect(FakeBrowserWindow.instances[0]!.destroyed).toBe(true);
  });

  it('每次渲染都是全新窗口,不跨任务复用 webContents', async () => {
    await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>1</p>' });
    await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>2</p>' });
    expect(FakeBrowserWindow.instances).toHaveLength(2);
    expect(FakeBrowserWindow.instances[0]).not.toBe(FakeBrowserWindow.instances[1]);
  });
});

// Chromium 不会自己等 @font-face —— 字体没加载完就打印会被静默换成系统字体,
// 而且不报任何错。这组用例把「加载 → 等字体 → 打印」的顺序和超时降级钉死。
describe('字体就绪等待', () => {
  it('顺序硬约束:加载完成 → 等 document.fonts.ready → 才打印', async () => {
    const { fontsReady } = await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>x</p>' });
    expect(fontsReady).toBe(true);
    expect(FakeBrowserWindow.calls).toEqual([
      'loadFile',
      'executeJavaScript:document.fonts.ready.then(() => true)',
      'printToPDF',
    ]);
  });

  it('等字体超时时照常出片,但把 fontsReady=false 带回去', async () => {
    FakeBrowserWindow.fontsBehavior = () =>
      new Promise(() => {
        /* 永不 resolve:字体一直加载不完 */
      });
    const started = Date.now();
    const { buffer, fontsReady } = await renderHtmlToPdf({
      ...BASE_INPUT,
      html: '<p>x</p>',
      fontTimeoutMs: 60,
    });
    // 关键:字体等不到不能拖满总超时,也不能让整次渲染失败。
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(buffer.toString()).toBe('%PDF-ok');
    expect(fontsReady).toBe(false);
    expect(FakeBrowserWindow.calls).toContain('printToPDF');
  });

  it('页面没有 document.fonts(求值抛错)时降级为 fontsReady=false,不影响出片', async () => {
    FakeBrowserWindow.fontsBehavior = () =>
      Promise.reject(new Error('document.fonts is undefined'));
    const { buffer, fontsReady } = await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>x</p>' });
    expect(buffer.toString()).toBe('%PDF-ok');
    expect(fontsReady).toBe(false);
  });

  it('字体探测返回非 true 也按未就绪处理(不猜)', async () => {
    FakeBrowserWindow.fontsBehavior = () => undefined;
    const { fontsReady } = await renderHtmlToPdf({ ...BASE_INPUT, html: '<p>x</p>' });
    expect(fontsReady).toBe(false);
  });

  it('等字体期间页面崩溃仍然判这次渲染失败,不会打印出半成品', async () => {
    FakeBrowserWindow.fontsBehavior = () => new Promise(() => {});
    FakeBrowserWindow.loadBehavior = async (win) => {
      setTimeout(() => {
        win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      }, 10);
    };
    await expect(renderHtmlToPdf({ ...BASE_INPUT, html: '<p>x</p>' })).rejects.toThrow(
      /渲染进程异常退出/,
    );
    expect(FakeBrowserWindow.calls).not.toContain('printToPDF');
    expect(FakeBrowserWindow.instances[0]!.destroyed).toBe(true);
  });
});

describe('故障隔离', () => {
  it('加载失败让这次渲染失败,窗口销毁,且不去调 printToPDF', async () => {
    FakeBrowserWindow.loadBehavior = async (win) => {
      win.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing', true);
      await new Promise(() => {
        /* 永不 resolve —— 真实 loadFile 在失败时也不会正常完成 */
      });
    };
    await expect(renderHtmlToPdf({ ...BASE_INPUT, html: '<p/>' })).rejects.toThrow(/HTML 加载失败/);
    const win = FakeBrowserWindow.instances[0]!;
    expect(win.destroyed).toBe(true);
    expect(win.webContents.printToPDF).not.toHaveBeenCalled();
  });

  it('子 frame 加载失败不阻断已成功的顶层文档', async () => {
    FakeBrowserWindow.loadBehavior = async (win) => {
      win.webContents.emit(
        'did-fail-load',
        {},
        -3,
        'ERR_ABORTED',
        'https://blocked.example/frame',
        false,
      );
    };
    const { buffer } = await renderHtmlToPdf({
      ...BASE_INPUT,
      html: '<iframe src="https://blocked.example/frame"></iframe><p>ok</p>',
    });
    expect(buffer.toString()).toBe('%PDF-ok');
    expect(FakeBrowserWindow.instances[0]!.webContents.printToPDF).toHaveBeenCalledTimes(1);
  });

  it('渲染进程崩溃被翻成失败,不升级成别的东西', async () => {
    FakeBrowserWindow.loadBehavior = async (win) => {
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      await new Promise(() => {});
    };
    await expect(renderHtmlToPdf({ ...BASE_INPUT, html: '<p/>' })).rejects.toThrow(
      /渲染进程异常退出\(crashed\)/,
    );
    expect(FakeBrowserWindow.instances[0]!.destroyed).toBe(true);
  });

  it('printToPDF 抛错时窗口照样销毁,不泄漏', async () => {
    FakeBrowserWindow.pdfResult = () => Promise.reject(new Error('printToPDF boom'));
    await expect(renderHtmlToPdf({ ...BASE_INPUT, html: '<p/>' })).rejects.toThrow(
      'printToPDF boom',
    );
    expect(FakeBrowserWindow.instances[0]!.destroyed).toBe(true);
  });

  it('失败不自动重试:一次调用只建一扇窗', async () => {
    FakeBrowserWindow.pdfResult = () => Promise.reject(new Error('boom'));
    await expect(renderHtmlToPdf({ ...BASE_INPUT, html: '<p/>' })).rejects.toThrow();
    expect(FakeBrowserWindow.instances).toHaveLength(1);
  });

  it('前一次失败不影响排在后面的那次', async () => {
    // 按调用顺序取行为:两次渲染是排队串行的,不能靠"改一次全局变量"来区分。
    const behaviors: Array<() => Promise<Buffer>> = [
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve(Buffer.from('%PDF-second')),
    ];
    FakeBrowserWindow.pdfResult = () => behaviors.shift()!();

    const failing = renderHtmlToPdf({ ...BASE_INPUT, html: '<p>1</p>' });
    const following = renderHtmlToPdf({ ...BASE_INPUT, html: '<p>2</p>' });

    await expect(failing).rejects.toThrow('boom');
    expect((await following).buffer.toString()).toBe('%PDF-second');
  });
});

describe('超时与并发', () => {
  it('超过 timeoutMs 直接判超时并销毁窗口', async () => {
    // 用真实计时器 + 很短的超时:假计时器会让「渲染排队链」这条真实异步链
    // 卡在半路,测出来的就不是生产行为了。
    FakeBrowserWindow.loadBehavior = async () => {
      await new Promise(() => {
        /* 卡住不返回,模拟加载不出来的外部资源 */
      });
    };
    await expect(renderHtmlToPdf({ ...BASE_INPUT, html: '<p/>', timeoutMs: 50 })).rejects.toThrow(
      /渲染超时\(50ms timeout\)/,
    );
    expect(FakeBrowserWindow.instances[0]!.destroyed).toBe(true);
  });

  it('同刻只跑一个渲染,其余排队', async () => {
    const gates: Array<() => void> = [];
    FakeBrowserWindow.loadBehavior = async () =>
      new Promise<void>((resolve) => {
        gates.push(resolve);
      });

    const first = renderHtmlToPdf({ ...BASE_INPUT, html: '<p>1</p>' });
    const second = renderHtmlToPdf({ ...BASE_INPUT, html: '<p>2</p>' });

    // 让第一个走到 loadFile
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(__getActiveRenderCount()).toBe(1);

    gates[0]!();
    await first;
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(FakeBrowserWindow.instances).toHaveLength(2);
    gates[1]!();
    await second;
    expect(__getActiveRenderCount()).toBe(0);
  });
});
