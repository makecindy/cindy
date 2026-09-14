/**
 * webview-security — RSB 内置浏览器 (web-browser plugin) 用的 `<webview>` 加固。
 *
 * 主窗 BrowserWindow 开启 `webPreferences.webviewTag: true` 后,renderer 才能用
 * `<webview src="...">` 嵌入 guest 页;但 webview 标签自身可以传任意 webPreferences
 * (`<webview disablewebsecurity webpreferences="..." preload="...">`)
 * 进来,如果不在 main 端拦截,恶意页面 / 第三方脚本 / 误配置可以把 nodeIntegration
 * 打开、把 sandbox 关掉、把 webSecurity 关掉,让 guest 页拿到 Node 上下文 + 跨域
 * 任意请求,等于把整个 desktop 进程暴露给网页。
 *
 * 加固策略:在 `will-attach-webview` 时把所有安全相关 prefs / params 强制覆盖为
 * 安全值,renderer 端写什么都覆盖掉。覆盖范围 = Electron 文档 + 社区 webview
 * hardening 最佳实践的并集(Codex desktop 实测同款字段)。
 *
 * 时序:必须在 `app.on('web-contents-created', ...)` 早期挂载 —— 主窗 / 任何子窗
 * 创建后第一次 attach webview 都要走 hardener。bootstrap 模块顶层 install 即可
 * (Electron 的 web-contents-created 在 app ready 前 listener 就有效,内部缓冲到
 * 真正 fire 时投递)。
 *
 * 测试:见 `__tests__/webview-security.test.ts` —— 模拟恶意 input(开关全开 +
 * 注入 preload + 改 partition),断言 hardener 输出全部锁死且 partition 强制成
 * BROWSER_PARTITION。
 */

import path from 'node:path';

import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron';

import {
  BROWSER_PARTITION,
  LOGIN_CAPTCHA_CANCEL_HASH,
  LOGIN_CAPTCHA_PAGE_PATH,
  LOGIN_CAPTCHA_PARTITION,
} from '../shared/webviewPartition';
import { GHOST_PARTITION_PREFIX } from '../shared/ghost';
import { getActiveAppSession, type AppSessionMode } from './appSessionState.js';
import {
  matchesElectronInput,
  type AppShortcutCombo,
  type AppShortcutId,
} from '../shared/appShortcuts';
import { getAppShortcutStore } from './app-shortcuts/index.js';
import {
  handleGhostExternalLinkNavigation,
  handleGhostPreviewNavigation,
  noteGhostUserGesture,
  resolveGhostWebviewAttach,
} from './cindy-brain/index.js';
import { classifyGhostPanelNavigation } from './cindy-brain/previewGate.js';
import { registerGhostWebContents } from './cindy-brain/runtime/electronSandboxAdapter.js';
import {
  attributeRsbNativePopupSurface,
  createRsbNativePopupSurface,
} from './rsb-browser-bridge/native-popup-surfaces.js';

/**
 * RSB 浏览器 webview 的 guest 注入层(页面评论 overlay)产物路径。
 *
 * forge 的 VitePlugin 把 `src/preload/browserCommentPreload.ts` 以 preload
 * target 打成 CJS 单文件,与 main bundle 同目录(dev = `<checkout>/.vite/build/`,
 * packaged = `app.asar/.vite/build/`),所以 `__dirname` 相对定位在两种形态下
 * 一致 —— 与 bootstrap-electron 里 `path.join(__dirname, 'preload.js')` 同款
 * 解析方式,不要改成任何相对 cwd / 硬编码的路径。
 */
export function getBrowserCommentPreloadPath(): string {
  return path.join(__dirname, 'browserCommentPreload.js');
}

/**
 * 把 `will-attach-webview` event 给的 webPreferences / params 改成"安全锁死"版。
 *
 * 抽成纯函数,既给真 listener 用,也给单测直接喂构造对象做断言。
 *
 * ── 字段对齐 ─────────────────────────────────────────────────────────────────
 * 本函数对齐 Codex desktop(openai-codex-electron v26.616.71553)`main-cC-d0ezP.js:49845`
 * 的 `tY` 函数(2026-07-01 反编译核对):同样的字段集合,同样的删除/赋值动作。
 * 区别只一处:preload 的处理。Codex tY 不动 webPreferences.preload(他们 IAB
 * 浏览器路径在 tY 之后会显式注入 preload);我们自页面评论功能起同样需要注入
 * guest 注入层,所以语义是「**强制覆写**为 main 指定的合法 preload」——
 * renderer 端 `<webview preload="...">` 写什么都不认(信任模型与 partition
 * 强制覆盖一致:main 是唯一权威)。不传 `options.commentPreloadPath` 时回落到
 * 旧行为 delete(等于 Codex eY 的 browser-settings 口径)。
 *
 * @param webPreferences Electron 给的 WebPreferences 对象引用,直接 mutate
 * @param params Electron 给的 webview attribute dict 引用,直接 mutate
 * @param options.commentPreloadPath 页面评论 guest 注入层的绝对路径;传入时强制覆写
 */
