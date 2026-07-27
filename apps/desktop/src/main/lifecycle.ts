/**
 * 退出生命周期注册器 —— 把散落在各模块的 quit / crash 清理逻辑收口到一处编排,
 * 避免多个 handler 互相 race、避免 fire-and-forget 在进程死之前来不及跑完。
 *
 * 使用方法 (在 main bootstrap 里):
 *   onQuit('shutdown-maker', shutdownMaker,                 'sync');
 *   onQuit('im',             () => im.dispose(),            'async');
 *   onQuit('local-db-close',    closeDb,                    'post-async');
 *   installQuitHandler();
 *
 * 执行顺序:
 *   1. sync       —— 串行跑, 吞个体异常不影响后续。允许返回 Promise 但不会被 await
 *                    (出现时只 warn, 鼓励标成 async)
 *   2. async      —— 并发跑, 整体不超过 timeoutMs (默认 2000ms), 超时谁没完就被腰斩
 *   3. post-async —— 串行跑, 确保依赖 async 阶段产物的清理 (例如关 sqlite 必须晚于
 *                    db.backup, 关 IM WS 必须晚于 announce offline)
 *
 * 然后 `app.exit(<code>)` 强制退出。`will-quit` / `quit` 事件不会触发——任何
 * 真正必须执行的清理都必须注册到这里, 而不是挂 `will-quit`。
 *
 * installQuitHandler() 同时把以下入口都收到这条 disposer chain:
 *
 *   - app.on('before-quit')             —— 用户/代码主动退出 (Cmd+Q / 关窗 / app.quit)
 *   - process.on('SIGINT'/'SIGTERM')    —— Ctrl+C / kill PID (dev 终端必装)
 *   - process.on('uncaughtException')   —— main 进程未捕获异常
 *   - app.on('render-process-gone')     —— renderer 崩 (main 还活)
 *
 * unhandledRejection 只记日志、不退出 —— 悬空 Promise 不必然致命, 让上游决定。
 * 真硬崩 (segfault / kill -9) JS 层无能为力, 这里覆盖不到; 子进程靠 stdin EOF 自死。
 */

import { app, BrowserWindow, session } from 'electron';

import {
  createLogger,
  disableDevTerminalMirror,
  isBrokenStdioError,
  isTransientNetworkError,
} from './logger';
import { noteQuitDisposersCompleted, noteShutdownBegin } from './startup-diagnostics';
import { isGhostSandboxWebContentsId } from './cindy-brain/runtime/electronSandboxAdapter';

/**
 * 瞬时网络错误的 wire payload (main → renderer)。code 永远存在 (Node 的 ErrnoException
 * 一定有 code), address/port 可能没有 (e.g. fetch 在 DNS 阶段失败时只有 hostname)。
 * 不带 stack —— 给用户看的 toast 不需要, 全栈已经在 main.log 里。
 */
export interface TransientNetworkErrorTipPayload {
  code: string;
  address?: string;
  port?: number;
}

/**
 * 广播 "瞬时网络错误" 提示到所有 renderer。lifecycle 兜底命中时调用,
 * renderer 自己决定怎么展示 (toast / banner / 忽略, 看 systemNetworkErrorToast.ts)。
 *
 * 故意吞所有错 —— 调用方是 uncaughtException handler, 这里再 throw 会形成
 * 二次 uncaughtException 死循环。
 */
function broadcastTransientNetworkErrorTip(err: NodeJS.ErrnoException): void {
  try {
    // address/port 不在 ErrnoException 的官方 typing 里, 但 Node 的 net.connect
    // 失败时确实会挂上去 (历史 main.log 已验证)。用 index 读避免 cast 出整个 any。
    const e = err as unknown as Record<string, unknown>;
    const payload: TransientNetworkErrorTipPayload = {
      code: err.code ?? 'UNKNOWN',
    };
    if (typeof e.address === 'string') payload.address = e.address;
    if (typeof e.port === 'number') payload.port = e.port;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('system:transient-network-error', payload);
      }
    }
  } catch (broadcastErr) {
    log.warn('failed to broadcast transient-network-error tip', broadcastErr);
  }
}

const log = createLogger('lifecycle');
let brokenStdioWarningLogged = false;

export type DisposerPhase = 'sync' | 'async' | 'post-async';

interface Disposer {
  name: string;
  phase: DisposerPhase;
  fn: () => void | Promise<void>;
}

const registry: Disposer[] = [];

export function onQuit(
  name: string,
  fn: () => void | Promise<void>,
  phase: DisposerPhase = 'sync',
): void {
  registry.push({ name, phase, fn });
}

