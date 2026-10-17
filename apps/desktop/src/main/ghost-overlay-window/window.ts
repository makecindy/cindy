/**
 * createGhostOverlayWindow —— 桌面浮窗(ghost overlay window)的 BrowserWindow 工厂。
 *
 * 蓝本是 session-drag-preview.ts 的透明置顶窗口,加上 ghost-panel-window 的
 * 按 ghostId 多实例与显式全量安全字段:
 *  - 形态参数为 2026-10-15 spike 实机验证过的冻结值(透明、无边框、不可交互
 *    拖拽、默认穿透、floating 置顶);
 *  - 尺寸缺省 GHOST_OVERLAY_DEFAULT_SIZE(128),边界 32–512 已由 Task 2 校验,
 *    工厂直接用 decl 的显式值或默认值;
 *  - webPreferences 按 electron-security-and-process-boundaries §3 逐项写明,
 *    不吃默认值;
 *  - 承载路线首选直载 cindy-ghost://<ghostId>/<decl.html>,加载前先
 *    ensureProtocolRegistered(依赖注入,bootstrap 接线属 Task 7)。
 *
 * 分区不在此处计算:浮窗 session 必须与 cindy-ghost:// 协议 handler 注册所在
 * session **逐字一致**(owner-scoped + namespace 作用域 + approval receipt),
 * 该解析函数由 Task 7 接线方与协议注册共用同一实现注入,工厂只透传注入值。
 */

import { BrowserWindow, app } from 'electron';

import {
  GHOST_SCHEME,
  GHOST_OVERLAY_DEFAULT_SIZE,
  type GhostOverlayDecl,
} from '../../shared/ghost.js';
import type { Logger } from '../logger.js';
import {
  clearGhostOverlayWebContents,
  markGhostOverlayWebContentsId,
} from './registry.js';

export interface GhostOverlayWindowDeps {
  /** 确保该意识分区上的 cindy-ghost:// 协议 handler 就位(幂等)。 */
  ensureProtocolRegistered: (ghostId: string) => Promise<void>;
  /**
   * 解析浮窗所属的 owner-scoped session 分区字符串(与 cindy-ghost:// 协议
   * handler 注册同源,含 namespace 作用域与 approval receipt);null = 当前
   * 不可用(未安装 / 无 active owner)。
   */
  resolveGhostOverlaySession: (ghostId: string) => string | null;
  /**
   * 解析浮窗 URL host 用的 manifest id。协议 handler 只认 manifest id
   * (electronSandboxAdapter.registerGhostProtocol 的 selfPrefix 与 host 断言),
   * storage part 与 manifest id 可能不同(例如命名空间实例)。
   */
  resolveManifestId: (ghostId: string) => string | null;
  /**
   * 窗口构造完成、loadURL 之前回调:让 controller 立即登记"加载中"slot,
   * 首次加载期间的窗口可被回收,不再等 loadURL resolve 才入 slots。
   */
  onWindowCreated?: (win: BrowserWindow) => void;
  log: Logger;
}

/**
 * 工厂返回值:窗口 + 首次加载完成信号。
 *
 * controller 依据 loadCompleted 确定性直推双阶段就绪(不再探测
 * webContents.isLoading(),实机证明 loadURL resolve 后该值不可靠)。
 */
export interface GhostOverlayWindowHandle {
  win: BrowserWindow;
  /** 首次 loadURL 是否已在工厂返回前完成(dom-ready/did-finish-load 已发生)。 */
  loadCompleted: boolean;
}

/**
 * 首次 loadURL 的硬上限:插件页脚本卡死/资源永不来时,loadURL 可能永不 resolve,
 * mount 不能永久悬挂。超时即销毁窗口 + 清理 registry + reject,后续 mount 可重试。
 */
export const GHOST_OVERLAY_FIRST_LOAD_TIMEOUT_MS = 10_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 创建一段意识的桌面浮窗。
 *
 * @returns 已创建窗口及首次加载完成信号(display 时机由 controller 控制)。
 */