export function applyWebviewHardening(
  webPreferences: Record<string, unknown>,
  params: Record<string, string>,
  options?: { commentPreloadPath?: string },
): void {
  // ── params:`<webview>` tag attribute 的 dict 视图 ─────────────────────────
  // 两个攻击向量必删(Codex tY 同款):
  //   - disablewebsecurity → 跨域随意请求
  //   - webpreferences → 字符串形式 override 整套 webPreferences,绕过 host 锁定
  delete params.disablewebsecurity;
  delete params.webpreferences;
  // 允许 popup 请求进入 did-attach-webview 后安装的 setWindowOpenHandler。
  // handler 会统一 deny 真弹窗并转成 RSB web-browser 新 tab；如果这里不允许,
  // Chromium 可能在到达 handler 前直接吞掉 window.open / target=_blank,用户体感
  // 就是 TapTap 登录按钮一类入口"点了没反应"。
  params.allowpopups = 'true';
  // 强制覆盖 partition:即便 renderer 端没写 / 写错 / 被脚本改成别的,guest 最终
  // 也跑在我们指定的隔离 session 里(cookies / IDB / cache 单一来源)。Codex
  // 用 Tb('app') 映射拿 partition 字符串,我们用单一常量,实质等价。
  params.partition = BROWSER_PARTITION;

  // ── webPreferences:guest 页面的渲染环境 ────────────────────────────────────
  // 全部对齐 Codex tY(line 49849-49859):
  webPreferences.sandbox = true;
  webPreferences.devTools = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  webPreferences.plugins = false;
  // Keep Chromium dialogs enabled so Page.javascriptDialogOpening reaches the
  // controlled debugger observer. The backend turns them into structured
  // barriers instead of letting them silently bypass the automation contract.
  webPreferences.disableDialogs = false;
  // Codex 自定义字段(Electron 标准 WebPreferences 不认这个 key,Electron 会
  // 忽略;但 Codex 在 IPC 层 / fork 的 Electron 可能消费它)。我们一并设上保持
  // 字面 1:1,即便 Electron 标准侧 no-op 也无害。
  webPreferences.disablePopups = false;
  // preload:renderer 端 `<webview preload="...">` 一律不信 —— 有合法注入层
  // (页面评论 overlay)时强制覆写成 main 指定路径,没有时显式 delete。两个
  // 分支都保证「webPreferences.preload 只可能是 main 的值或不存在」。
  if (options?.commentPreloadPath) {
    webPreferences.preload = options.commentPreloadPath;
  } else {
    delete webPreferences.preload;
  }
}

/**
 * 意识面板 webview 的加固(docs/dev-rules/plugin-security-and-authoring.md):与浏览器 webview
 * 同一套安全锁,区别两处——
 *   1. **保留意识专属分区**(浏览器路径是强制覆盖为 BROWSER_PARTITION;意识
 *      路径的分区已在 will-attach 阶段经 resolveGhostWebviewAttach 验明正身);
 *   2. **不允许 popup**(浏览器 guest 需要 window.open 路由成新 tab;意识面板
 *      没有任何弹窗需求,直接掐死)。
 * 纯函数,单测直接喂恶意输入断言。
 */
export function applyGhostWebviewHardening(
  webPreferences: Record<string, unknown>,
  params: Record<string, string>,
): void {
  delete params.disablewebsecurity;
  delete params.webpreferences;
  delete params.allowpopups;
  // 分区不动:调用方(will-attach listener)已验证过 partition ↔ src ↔ 已装意识。

  webPreferences.sandbox = true;
  webPreferences.devTools = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  webPreferences.plugins = false;
  delete webPreferences.preload;
}

type GhostWebviewAttachResolver = typeof resolveGhostWebviewAttach;

/**
 * 把 Renderer 的 ghost-only claim 换成 Main 已核准的 owner partition，并同步
 * 应用插件 WebView 安全锁。返回 null 时调用方必须拒绝 attach。
 */
export function authorizeGhostWebviewAttach(
  webPreferences: Record<string, unknown>,
  params: Record<string, string>,
  resolver: GhostWebviewAttachResolver = resolveGhostWebviewAttach,
): { id: string; owner: { mode: AppSessionMode; dataOwnerId: string } } | null {
  let resolved: ReturnType<GhostWebviewAttachResolver> = null;
  try {
    resolved = resolver(params.partition, params.src);
  } catch {
    // session/protocol 注册失败也必须 fail closed。
  }
  if (!resolved) return null;

  // Electron 在触发 will-attach-webview 前已经把 params.partition 复制进
  // webPreferences.partition，之后创建 guest 时读取的是后者。两边都必须由
  // Main 的核准结果覆盖，否则只改 attribute dict 不会改变真实 session。
  params.partition = resolved.partition;
  webPreferences.partition = resolved.partition;
  applyGhostWebviewHardening(webPreferences, params);
  return { id: resolved.ghost.manifest.id, owner: resolved.owner };
}

