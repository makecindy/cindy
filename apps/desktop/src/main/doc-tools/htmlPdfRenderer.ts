/**
 * doc-tools/htmlPdfRenderer.ts —— cindy_docs `render_pdf` 的宿主实现。
 *
 * 在一个**不可见、即用即毁**的 BrowserWindow 里加载目标 HTML,再用
 * `webContents.printToPDF` 出字节。`@cindy/mcps` 不 import electron(既有铁律),
 * 所以这个函数由 mcp-integrations/mcp-providers.ts 闭包注入给 MCP server。
 *
 * ── 与 electron-security-and-process-boundaries §3 的对账 ──────────────────
 * webPreferences 的全部安全字段显式写死,不依赖 Electron 默认值:sandbox、
 * contextIsolation、nodeIntegration(含 SubFrames / Worker)、webSecurity、
 * allowRunningInsecureContent、experimentalFeatures、plugins、navigateOnDragDrop、
 * webviewTag,并且**不挂任何 preload** —— 这个窗口只排版内容,不需要任何 bridge,
 * 页面里的脚本因此拿不到 Cindy 的任何 IPC 面。导航与弹窗按 §6 fail closed:
 * `setWindowOpenHandler` 一律 deny,`will-navigate` 只放行首帧那一个地址。
 *
 * ── 与 §3.1「独立辅助窗口统一生命周期基线」的关系 ──────────────────────────
 * §3.1 约束的是「从界面打开、用户会反复打开、要展示给人看」的辅助窗口,权威基线是
 * resource-usage-window 那套预热 + 隐藏复用 + 双阶段就绪握手的控制器。
 * **本渲染窗不属于那一类,也刻意不复用那套控制器**,冲突点写在这里:
 *
 *  1. 它永远不 show()。没有「打开路径」,也就没有要移出点击路径的准备成本,
 *     预热与 ready-to-show/内容就绪握手在这里没有对应语义。
 *  2. 它加载的是**任务提供的任意 HTML**。隐藏复用意味着同一个 webContents 先后
 *     承载不同任务的内容,残留的 JS 计时器、Service Worker、内存里的上一份文档
 *     都会跨任务泄漏 —— 这是安全退步,不是性能优化。所以是即用即毁:每次渲染
 *     一个全新窗口,`finally` 里必 destroy。
 *  3. 它没有 Renderer 入口、没有 preload、没有主题表面 —— §3.1 第 4/5/6 条
 *     (交互态重置、轻量入口、首帧底色)在这里无对象。
 *
 * §3.1 里仍然适用、且这里确实做到的是:安全字段(第 6 条)与故障隔离 + 有界恢复
 * (第 7 条)。有界恢复在这里体现为:30 秒硬超时、同刻只允许一个渲染窗(其余排队)、
 * 加载失败 / Renderer 崩溃都只让这一次渲染失败并销毁窗口,绝不升级成整应用退出,
 * 也不会形成无限重建循环(本模块从不自动重试,重试与否由模型决定)。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, app } from 'electron';

import type { DocsPdfRenderInput } from '@cindy/mcps';

import { createLogger } from '../logger.js';

const log = createLogger('doc-tools/html-pdf');

/**
 * 渲染窗视口。只影响 CSS 视口宽度(媒体查询、百分比布局),不影响最终纸张尺寸
 * —— 纸张由 printToPDF 的 pageSize 决定。给一个接近 A4 96dpi 的宽度,让没写
 * 打印样式的普通网页也能排出正常的行长。
 */
const RENDER_VIEWPORT = { width: 1024, height: 1440 };

/**
 * 同刻并发上限 1。printToPDF 走的是完整 Chromium 排版 + 光栅化,并发开多个隐藏
 * 窗口在低配机器上会把主进程拖到卡顿;文档生成本来就不是高频操作,排队即可。
 */
let renderChain: Promise<unknown> = Promise.resolve();

/** 供测试断言排队行为:当前是否有渲染在跑。 */
let activeRenders = 0;

export function __getActiveRenderCount(): number {
  return activeRenders;
}

function tempRoot(): string {
  // app.getPath('temp') 在 Electron 里就是系统临时目录;非 Electron 环境(单测)
  // 回落 os.tmpdir()。可丢弃临时数据放这里,符合 credentials-and-local-storage 的口径。
  try {
    return app.getPath('temp');
  } catch {
    return os.tmpdir();
  }
}

interface PreparedSource {
  fileUrlPath: string;
  /** 需要清理的临时目录(仅内联 HTML 走这条路)。 */
  cleanupDir?: string;
}

async function prepareSource(input: DocsPdfRenderInput): Promise<PreparedSource> {
  if (input.htmlPath) return { fileUrlPath: input.htmlPath };
  const dir = await fs.mkdtemp(path.join(tempRoot(), 'cindy-docs-html-'));
  const file = path.join(dir, 'source.html');
  await fs.writeFile(file, input.html ?? '', 'utf-8');
  return { fileUrlPath: file, cleanupDir: dir };
}

function createRenderWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: RENDER_VIEWPORT.width,
    height: RENDER_VIEWPORT.height,
    // 永不进入用户视野:不上任务栏、不抢焦点、不参与窗口切换。
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      // ── electron-security §3:全部安全字段显式写死 ──
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
      spellcheck: false,
      // 有意不设 preload:排版窗不需要任何 bridge,页面脚本拿不到 IPC 面。
      // 有意不设 enableBlinkFeatures。
      backgroundThrottling: false,
    },
  });
}

/**
 * 弹窗与导航一律 fail closed(electron-security §6)。
 *
 * 这里是「全部拒绝」而不是「放行首帧那个地址」:`will-navigate` 只对 Renderer 发起的
 * 导航触发,Main 侧 `loadFile` 那一次首帧加载根本不经过它。所以能到这个回调的,
 * 只可能是页面自己想跳走(meta refresh / location.href / 表单自动提交 / 链接点击)
 * —— 一个只用来排版的离屏文档没有任何理由跳转。顺带避开了「拼 file:// URL 再比字符串」
 * 在 Windows 上(`C:\a` vs `file:///C:/a`)必然对不上的坑。
 */
function lockNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event: { preventDefault: () => void }) => {
    event.preventDefault();
  });
}

interface RenderAttemptResult {
  buffer: Buffer;
}

async function renderOnce(input: DocsPdfRenderInput): Promise<RenderAttemptResult> {
  const source = await prepareSource(input);
  let win: BrowserWindow | null = null;
  let timer: NodeJS.Timeout | undefined;

  try {
    win = createRenderWindow();
    const target = win;
    lockNavigation(target);

    const work = (async (): Promise<Buffer> => {
      // 加载失败与 Renderer 崩溃都要把这次渲染判死,否则 printToPDF 会在一个空白
      // 或已死的 webContents 上返回一份「合法但全白」的 PDF —— 那正是最坏的结果:
      // 用户拿到一个看着像成功的坏文件。
      const failure = new Promise<never>((_resolve, reject) => {
        target.webContents.once(
          'did-fail-load',
          (_event: unknown, errorCode: number, errorDescription: string) => {
            reject(new Error(`HTML 加载失败(${errorCode} ${errorDescription})`));
          },
        );
        target.webContents.once('render-process-gone', (_event: unknown, details: { reason?: string }) => {
          reject(new Error(`渲染进程异常退出(${details?.reason ?? 'unknown'})`));
        });
      });

      await Promise.race([target.loadFile(source.fileUrlPath), failure]);
      const pdf = await Promise.race([
        target.webContents.printToPDF({
          landscape: input.landscape,
          printBackground: input.printBackground,
          pageSize: input.pageSize,
          margins: {
            marginType: 'custom',
            top: input.margins.top,
            bottom: input.margins.bottom,
            left: input.margins.left,
            right: input.margins.right,
          },
        }),
        failure,
      ]);
      return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf as Uint8Array);
    })();

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`HTML 渲染超时(${input.timeoutMs}ms timeout)`));
      }, input.timeoutMs);
    });

    const buffer = await Promise.race([work, timeout]);
    return { buffer };
  } finally {
    if (timer) clearTimeout(timer);
    // 即用即毁。超时路径下 work 那条 promise 可能还挂在加载上,destroy 会把它一起
    // 掐掉;window 销毁后残留的 rejection 由下面的 catch 兜住,不会变成
    // unhandledRejection 把主进程带走。
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch (err) {
        log.warn('destroy render window failed', err);
      }
    }
    if (source.cleanupDir) {
      await fs.rm(source.cleanupDir, { recursive: true, force: true }).catch(() => {
        /* 临时目录清理尽力而为 */
      });
    }
  }
}

/**
 * HTML → PDF。串行执行(同刻 1 个渲染窗),失败抛错由 MCP 工具层翻成
 * RENDER_TIMEOUT / RENDER_FAILED。
 */
export function renderHtmlToPdf(input: DocsPdfRenderInput): Promise<Buffer> {
  const start = async (): Promise<Buffer> => {
    activeRenders += 1;
    try {
      const { buffer } = await renderOnce(input);
      return buffer;
    } finally {
      activeRenders -= 1;
    }
  };
  // 成功与失败都接同一个 start:前一次渲染失败不该拖垮排在它后面的这次。
  const run = renderChain.then(start, start);
  // 链上只保留「已结束」这一个信号,错误由各自的调用方 await 拿到 —— 不 catch 的话
  // 这条内部链会变成一个没人处理的 rejection。
  renderChain = run.catch(() => undefined);
  return run;
}