export async function runQuitDisposers(timeoutMs = 2000): Promise<void> {
  // ── Phase 1: sync ────────────────────────────────────────────────────────
  for (const d of registry.filter((x) => x.phase === 'sync')) {
    try {
      const ret = d.fn();
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        log.warn(`sync disposer "${d.name}" returned a promise — not awaited`);
      }
    } catch (err) {
      log.error(`sync disposer "${d.name}" threw`, err);
    }
  }

  // ── Phase 2: async (concurrent, bounded by timeout) ──────────────────────
  const asyncs = registry.filter((x) => x.phase === 'async');
  if (asyncs.length > 0) {
    const settled = Promise.allSettled(
      asyncs.map((d) =>
        Promise.resolve()
          .then(() => d.fn())
          .catch((err) => {
            log.error(`async disposer "${d.name}" threw`, err);
            throw err;
          }),
      ),
    );
    let timedOut = false;
    await Promise.race([
      settled,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs),
      ),
    ]);
    if (timedOut) {
      log.warn(`async disposers timed out after ${timeoutMs}ms — proceeding to post-async`);
    }
  }

  // ── Phase 3: post-async ──────────────────────────────────────────────────
  for (const d of registry.filter((x) => x.phase === 'post-async')) {
    try {
      const ret = d.fn();
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        await (ret as Promise<unknown>).catch((err) =>
          log.error(`post-async disposer "${d.name}" threw`, err),
        );
      }
    } catch (err) {
      log.error(`post-async disposer "${d.name}" threw`, err);
    }
  }
}

let _installed = false;
let _isDisposing = false;
let _disposeStarted: Promise<void> | null = null;

/**
 * 幂等启动 disposer chain: 第一次调用真的跑, 后续调用复用同一个 Promise。
 * 返回的 Promise 在 sync + async + post-async 三阶段都跑完 (或 async 超时) 后 resolve。
 *
 * reason 是触发入口标识(before-quit / signal:SIGTERM / uncaughtException /
 * render-process-gone:<reason>),同时写进 run marker(startup-diagnostics),
 * 让下次启动的退出尸检能还原「这次 shutdown 是谁发起的」。
 */
function beginShutdown(timeoutMs: number, reason: string): Promise<void> {
  if (_disposeStarted) return _disposeStarted;
  _isDisposing = true;
  log.info(`beginShutdown timeoutMs=${timeoutMs} reason=${reason}`);
  noteShutdownBegin(reason);
  _disposeStarted = runQuitDisposers(timeoutMs)
    .then(() => {
      log.info('runQuitDisposers completed');
      noteQuitDisposersCompleted();
    })
    .catch((err) => {
      log.error('runQuitDisposers threw', err);
    });
  return _disposeStarted;
}