/**
 * 登录页人机验证(Turnstile 托管挑战页)webview 的加固:与意识面板同一套锁死集——
 * 零弹窗、零 preload、保留调用方已验证的专属内存分区。挑战页是我们自己的
 * auth-server 托管页,token 回传只靠 location.hash(did-navigate-in-page),
 * 不需要任何注入面。
 */
export function applyLoginCaptchaWebviewHardening(
  webPreferences: Record<string, unknown>,
  params: Record<string, string>,
): void {
  delete params.disablewebsecurity;
  delete params.webpreferences;
  delete params.allowpopups;
  // 分区不动:调用方(will-attach listener)已验证过 partition ↔ src。

  webPreferences.sandbox = true;
  webPreferences.devTools = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  webPreferences.plugins = false;
  delete webPreferences.preload;
}

/**
 * CAPTCHA guest 使用独立 session，但 session 默认安全策略不能依赖 Electron
 * 版本的隐式行为。挑战只需要网络、脚本与 iframe，不需要任何设备/系统权限，
 * 也不应向本机写入下载，因此权限与下载通道都显式 fail-closed。
 */
const hardenedLoginCaptchaSessions = new WeakSet<object>();

export function hardenLoginCaptchaSession(
  captchaSession: Pick<
    Session,
    'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'on'
  >,
): void {
  // partition session 会跨多次挑战复用；不要为每次 webview attach 累加监听器。
  if (hardenedLoginCaptchaSessions.has(captchaSession)) return;
  captchaSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  captchaSession.setPermissionCheckHandler(() => false);
  captchaSession.on('will-download', (event) => {
    event.preventDefault();
  });
  hardenedLoginCaptchaSessions.add(captchaSession);
}

/**
 * 登录 captcha webview 允许加载的 auth 服务端 origin 集合的解析钩子。
 * 与 popupOpenerResolver 同模式注入(保持本模块单向解耦):bootstrap 在 auth
 * 初始化处用 clientEndpointsService 的 authApiBaseUrl(两 realm + dev)接线。
 * 未注入(启动早期 / 单测未接线)时 fail-closed:一律拒附加。
 */
export type LoginCaptchaOriginResolver = () => readonly string[];

let loginCaptchaOriginResolver: LoginCaptchaOriginResolver | null = null;

export function setLoginCaptchaOriginResolver(
  resolver: LoginCaptchaOriginResolver | null,
): void {
  loginCaptchaOriginResolver = resolver;
}

/**
 * captcha webview 的附加与顶层导航白名单:协议(https,或 loopback 上的 http,
 * 兼容本地 dev auth-server)+ origin 命中注入集合 + 路径精确等于托管挑战页。
 * fragment 变更(token 回传通道)不产生导航事件,天然不受本闸约束。
 */
export function isAllowedLoginCaptchaUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl || !loginCaptchaOriginResolver) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return false;
  }
  if (parsed.pathname !== LOGIN_CAPTCHA_PAGE_PATH) return false;
  let origins: readonly string[];
  try {
    origins = loginCaptchaOriginResolver();
  } catch {
    return false;
  }
  return origins.includes(parsed.origin);
}

/** CAPTCHA guest 的 popup 与顶层导航闸；重定向和普通导航必须走同一白名单。 */
export function installLoginCaptchaGuestHandlers(guestContents: WebContents): void {
  guestContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardTopLevelNavigation = (event: Electron.Event, url: string) => {
    if (isAllowedLoginCaptchaUrl(url)) return;
    event.preventDefault();
  };
  guestContents.on('will-navigate', guardTopLevelNavigation);
  guestContents.on('will-redirect', guardTopLevelNavigation);
  // guest 获得焦点后键盘事件不会冒泡到宿主 Renderer。Main 只拦 Esc，并通过
  // 静态 location.hash 复用既有无日志回传通道，让模态层仍可被键盘取消。
  guestContents.on('before-input-event', (event, input) => {
    if (!isGuestShortcutKeyDownType(input.type) || input.key !== 'Escape') return;
    event.preventDefault();
    void guestContents
      .executeJavaScript(`location.hash = ${JSON.stringify(LOGIN_CAPTCHA_CANCEL_HASH)}`, true)
      .catch(() => undefined);
  });
}

/** Renderer 接收 popup 路由消息的 IPC channel。main → renderer。 */
export const RSB_BROWSER_POPUP_CHANNEL = 'rsb:browser-popup';
/** Renderer 接收"webview 内按了 Cmd/Ctrl+L"的 IPC channel。main → renderer。
 *  对齐 Codex `main-cC-d0ezP.js:48846` 监听 before-input-event 的设计 —— 把
 *  webview guest 内的浏览器级快捷键路由回 host chrome 接管。 */
export const RSB_BROWSER_FOCUS_URL_BAR_CHANNEL = 'rsb:browser-focus-url-bar';
/** Renderer 接收 webview guest 内浏览器级导航快捷键。main → renderer。 */
export const RSB_BROWSER_COMMAND_CHANNEL = 'rsb:browser-command';