export async function createGhostOverlayWindow(
  ghostId: string,
  decl: GhostOverlayDecl,
  deps: GhostOverlayWindowDeps,
): Promise<GhostOverlayWindowHandle> {
  const { ensureProtocolRegistered, resolveGhostOverlaySession, resolveManifestId, log } =
    deps;
  const width = decl.width ?? GHOST_OVERLAY_DEFAULT_SIZE;
  const height = decl.height ?? GHOST_OVERLAY_DEFAULT_SIZE;

  // 分区由注入方解析:必须与协议 handler 注册 session 逐字一致。
  const partition = resolveGhostOverlaySession(ghostId);
  if (!partition) {
    throw new Error(`ghost overlay session unavailable for ${ghostId}`);
  }

  // URL host 一律用 manifest id(协议 handler 只认 manifest id);窗口其余身份
  // (分区、registry 绑定、controller slot key、IPC sender 校验)保持 storage part。
  const manifestId = resolveManifestId(ghostId);
  if (!manifestId) {
    throw new Error(`ghost overlay manifest id unavailable for ${ghostId}`);
  }

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    webPreferences: {
      partition,
      // 安全规则 §3 全量显式项(新建窗口不吃默认值,逐项写明):
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
      spellcheck: false,
      // packaged 版关掉浮窗 devTools;dev 保留便于排查示例意识。
      devTools: !app.isPackaged,
    },
  });

  // 默认穿透:鼠标事件透传到浮窗下层,窗口自身不抢焦点。
  win.setIgnoreMouseEvents(true, { forward: true });
  // floating 层 + relativeLevel 1,保持置顶但低于系统级覆盖物。
  win.setAlwaysOnTop(true, 'floating', 1);
  // 未调用 setVisibleOnAllWorkspaces:Windows 上作用有限(无跨工作区置顶的可靠
  // 语义),设计计划允许"可选、若实测无效则省略并注释说明",故此处省略。

  // ── 守卫(设计 §4.7)────────────────────────────────────────────────
  // 浮窗零弹窗:一律 deny,不转外链(与 secondary-windows 的 shell.openExternal 不同)。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 导航限定在自己的 cindy-ghost://<manifestId>/ 内,越界一律掐断。
  const allowedPrefix = `${GHOST_SCHEME}://${manifestId}/`;
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedPrefix)) {
      event.preventDefault();
    }
  });
  // 权限请求全拒:浮窗是意识自绘页,不给通知 / 摄像头 / 定位等任何宿主权限。
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );

  const webContentsId = win.webContents.id;
  markGhostOverlayWebContentsId(webContentsId, ghostId);

  // 加载前登记:controller 经此回调立即登记"加载中"slot,首次加载期间的窗口
  // 即可被回收(5s 壳超时/崩溃恢复/owner 切换)。必须在任何 await 之前调用。
  deps.onWindowCreated?.(win);

  // 协议 handler 必须先于 loadURL 挂好,否则直载会 404 / 空响应。失败路径必须
  // 销毁窗口并清理 registry,否则留下 show:false + closable:false 的僵尸窗口。
  let stage: 'protocol' | 'load' = 'protocol';
  try {
    await ensureProtocolRegistered(ghostId);
    stage = 'load';
    await withTimeout(
      win.loadURL(`${GHOST_SCHEME}://${manifestId}/${decl.html}`),
      GHOST_OVERLAY_FIRST_LOAD_TIMEOUT_MS,
      `ghost overlay first load timed out after ${GHOST_OVERLAY_FIRST_LOAD_TIMEOUT_MS}ms`,
    );
  } catch (error) {
    // 清理使用创建期捕获的 id:窗口销毁后访问 webContents 不可靠(可能抛
    // 「Object has been destroyed」),届时会掩盖原始错误并留下 registry 僵尸条目。
    if (!win.isDestroyed()) win.destroy();
    clearGhostOverlayWebContents(webContentsId);
    throw new Error(`ghost overlay ${stage} failed for ${ghostId}`, { cause: error });
  }

  log.info('ghost overlay window created', { ghostId });
  return { win, loadCompleted: true };
}