export function installQuitHandler(timeoutMs = 2000): void {
  if (_installed) return;
  _installed = true;

  // ── Built-in: 强制 Chromium 把 renderer 攒批的 localStorage 写入落盘 ────
  // Chromium 的 LocalStorageImpl 在 browser 进程里有秒级 batch 才提交到
  // <userData>/Local Storage/leveldb。我们 disposer chain 末尾走 app.exit()
  // 强退, 跳过 Chromium 的 graceful storage close, 中间几秒的 setItem 写入
  // 直接丢——在 release 的"热更新→relaunch"路径上,用户切完模型/permission
  // 立刻按"立即重启"几乎注定丢一次 prefs。post-async 阶段调一次 flush, 让
  // Chromium 把内存中的 DOMStorage 同步到 LevelDB。
  // flushStorageData 是 fire-and-forget 的 sync API; 实测够用——Chromium
  // 收到调用后内部立即 schedule 一次 commit, app.exit 之前足以走完。
  onQuit(
    'flush-storage-data',
    () => {
      try {
        session.defaultSession.flushStorageData();
      } catch (err) {
        log.warn('flushStorageData threw', err);
      }
    },
    'post-async',
  );

  // ── Layer 1: graceful quit (before-quit) ────────────────────────────────
  // preventDefault 阻断默认 quit, 等 disposer chain 跑完再 app.exit(0)。
  app.on('before-quit', (e) => {
    log.info('before-quit received');
    if (_isDisposing) return;
    e.preventDefault();
    void beginShutdown(timeoutMs, 'before-quit').finally(() => app.exit(0));
  });

  // ── Layer 2: Unix process signals ───────────────────────────────────────
  // SIGINT (Ctrl+C in dev terminal) / SIGTERM (systemd / kill PID)。
  // Electron 不会把这两个信号转 app.before-quit, 必须自己接。
  // 走 app.quit() 会 emit before-quit; 我们在那里 preventDefault 等 disposer
  // 跑完再 exit。如果 app 还没 ready, 直接走 disposer chain 然后 exit。
  const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  if (process.platform === 'win32') shutdownSignals.push('SIGBREAK');
  for (const sig of shutdownSignals) {
    process.on(sig, () => {
      log.info(`received ${sig}, gracefully shutting down`);
      if (_isDisposing) return;
      if (app.isReady()) {
        app.quit();
      } else {
        const code = sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 131;
        void beginShutdown(timeoutMs, `signal:${sig}`).finally(() => app.exit(code));
      }
    });
  }

  process.on('exit', (code) => {
    if (!_isDisposing) {
      log.warn(`process exit without lifecycle disposal code=${code}`);
    }
  });

  // ── Layer 3: main 进程未捕获异常 ────────────────────────────────────────
  // 不让 Electron 默认 dialog 接管; 走 disposer chain 把 IM offline / 子进程
  // SIGTERM 都发出去再 exit(1)。日志已经在 console.error 里了。
  process.on('uncaughtException', (err) => {
    if (isBrokenStdioError(err)) {
      disableDevTerminalMirror();
      if (!brokenStdioWarningLogged) {
        brokenStdioWarningLogged = true;
        log.warn('disabled dev terminal log mirror after broken stdio', err);
      }
      return;
    }
    // 瞬时网络错误 (ETIMEDOUT/ECONNRESET/ENOTFOUND 等) 不杀进程 —— 典型场景是
    // VPN 一断, main 进程后台某个漏 catch 的 fetch/TCP 抛错就把整个 App 崩掉,
    // 用户体验极差。降级成 log.error 留全栈, 后续从日志反查到调用点再补 try/catch。
    //
    // 同时广播一条 tip 到 renderer, renderer 自己 toast (带节流) 让用户感知到
    // "刚才网络抖了一下", 否则 App 表面看起来一切正常, 用户会困惑某些功能为啥不工作。
    if (isTransientNetworkError(err)) {
      log.error('ignored transient network error (no shutdown)', err);
      broadcastTransientNetworkErrorTip(err);
      return;
    }
    log.error('uncaughtException — shutting down', err);
    if (_isDisposing) return;
    void beginShutdown(timeoutMs, 'uncaughtException').finally(() => app.exit(1));
  });

  // unhandledRejection: 只记日志、不退出。悬空 Promise 不必然致命, 强退反而
  // 把一个能恢复的状态拖死。出问题时通过日志 / Sentry 上抓即可。
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection (continuing)', reason);
  });

  // ── Layer 4: renderer crashed (main alive) ──────────────────────────────
  // Main 还活着, 但 renderer 死了。继续让用户看一个空白窗没意义, 走 disposer
  // chain 把 IM offline / 子进程都收掉再 exit(1)。
  // 例外 1:意识沙箱(cindy-brain/runtime)的渲染进程"允许死"——崩溃隔离正是它的
  // 设计属性(docs/dev-rules/plugin-security-and-authoring.md),由 GhostRuntime 自己收尸/熔断,
  // 绝不能触发整个应用关机(实证:强崩沙箱曾把主界面一起带走)。
  // 例外 2:`<webview>` guest(内置浏览器等)的崩溃/OOM 只影响那一个 tab——
  // renderer 侧 useBrowserWebview 已有 crash banner + reload 恢复链路。此前
  // 这里不区分 guest,网页死递归吃满内存被 OOM kill 时会把整个 App 一起带走
  // (VS Code / Cursor 的边界都是 guest 崩溃不退 Workbench)。
  app.on('render-process-gone', (_event, webContents, details) => {
    if (isGhostSandboxWebContentsId(webContents.id)) {
      log.warn(
        `ghost sandbox render-process-gone (isolated, no shutdown): reason=${details.reason} exitCode=${details.exitCode}`,
      );
      return;
    }
    if (webContents.getType() === 'webview') {
      log.warn(
        `webview guest render-process-gone (isolated, no shutdown): reason=${details.reason} exitCode=${details.exitCode}`,
      );
      return;
    }
    log.error(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
    if (_isDisposing) return;
    void beginShutdown(timeoutMs, `render-process-gone:${details.reason}`).finally(() =>
      app.exit(1),
    );
  });

  // ── Layer 5: 其它子进程死亡 (GPU / utility / shared worker …) —— 只记日志 ──
  // GPU 崩溃 Chromium 会自行重启 GPU 进程,utility 崩溃影响面局部,都不值得
  // 整个 app 退出;但此前这些事件完全无日志,「app 卡死/白屏前发生过什么」
  // 无从追溯 (issue #758)。clean-exit / killed 是正常回收,降级 info。
  app.on('child-process-gone', (_event, details) => {
    const desc =
      `child-process-gone: type=${details.type} reason=${details.reason} ` +
      `exitCode=${details.exitCode ?? '?'}` +
      (details.name ? ` name=${details.name}` : '') +
      (details.serviceName ? ` serviceName=${details.serviceName}` : '');
    if (details.reason === 'clean-exit' || details.reason === 'killed') {
      log.info(desc);
    } else {
      log.error(desc);
    }
  });

  // 真硬崩 (segfault / kill -9) JS 层无能为力 —— 子进程靠 stdin EOF 检测父进程
  // 死亡然后自死 (Codex Rust app-server 的 lines.next_line() 收 None 退出循环)。
  // 硬崩的事后追责由 startup-diagnostics 的 run marker 在下次启动时完成。
}