/** RSB_BROWSER_COMMAND_CHANNEL 的 payload.command 联合。'close-tab' = guest 内
 *  按下 ⌘W / Ctrl+W ('close-tab-or-window'), active 的 BrowserTabBody 关掉自己
 *  这个 tab —— 与焦点在 host 侧右侧栏内按 ⌘W 关激活 tab 的行为对齐。
 *  'right-tab-prev/next' = guest 内按右侧栏 tab 切换键时,由 Shell 按 tab strip
 *  顺序循环激活相邻 tab。 */
export type RsbBrowserCommand =
  | 'go-back'
  | 'go-forward'
  | 'reload'
  | 'close-tab'
  | 'right-tab-prev'
  | 'right-tab-next';

/** guest before-input-event 命中后的动作。 */
export type RsbGuestShortcutAction =
  | { kind: 'focus-url-bar' }
  | { kind: 'command'; command: RsbBrowserCommand };

interface GuestKeyInput {
  code?: string;
  key?: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

const GUEST_KEY_ALIASES_BY_CODE: Partial<Record<string, readonly string[]>> = {
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  PageUp: ['PageUp'],
  PageDown: ['PageDown'],
  Tab: ['Tab'],
};

/** 按键 → 动作的顺序表。数组顺序即匹配优先级: close-tab-or-window 必须排在
 *  浏览器动作之前 —— 它不可改绑, 而 browser-* 系列可改绑, 存量用户可能在本
 *  版本之前就把某个浏览器动作 override 到 Ctrl+W (load 归一化不清洗历史冲突,
 *  冲突只在新写入时校验)。撞键时保留键 (mod+W) 的关 tab 语义必须胜出, 否则
 *  guest 内 Ctrl+W 会变成 reload / 导航而不是关 tab。 */
const GUEST_SHORTCUT_ACTIONS: ReadonlyArray<{
  id: AppShortcutId;
  action: RsbGuestShortcutAction;
}> = [
  { id: 'close-tab-or-window', action: { kind: 'command', command: 'close-tab' } },
  { id: 'right-tab-prev', action: { kind: 'command', command: 'right-tab-prev' } },
  { id: 'right-tab-next', action: { kind: 'command', command: 'right-tab-next' } },
  { id: 'browser-focus-url', action: { kind: 'focus-url-bar' } },
  { id: 'browser-back', action: { kind: 'command', command: 'go-back' } },
  { id: 'browser-forward', action: { kind: 'command', command: 'go-forward' } },
  { id: 'browser-reload', action: { kind: 'command', command: 'reload' } },
];

/**
 * webview guest 内一次 keyDown 应触发的 host 动作;不命中返回 null。
 * 抽成纯函数供单测直接喂 input + combos 断言 (getCombos 由调用方注入,
 * 生产路径来自 app-shortcuts store 的实时生效值)。
 */
export function resolveGuestShortcutAction(
  input: GuestKeyInput,
  getCombos: (id: AppShortcutId) => AppShortcutCombo[],
): RsbGuestShortcutAction | null {
  for (const entry of GUEST_SHORTCUT_ACTIONS) {
    if (getCombos(entry.id).some((c) => matchesGuestShortcutInput(input, c))) {
      return entry.action;
    }
  }
  return null;
}

export function isGuestShortcutKeyDownType(type: unknown): boolean {
  return type === 'keyDown' || type === 'rawKeyDown';
}

function matchesGuestShortcutInput(input: GuestKeyInput, combo: AppShortcutCombo): boolean {
  if (
    matchesElectronInput(
      {
        code: input.code ?? '',
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
      },
      combo,
    )
  ) {
    return true;
  }
  const aliases = GUEST_KEY_ALIASES_BY_CODE[combo.code];
  if (!aliases?.includes(input.key ?? '')) return false;
  return (
    input.meta === combo.meta &&
    input.control === combo.ctrl &&
    input.alt === combo.alt &&
    input.shift === combo.shift
  );
}

/** 隐藏 about:blank popup 等待真实 URL 的最长时间。超过后关闭,避免泄漏窗口。 */
export const DEFERRED_POPUP_ROUTE_TIMEOUT_MS = 10_000;

export interface RsbBrowserPopupPayload {
  /** popup 目标 URL(`window.open(url)` / `<a target="_blank" href>` / window.location 跨 host)。 */
  url: string;
  /** Chromium disposition:foreground-tab / background-tab / new-window / other 等。
   *  v1 不做差异化处理(都开新 RSB tab),但保留给后续 background-tab 等区分行为用。 */
  disposition: string;
  /** 发起 popup 的 RSB tab id(TabRegistry 按 guest webContentsId 反查)。
   *  guest 尚未 report(dom-ready 前)或非 RSB 管辖 webview 时缺省。 */
  openerTabId?: string;
  /** 发起 popup 的 tab 所属 session。renderer 端据此把 popup tab 落进 opener 的
   *  bucket——没有它时只能落在"用户正在看的 session",agent 后台 session 触发的
   *  popup 会串进无关会话。 */
  openerSessionId?: string;
  /** Main-owned WebContentsView surface that preserves the popup browsing context. */
  nativePopupSurfaceId?: string;
}

/**
 * popup opener 反查钩子。webview-security 不直接依赖 rsb-browser-bridge 单例
 * (保持本模块只做安全加固的单向依赖);bootstrap 在注册 RSB bridge IPC 时注入。
 * 未注入(启动早期 / 单测)时 popup 照常路由,只是缺 opener 归属字段。
 */
export type RsbPopupOpenerResolver = (
  webContentsId: number,
) => { tabId: string; sessionId: string } | null;

let popupOpenerResolver: RsbPopupOpenerResolver | null = null;

export function setRsbPopupOpenerResolver(resolver: RsbPopupOpenerResolver | null): void {
  popupOpenerResolver = resolver;
}

interface ResolvedPopupOpener {
  openerTabId: string;
  openerSessionId: string;
}

function resolvePopupOpener(webContentsId: number): ResolvedPopupOpener | null {
  if (!popupOpenerResolver) return null;
  try {
    const record = popupOpenerResolver(webContentsId);
    if (!record) return null;
    return { openerTabId: record.tabId, openerSessionId: record.sessionId };
  } catch {
    return null;
  }
}

/**
 * 反查落空时的有界等待:renderer 的 report 与 guest 的 window.open 是两条不同
 * sender 的 IPC,到达 main 的顺序没有硬保证。renderer 已在 `did-attach`(导航
 * 提交前)就上报,但那条 report 可能还在途,而 guest 页面 head 里的同步脚本已经
 * 调了 `window.open()` —— 此刻同步反查必然落空,payload 缺 openerSessionId,
 * popup 就会落进"用户正在看的 session"。
 *
 * 所以 main 侧不能"尽力反查一次就发":反查落空时把 popup 的路由推迟到 registry
 * 收到该 guest 的记录(或超时)之后。等待只发生在落空分支,命中时零延迟。
 *
 * 等待模型分两档:
 *  - **事件驱动**(bootstrap 注入了 report 订阅钩子,生产路径):report 落地的
 *    瞬间完成反查,不赌固定窗口;超时只兜"report 永不来"(opener 在上报前就被
 *    销毁等),可以放得很宽 —— 5s 后仍无归属才降级为无归属路由(落当前 session,
 *    与本修复之前的行为一致)。
 *  - **轮询兜底**(订阅钩子未注入:启动早期 / 单测):保持原有 25ms × 1s 短轮询。
 */
export const POPUP_OPENER_WAIT_TIMEOUT_MS = 1_000;
export const POPUP_OPENER_EVENT_WAIT_TIMEOUT_MS = 5_000;
const POPUP_OPENER_WAIT_INTERVAL_MS = 25;

/**
 * report 到达事件的订阅钩子(与 popupOpenerResolver 同模式注入,保持本模块对
 * rsb-browser-bridge 的单向解耦)。回调参数是该条 report 的 webContentsId。
 */
export type RsbPopupOpenerReportSubscriber = (
  listener: (webContentsId: number) => void,
) => () => void;

let popupOpenerReportSubscriber: RsbPopupOpenerReportSubscriber | null = null;

export function setRsbPopupOpenerReportSubscriber(
  subscriber: RsbPopupOpenerReportSubscriber | null,
): void {
  popupOpenerReportSubscriber = subscriber;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitForPopupOpener(webContentsId: number): Promise<ResolvedPopupOpener | null> {
  const subscribe = popupOpenerReportSubscriber;
  if (!subscribe) {
    // 轮询兜底档(无事件源可订阅)。
    const deadline = Date.now() + POPUP_OPENER_WAIT_TIMEOUT_MS;
    for (;;) {
      const opener = resolvePopupOpener(webContentsId);
      if (opener) return opener;
      if (Date.now() >= deadline) return null;
      await delay(POPUP_OPENER_WAIT_INTERVAL_MS);
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      finish(resolvePopupOpener(webContentsId));
    }, POPUP_OPENER_EVENT_WAIT_TIMEOUT_MS);
    timer.unref?.();
    const finish = (value: ResolvedPopupOpener | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub?.();
      resolve(value);
    };
    // subscribe 是外部注入的钩子:它抛错会让 Promise executor 抛 → promise
    // reject → 调用方的 `void promise.then(...)` 变 unhandled rejection,popup
    // 路由静默中断。防御性兜住:订阅失败就退化为"纯超时兜底"档,路由不中断。
    try {
      unsub = subscribe((reportedId) => {
        if (reportedId !== webContentsId) return;
        finish(resolvePopupOpener(webContentsId));
      });
    } catch {
      unsub = null;
    }
    // 订阅建立后再同步查一次,堵"report 在建立订阅之前恰好落地"的竞态窗。
    const now = resolvePopupOpener(webContentsId);
    if (now) finish(now);
  });
}

/**
 * 把一个 popup 路由给 host renderer,尽最大努力带上 opener 归属。
 *
 * `openerWebContentsId` 缺省或反查钩子未注入(启动早期 / 单测)时同步直发 ——
 * 没有可等的东西,等待只会白白延迟 popup。命中同步反查也直发。只有"钩子在、
 * 但这个 guest 还没进 registry"这一种情况才走有界等待(见上方注释)。
 */
function routeBrowserPopup(
  hostContents: WebContents,
  openerWebContentsId: number | undefined,
  payload: RsbBrowserPopupPayload,
): void {
  const finish = (opener: ResolvedPopupOpener | null) => {
    if (payload.nativePopupSurfaceId && opener) {
      attributeRsbNativePopupSurface(payload.nativePopupSurfaceId, {
        tabId: opener.openerTabId,
      });
    }
    sendBrowserPopup(hostContents, { ...payload, ...(opener ?? {}) });
  };
  if (openerWebContentsId === undefined || !popupOpenerResolver) {
    finish(null);
    return;
  }
  const opener = resolvePopupOpener(openerWebContentsId);
  if (opener) {
    finish(opener);
    return;
  }
  void waitForPopupOpener(openerWebContentsId).then((late) => {
    finish(late);
  });
}

/**
 * Chromium child popup 的完整安全集。Electron 用这些偏好创建传给
 * `createWindow` 的真实 popup WebContents；main 随后把同一个 context 放进
 * WebContentsView。字段对齐 BrowserWindow 安全契约，导出供单测钉住。
 */
export const BLANK_POPUP_WINDOW_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  devTools: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  plugins: false,
  disableDialogs: false,
  navigateOnDragDrop: false,
  partition: BROWSER_PARTITION,
  webviewTag: false,
} as const);

function isInitialBlankPopupUrl(url: string): boolean {
  return url === 'about:blank' || url === 'about:blank#blocked';
}

function isRoutablePopupUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * popup 路由目标 host 的动态解析钩子(bootstrap 注入 rsbWindowController 的
 * getHostWebContents,与 tab-op bridge 同一来源)。popup 路由可能经过异步等待
 * (归属反查 / deferred URL 捕获),期间用户 detach 侧边栏或切换视图会让捕获时的
 * hostContents 过时 —— 旧 renderer 的 Shell 已退订,fanOut 不缓冲,消息发过去
 * 就是丢弃。发送时刻动态解析当前 host 才能落到活着的订阅者。
 */
let popupHostResolver: (() => WebContents | null) | null = null;

export function setRsbPopupHostResolver(resolver: (() => WebContents | null) | null): void {
  popupHostResolver = resolver;
}

function sendBrowserPopup(
  hostContents: WebContents,
  payload: RsbBrowserPopupPayload,
): void {
  // 优先发给"当前"host(detach / 视图切换后是新 renderer);解析失败或未注入
  // (启动早期 / 单测)回落到调用方捕获的 hostContents。
  let current: WebContents | null = null;
  if (popupHostResolver) {
    try {
      current = popupHostResolver();
    } catch {
      current = null;
    }
  }
  const target = current && !current.isDestroyed() ? current : hostContents;
  if (target.isDestroyed()) return;
  target.send(RSB_BROWSER_POPUP_CHANNEL, payload);
}

/**
 * @param openerWebContentsId 发起 popup 的 guest webContentsId。归属反查在
 *   popup 创建时立即发起,不推迟到真实 URL 出现时——这样即使 opener tab 在
 *   about:blank → 真实 URL 期间被关闭, release 发生前的归属信息已被捕获,
 *   不会回退到当前活跃会话。缺省则照常路由、只是没有 opener 归属字段。
 */
export function installDeferredPopupRouter(
  hostContents: WebContents,
  popupWindow: BrowserWindow,
  disposition: string,
  openerWebContentsId?: number,
): void {
  let routed = false;

  // 在 popup 创建时就发起 opener 反查。resolver 未就绪（启动早期/单测）或
  // openerWebContentsId 缺省时不启动轮询，沿用同步直发路径。
  const openerAttrPromise: Promise<ResolvedPopupOpener | null> | null =
    openerWebContentsId !== undefined && popupOpenerResolver !== null
      ? waitForPopupOpener(openerWebContentsId)
      : null;

  const closeTimer = setTimeout(() => {
    if (routed || popupWindow.isDestroyed()) return;
    popupWindow.close();
  }, DEFERRED_POPUP_ROUTE_TIMEOUT_MS);
  closeTimer.unref?.();

  const cleanup = () => clearTimeout(closeTimer);
  popupWindow.once('closed', cleanup);

  const route = (url: string) => {
    if (routed || !isRoutablePopupUrl(url)) return;
    routed = true;
    cleanup();
    if (!popupWindow.isDestroyed()) {
      popupWindow.close();
    }
    if (openerAttrPromise !== null) {
      void openerAttrPromise.then((opener) => {
        sendBrowserPopup(hostContents, { url, disposition, ...(opener ?? {}) });
      });
    } else {
      sendBrowserPopup(hostContents, { url, disposition });
    }
  };

  const childContents = popupWindow.webContents;
  childContents.on('will-navigate', (_event, url) => route(url));
  childContents.on('did-navigate', (_event, url) => route(url));
  childContents.on('did-redirect-navigation', (_event, url) => route(url));
  childContents.setWindowOpenHandler((details) => {
    if (isRoutablePopupUrl(details.url)) {
      route(details.url);
    }
    return { action: 'deny' };
  });
}

/**
 * 全局挂载 hardener:监听所有 webContents 的 `will-attach-webview` + `did-attach-webview`。
 * 模块入口(bootstrap-electron)在 app ready 前调一次即可,所有现在 / 未来创建的窗口
 * 都生效。
 *
 * setWindowOpenHandler 路由策略:
 *   - http(s) 与 about:blank popup 都让 Chromium 创建真实 child WebContents;
 *   - `createWindow` 接管 Electron 预创建的 `options.webContents`,把**同一个**
 *     browsing context 放进 main-owned WebContentsView,再路由成 RSB tab;
 *   - 不能另建 `<webview>`:那会让 opener 手里的 WindowProxy 指向已关闭的旧
 *     context,破坏 OAuth/SSO 对 closed/location/close 的依赖。
 *   - 推消息走 channel `rsb:browser-popup`,renderer 端通过 preload 的 fanOut 订阅。
 *
 * 这里 `contents` 闭包指向 host webContents(主窗 renderer),`guestContents` 是
 * webview 内的 guest。setWindowOpenHandler 挂在 guest 上(window.open 在 guest
 * 触发),但回调里用 host 的 contents.send 发消息——renderer 端收到的就是主窗 renderer
 * 进程。
 */
export function installBrowserGuestHandlers(
  hostContents: WebContents,
  guestContents: WebContents,
): void {
  guestContents.setWindowOpenHandler((details) => {
    if (!isRoutablePopupUrl(details.url) && !isInitialBlankPopupUrl(details.url)) {
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        show: false,
        autoHideMenuBar: true,
        webPreferences: { ...BLANK_POPUP_WINDOW_WEB_PREFERENCES },
      },
      createWindow: (options) => {
        // Electron supplies this runtime-only field when createWindow is used
        // to adopt Chromium's already-created popup browsing context. It is
        // intentionally absent from BrowserWindowConstructorOptions.d.ts.
        const popupContents = (
          options as typeof options & { webContents?: WebContents }
        ).webContents;
        if (!popupContents) {
          throw new Error('Electron did not provide popup WebContents to createWindow');
        }
        const surfaceId = createRsbNativePopupSurface(hostContents, popupContents);
        if (!surfaceId) {
          popupContents.close();
          return popupContents;
        }
        // Popup-of-popup keeps the same security and WindowProxy semantics.
        installBrowserGuestHandlers(hostContents, popupContents);
        routeBrowserPopup(hostContents, guestContents.id, {
          url: details.url,
          disposition: details.disposition,
          nativePopupSurfaceId: surfaceId,
        });
        return popupContents;
      },
    };
  });

  // Chromium guest key events do not bubble to the host renderer. Forward the
  // browser-level shortcuts through the existing host channel for both
  // ordinary webviews and adopted popup WebContents.
  guestContents.on('before-input-event', (event, input) => {
    if (!isGuestShortcutKeyDownType(input.type)) return;
    const store = getAppShortcutStore();
    const action = resolveGuestShortcutAction(input, (id) =>
      store.getEffectiveCombos(id),
    );
    if (!action) return;
    event.preventDefault();
    let target: WebContents | null = null;
    try {
      target = popupHostResolver?.() ?? null;
    } catch {
      target = null;
    }
    target = target && !target.isDestroyed() ? target : hostContents;
    if (target.isDestroyed()) return;
    if (action.kind === 'focus-url-bar') {
      target.send(RSB_BROWSER_FOCUS_URL_BAR_CHANNEL, null);
    } else {
      target.send(RSB_BROWSER_COMMAND_CHANNEL, { command: action.command });
    }
  });
}

interface GhostGuestNavigationHandlers {
  gesture?: typeof noteGhostUserGesture;
  preview: typeof handleGhostPreviewNavigation;
  external: typeof handleGhostExternalLinkNavigation;
}

interface GhostGuestOwnerIdentity {
  mode: AppSessionMode;
  dataOwnerId: string;
}

function isGhostGuestOwnerActive(owner: GhostGuestOwnerIdentity): boolean {
  const activeOwner = getActiveAppSession();
  return activeOwner.mode === owner.mode && activeOwner.dataOwnerId === owner.dataOwnerId;
}

/**
 * settingsHtml 与 panel 共用的 Ghost guest 导航接线。策略仍集中在
 * previewGate / cindy-brain；这里仅保证普通 will-navigate 被主机接管，
 * popup 路径继续一律拒绝，并把 did-attach 时的真实 hostContents 原样传入。
 */
export function installGhostGuestNavigationHandlers(
  hostContents: WebContents,
  guestContents: WebContents,
  ghostId: string,
  isOwnerActive: () => boolean,
  handlers: GhostGuestNavigationHandlers = {
    preview: handleGhostPreviewNavigation,
    external: handleGhostExternalLinkNavigation,
  },
): void {
  guestContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const noteGesture = () => {
    if (!isOwnerActive()) return;
    (handlers.gesture ?? noteGhostUserGesture)(ghostId);
  };
  guestContents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') noteGesture();
  });
  guestContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') noteGesture();
  });
  guestContents.on('will-navigate', (event, url) => {
    // owner commit 后、Renderer 卸载旧 guest 前仍可能收到导航事件。旧页
    // 不能借新 owner 的同名插件声明或授权代开外链。
    if (!isOwnerActive()) {
      event.preventDefault();
      return;
    }
    const nav = classifyGhostPanelNavigation(url, ghostId);
    if (nav === 'allow') return;
    event.preventDefault();
    if (nav === 'preview') {
      handlers.preview(ghostId, url, hostContents, guestContents, isOwnerActive);
    } else if (nav === 'external') {
      handlers.external(ghostId, url, hostContents, guestContents, isOwnerActive);
    }
  });
}

export function installWebviewHardener(): void {
  app.on('web-contents-created', (_event, contents) => {
    // will-attach → did-attach 对同一个 guest 同步成对触发;用闭包变量把
    // will 阶段的意识/captcha 判定带给 did 阶段(这两类 guest 走独立接线,
    // 不装浏览器的 popup 路由与快捷键转发)。
    let pendingGhostAttach: ReturnType<typeof authorizeGhostWebviewAttach> = null;
    let pendingCaptchaAttach = false;
    contents.on('will-attach-webview', (e, webPreferences, params) => {
      pendingCaptchaAttach = false;
      // 意识面板分支:声明了意识分区的 webview 必须验明正身——
      // 分区/地址/已装清单三对齐才放行并保留专属分区;验证失败直接拒附加
      // (绝不回落到浏览器分区,那会让 cindy-ghost:// 内容跑进错误 session)。
      if (typeof params.partition === 'string' && params.partition.startsWith(GHOST_PARTITION_PREFIX)) {
        const authorized = authorizeGhostWebviewAttach(
          webPreferences as unknown as Record<string, unknown>,
          params,
        );
        if (!authorized) {
          e.preventDefault();
          pendingGhostAttach = null;
          return;
        }
        pendingGhostAttach = authorized;
        return;
      }
      pendingGhostAttach = null;
      // 登录 captcha 分支:同意识分区一样"验明正身否则拒附加",绝不回落到
      // 浏览器分区(那会把挑战页装进 RSB 持久 session 并注入页面评论 preload)。
      // src 必须命中 auth origin 白名单 + 托管页固定路径(fail-closed)。
      if (params.partition === LOGIN_CAPTCHA_PARTITION) {
        if (!isAllowedLoginCaptchaUrl(params.src)) {
          e.preventDefault();
          return;
        }
        try {
          // 在 guest 获准附加前先锁死专属 session 的权限请求与权限检查；
          // 任一初始化异常都拒绝附加，不能让远程内容落到默认权限策略。
          hardenLoginCaptchaSession(session.fromPartition(LOGIN_CAPTCHA_PARTITION));
        } catch {
          e.preventDefault();
          return;
        }
        applyLoginCaptchaWebviewHardening(
          webPreferences as unknown as Record<string, unknown>,
          params,
        );
        pendingCaptchaAttach = true;
        return;
      }
      applyWebviewHardening(
        webPreferences as unknown as Record<string, unknown>,
        params,
        // 页面评论 guest 注入层:hardener 强制所有 webview 落在 BROWSER_PARTITION
        // (即全部是 RSB 内置浏览器),因此统一注入是安全且正确的。
        { commentPreloadPath: getBrowserCommentPreloadPath() },
      );
    });
    contents.on('did-attach-webview', (_e, guestContents) => {
      if (pendingCaptchaAttach) {
        pendingCaptchaAttach = false;
        // 挑战页零弹窗;顶层导航只允许停留在托管挑战页白名单内(Turnstile 的
        // 挑战 UI 活在子 iframe 里,顶层不应发生任何跨源导航)。token 回传走
        // location.hash → did-navigate-in-page,不经过 will-navigate。
        installLoginCaptchaGuestHandlers(guestContents);
        return;
      }
      if (pendingGhostAttach) {
        const authorized = pendingGhostAttach;
        const ghostId = authorized.id;
        pendingGhostAttach = null;
        // 崩溃豁免登记(lifecycle 的全局 render-process-gone 守卫据此放行,
        // 面板错误接管态负责用户侧收尾)。
        registerGhostWebContents(guestContents.id);
        // 意识面板零弹窗、零跳转:window.open 全拒,导航锁死在自己协议同源内。
        // 两个声明式例外(都是拦下导航、主机代办,面板侧依旧零桥):
        //   - /preview/ 预览链接 → 主窗口弹 lightbox(cindy-brain/previewGate.ts);
        //   - https 外链 → 外链闸(声明/授信直开,其余二次确认)转系统浏览器。
        installGhostGuestNavigationHandlers(
          contents,
          guestContents,
          ghostId,
          () => isGhostGuestOwnerActive(authorized.owner),
        );
        return;
      }
      installBrowserGuestHandlers(contents, guestContents);
    });
  });
}
