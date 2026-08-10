/**
 * deepLink — cindy:// (+ 历史 xdt-maker://) custom URL scheme + folder-context-menu handoff
 * ---------------------------------------------------------------------------
 * URL 形态(scheme 单点在 shared/deepLinkSchemes.ts:生成一律主 scheme cindy://,
 * 解析主 + 历史 scheme 都认——存量消息里的 xdt-maker:// 老链接不能死):
 *   cindy://session/<sessionId>             —— sessionId 直接是 string id
 *   cindy://project/<urlencoded-workingDir> —— workingDir 全路径 URL-encoded
 *
 * 命令行参数形态 (右键菜单 / 命令行):
 *   --open-folder <absolute-path>   或   --open-folder=<absolute-path>
 *     —— 不走 URL 编解码,argv 透传原始文件系统路径,绕开 % / 空格 / 中文坑。
 *     —— 内部转换为 { type: 'new-session', workingDir } payload,与 deep link
 *        共用 dispatch / pending / IPC 通道,renderer 端 onDeepLinkNavigate 一处分发。
 *
 * 由 bootstrap-electron 在以下入口调:
 *   1. app.on('open-url')           — macOS 已运行 / 冷启动均触发 (deep link)
 *   2. app.on('second-instance')    — Windows 第二实例被系统重定向到此 (deep link 或 --open-folder)
 *   3. 冷启动 process.argv 末尾扫描  — Windows 首次启动 (deep link 或 --open-folder)
 *
 * 跨平台行为:
 *   - macOS LaunchServices: 注册靠 Info.plist 的 CFBundleURLTypes (打包时由
 *     electron-packager 写入,见 forge.config.ts packagerConfig.protocols)
 *   - Windows / Linux: 运行时对每个 scheme(cindy / xdt-maker)各调一次
 *     app.setAsDefaultProtocolClient 写注册表 / .desktop entry
 *
 * Pending 缓存 + pull-on-mount:
 *   - 冷启动期间 mainWindow 还没 ready / renderer 还没挂 listener → 进 pendingDeepLink
 *   - 已登录用户:MainLayout mount 后会通过 IPC 'deep-link:take-pending' 拉一次,
 *     拉到非空 payload 就分发。已运行场景 pendingDeepLink 一直为 null,no-op。
 *   - 未登录用户:冷启动 + deep link 后 LoginPage 接管,pendingDeepLink 保留;
 *     用户完成 Feishu OAuth → MainLayout 第一次 mount → 同一条 pull 路径消费 payload,
 *     不会因为登录流程跳过而丢失"点击右键打开"这个意图。
 *
 * dev 模式说明:
 *   非 packaged 模式下系统协议 / 右键菜单注册不会生效 (操作系统识别的是已安装的
 *   .app/.exe,不是临时跑的 Electron 解释器)。本模块的解析 / 派发逻辑可以单测,
 *   但端到端 "点链接 / 右键唤起" 必须打 release 包验证。
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createLogger } from './logger';
import {
  DEEP_LINK_PRIMARY_SCHEME,
  DEEP_LINK_SCHEMES,
  DEEP_LINK_URL_PREFIX,
  matchDeepLinkPrefix,
} from '../shared/deepLinkSchemes';

const log = createLogger('deepLink');

/** 主 scheme(生成 / OS 注册首选)。历史消费点保留此导出名。 */
export const DEEP_LINK_PROTOCOL = DEEP_LINK_PRIMARY_SCHEME;
/** 生成侧前缀(cindy://)。解析侧不要用它做 startsWith——走 matchDeepLinkPrefix。 */
const URL_PREFIX = DEEP_LINK_URL_PREFIX;

/** Windows 右键菜单 / 命令行入口的 flag。值是绝对路径,argv 透传不编解码。 */
export const OPEN_FOLDER_FLAG = '--open-folder';
export const OPEN_SHARE_FILE_FLAG = '--open-share-file';

export type DeepLinkPayload =
  | { type: 'session'; id: string; messageClientId?: string }
  | { type: 'project'; workingDir: string }
  /**
   * 由 --open-folder argv 触发的 "新建对话 + 预填工作目录"。
   * 与 'project' 区别:'project' 是聚焦已有 project 节点;'new-session' 直接落
   * NewMakerDraftRoute,workingDir 不依赖 project 树是否存在该目录。
   */
  | { type: 'new-session'; workingDir: string }
  | { type: 'share-import'; filePath: string }
  /**
   * 主进程内部发起的设置页导航。它不由自定义 URL 解析产生；复用现有的
   * main-window focus + renderer dispatch 通道，供全局浮层等独立窗口把用户
   * 带回主窗口的准确设置页。
   */
  | { type: 'settings'; tab: 'voice-input' | 'providers' }
  /**
   * 纯"把窗口拉回前台"意图,不携带导航语义 (典型来源:OAuth 授权成功页的
   * "打开 xdt-maker" 按钮 / 自动唤起)。main 进程内消化,不发给 renderer、
   * 不进 pending 缓存 (冷启动时 app 启动本身就会前台,缓存无意义)。
   */
  | { type: 'focus' };

/**
 * 解析 cindy:// / xdt-maker:// URL 为 typed payload(两种 scheme 都认,
 * 按实际命中的前缀长度切片)。
 * 非本协议、格式残缺或 id/workingDir 为空 → null(让调用方静默丢弃)。
 *
 * 不用 `new URL()` 是因为 WHATWG URL 对 non-special scheme 的 host/pathname
 * 切分行为在不同 Node 版本上有差异(`cindy://session/abc` 的 host 可能
 * 为空、pathname 可能含 `//session/abc`)。手解最稳。
 */
export function parseDeepLink(url: string): DeepLinkPayload | null {
  if (typeof url !== 'string') return null;
  const prefix = matchDeepLinkPrefix(url);
  if (prefix === null) return null;
  const rest = url.slice(prefix.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  const type = rest.slice(0, slashIdx);
  const rawValue = rest.slice(slashIdx + 1);
  // 去尾部 ? / # / 多余 /（Windows argv 上的链接有时会被附加引号外的杂字符）
  const cleanedValue = rawValue.replace(/[/?#].*$/, '').replace(/\/+$/, '');
  if (!cleanedValue) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(cleanedValue);
  } catch {
    return null;
  }
  if (!decoded) return null;
  if (type === 'session') {
    // session 深链支持消息锚点 `?message=<clientId>`(其余 type 维持剥 query 语义)。
    const messageClientId = parseSessionMessageParam(rawValue);
    return messageClientId
      ? { type: 'session', id: decoded, messageClientId }
      : { type: 'session', id: decoded };
  }
  if (type === 'project') {
    return { type: 'project', workingDir: decoded };
  }
  if (type === 'focus') {
    // value 只作来源标记 (如 google-auth),解析后不参与行为分发。
    return { type: 'focus' };
  }
  return null;
}

/**
 * 从 session 深链的原始 value(`<id>?message=...#...`)里抽 `message` 参数。
 * 值为空 / 解码失败 → null(锚点非法不拖累 sessionId 本身的解析)。
 */
function parseSessionMessageParam(rawValue: string): string | null {
  const hashIdx = rawValue.indexOf('#');
  const noHash = hashIdx >= 0 ? rawValue.slice(0, hashIdx) : rawValue;
  const queryIdx = noHash.indexOf('?');
  if (queryIdx < 0) return null;
  const query = noHash.slice(queryIdx + 1);
  for (const pair of query.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0 || pair.slice(0, eqIdx) !== 'message') continue;
    const rawParam = pair.slice(eqIdx + 1);
    if (!rawParam) return null;
    try {
      const decoded = decodeURIComponent(rawParam);
      return decoded || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 反向:把 payload 拼成可粘贴的 URL 字符串。renderer 侧的"复制深度链接" handler
 * 通过这两个 helper 保证拼装规则与解析规则单源(虽然 renderer 是单独 import 一份,
 * 但因为是 pure function,直接复制实现成本极低;放这里只是给 main 自身/测试用)。
 *
 * 注意:'new-session' 不提供 builder——它只由 --open-folder argv 产生,不进入
 * "可复制 / 可粘贴"的 URL 域,避免和现有 project deep link 在 URL 域语义混淆。
 */
export function buildSessionDeepLink(
  sessionId: string,
  opts?: { deviceId?: string | null },
): string {
  const device = opts?.deviceId ? `?device=${encodeURIComponent(opts.deviceId)}` : '';
  return `${URL_PREFIX}session/${encodeURIComponent(sessionId)}${device}`;
}

/** 带消息锚点(`?message=<clientId>`)的会话深链,与 renderer 侧实现等价镜像。 */
export function buildSessionMessageDeepLink(
  sessionId: string,
  messageClientId: string,
  opts?: { deviceId?: string | null },
): string {
  const device = opts?.deviceId ? `&device=${encodeURIComponent(opts.deviceId)}` : '';
  return `${URL_PREFIX}session/${encodeURIComponent(sessionId)}?message=${encodeURIComponent(messageClientId)}${device}`;
}

/**
 * RFC 3986 严格编码(renderer/lib/deepLink.ts 同名 helper 的等价镜像):
 * encodeURIComponent 放行 `!'()*`,而项目深链的文本匹配白名单排除裸 `'()`
 * ——目录名含这些字符时生成的链接会被粘贴 / linkify 拒绝或截断(review P2,
 * 历史上本函数用普通编码产出过含裸括号的链接)。转成 %XX 后解析端零改动。
 */
function strictEncodeURIComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildProjectDeepLink(workingDir: string): string {
  return `${URL_PREFIX}project/${strictEncodeURIComponent(workingDir)}`;
}

/**
 * "唤回前台" deep link。source 是来源标记 (进 URL 便于日志排查),如 'google-auth'。
 * 供 OAuth 授权成功页等浏览器侧场景把用户带回客户端。
 */
export function buildFocusDeepLink(source: string): string {
  return `${URL_PREFIX}focus/${encodeURIComponent(source)}`;
}

// ─── pending buffer:冷启动 / 主窗口未 ready / renderer 未挂 listener 期间暂存 ──
//
// 冷启动 case:
//   1. 用户点 cindy://...(或历史 xdt-maker://...)或右键"通过 Cindy 打开" → OS 启动 app
//      → main 进程跑到 app.on('open-url') 或扫 process.argv
//   2. 此时 mainWindow 还没 create / ready-to-show,即使 send 出去 renderer 端
//      MainLayout 也还没 mount + 挂 listener (要等 OAuth 通过 ProtectedRoute)
//   3. 把 payload 存进 pendingDeepLink;MainLayout mount 后会通过 IPC
//      'deep-link:take-pending' 来拉一次消费
//
// 已运行 case:
//   - mainWindow 已存在 + MainLayout 必然已 mount (用户已登录),dispatchDeepLink
//     直接 webContents.send,不进 pending
let pendingDeepLink: DeepLinkPayload | null = null;
let mainWindowRef: BrowserWindow | null = null;

export function setDeepLinkMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win;
}

/**
 * 处理一条入站 URL。会内部解析、根据 mainWindow 状态选择直接发送 or 缓存。
 * 即使解析失败也只 log 不抛,避免污染调用方(open-url / second-instance / argv)。
 */
export function handleIncomingDeepLink(url: string, source: string): void {
  const payload = parseDeepLink(url);
  if (!payload) {
    log.warn('ignoring unparseable url', { url, source });
    return;
  }
  log.info('received deep link', { source, payload });
  dispatchDeepLink(payload);
}

/**
 * 处理一条入站 --open-folder 参数。把绝对路径包成 'new-session' payload 后走
 * 同一份 dispatch / pending 通道,renderer 端用 onDeepLinkNavigate 一处分发。
 *
 * 不在这里做"目录是否存在"校验——renderer 端 NewMakerDraftRoute 自己有 workdir
 * 校验逻辑 + Toast,main 这边做校验只会引入两套规则。空路径直接 drop。
 *
 * 但拦明显非法输入:必须是绝对路径。Explorer 右键 + Finder "打开方式" 触发时
 * OS 保证给绝对路径;只有命令行手工 `xdt-maker --open-folder ../foo` 才可能传
 * 相对路径。相对路径透传到 renderer 后 patchDraft 会按当前 cwd 解析,语义不
 * 确定 (cwd 是 Electron 解释器目录,不是用户预期的目录),直接拒绝更安全。
 */
export function handleIncomingOpenFolder(workingDir: string, source: string): void {
  if (typeof workingDir !== 'string' || workingDir.length === 0) {
    log.warn('ignoring empty --open-folder', { source });
    return;
  }
  // 防御性:argv 中残留的引号 / 尾随空白裁掉。Windows Explorer 在 %1 替换时已经
  // 帮我们处理引号,这里只为命令行手工触发 / 老 NSIS 模板的兜底。
  const cleaned = workingDir.trim().replace(/^"|"$/g, '');
  if (!cleaned) {
    log.warn('ignoring blank --open-folder after trim', { source });
    return;
  }
  if (!path.isAbsolute(cleaned)) {
    log.warn('ignoring non-absolute --open-folder', { source, workingDir: cleaned });
    return;
  }
  const payload: DeepLinkPayload = { type: 'new-session', workingDir: cleaned };
  log.info('received open-folder', { source, workingDir: cleaned });
  dispatchDeepLink(payload);
}

export function handleIncomingShareFile(filePath: string, source: string): void {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    log.warn('ignoring empty --open-share-file', { source });
    return;
  }
  const cleaned = filePath.trim().replace(/^"|"$/g, '');
  if (!cleaned) {
    log.warn('ignoring blank --open-share-file after trim', { source });
    return;
  }
  if (!path.isAbsolute(cleaned)) {
    log.warn('ignoring non-absolute --open-share-file', { source, filePath: cleaned });
    return;
  }
  log.info('received open-share-file', { source, filePath: cleaned });
  dispatchDeepLink({ type: 'share-import', filePath: cleaned });
}

/**
 * 把主窗口拉回前台 (show + restore + focus)。Windows 的外部协议唤起需要先
 * 激活应用并提升目标窗口 z-order；macOS 额外使用 app.focus steal——
 * 从浏览器等其它前台应用手里抢焦点，单靠 win.focus() 不可靠。
 * 窗口不存在 / 已销毁时返回 false,调用方自行决定是否忽略。
 */
export function focusMainWindow(platform: NodeJS.Platform = process.platform): boolean {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  if (platform === 'win32') {
    // Windows 可以收到 second-instance deep link 但仍把浏览器保留在
    // 前台。app.focus() 先激活应用，moveTop() 再确保用户主动点击的
    // OAuth 返回窗口不被原浏览器遮挡。该函数只用于 focus deep link，
    // 不会把后台 Ghost workspace 请求扩大为强制抢前台。
    app.focus();
    win.moveTop();
  }
  win.focus();
  if (platform === 'darwin') app.focus({ steal: true });
  return true;
}

/**
 * 从独立窗口把用户带回主窗口中的语音相关设置页。
 * tab 是封闭联合类型，避免 IPC 调用方把任意 renderer 路由注入主窗口。
 */
export function openMainWindowVoiceSettings(tab: 'voice-input' | 'providers'): void {
  dispatchDeepLink({ type: 'settings', tab });
}

/**
 * 主进程内部发起的会话聚焦(workspace 槽 focus:true)。复用 deep link 的
 * 前台 + renderer dispatch 通道,行为与用户点 cindy://session/<id> 一致。
 */
export function openMainWindowSession(sessionId: string): void {
  dispatchDeepLink({ type: 'session', id: sessionId });
}

function dispatchDeepLink(payload: DeepLinkPayload): void {
  // 纯前台意图:main 进程内消化。冷启动时窗口还没建,app 启动流程本身会前台,直接丢弃。
  if (payload.type === 'focus') {
    focusMainWindow();
    return;
  }
  const win = mainWindowRef;
  // mainWindow 尚未创建(冷启动) / webContents 未就绪 → 缓存等 MainLayout pull
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isLoading()) {
    // 保留"用户最后意图"语义:同一次冷启动如果先后入站多条 (例如 argv 同时含
    // deep link URL 和 --open-folder, 现实场景极罕见但 bootstrap 两条 scan 都
    // 会触发),后到的覆盖前者。但 warn log 留下排查线索,事后能从日志识别这种
    // 情况;若未来收到反馈再改为"先到先得"或"显式拒绝后者"。
    if (pendingDeepLink) {
      log.warn('overwriting buffered pending payload', {
        previous: pendingDeepLink,
        next: payload,
      });
    }
    pendingDeepLink = payload;
    log.debug('buffered pending deep link until renderer pull', payload);
    if (win && !win.isDestroyed()) {
      // 把窗口拉前台(用户点链接 / 右键的意图就是 focus app)
      if (!win.isVisible()) win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return;
  }
  // 已运行场景:listener 必然挂着(MainLayout 已 mount),直接 send,不进 pending。
  // 同时把窗口拉前台 — open-url / second-instance 本身不会唤起,用户点链接的
  // 意图就是要看到 app。
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('deep-link:navigate', payload);
}

/**
 * 给 IPC handler 用:取走 pendingDeepLink 并清空。pull-on-mount 路径专用,
 * 重复调用是安全的——第一次拿到 payload,后续调用返回 null,不会双发。
 *
 * 命名上故意用 "take" 而非 "consume" / "get" 表达 pop 语义,避免和老的
 * (已删除) consumePendingDeepLink push 路径搞混。
 */
export function takePendingDeepLink(): DeepLinkPayload | null {
  if (!pendingDeepLink) return null;
  const payload = pendingDeepLink;
  pendingDeepLink = null;
  log.info('renderer pulled pending deep link', payload);
  return payload;
}

/**
 * Windows 第二实例 / 冷启动 argv 解析:从命令行参数末尾找形如 cindy://... /
 * xdt-maker://... 的项(两种 scheme 都认)。
 * Electron 在 Windows 上把协议 URL 作为 argv 最后一项追加;macOS 不走 argv,走
 * app.on('open-url')。Linux 依赖 .desktop 的 Exec 参数传递协议 URL;首版只做
 * 打包 metadata,实际导航行为仍需要 Ubuntu 真机验收。
 */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (typeof arg === 'string' && matchDeepLinkPrefix(arg) !== null) return arg;
  }
  return null;
}

/**
 * 从 argv 找 --open-folder 参数对应的路径。两种形态都支持:
 *   --open-folder <absolute-path>
 *   --open-folder=<absolute-path>
 *
 * 返回找到的第一个 (从前往后扫,因为新启动的 OS 会把这两个 token 紧挨放在 argv 末尾,
 * 但 dev 模式 / 命令行手工调用时可能会和别的参数混合,语义上"第一个出现"更稳)。
 * 找不到、或 --open-folder 后面没值(末尾被截断)→ null。
 *
 * 不做"路径是否合法 / 是否存在"校验——交给 renderer 端的 workdir 校验路径。
 */
export function findOpenFolderInArgv(argv: readonly string[]): string | null {
  return findAbsolutePathAfterFlag(argv, OPEN_FOLDER_FLAG);
}

export function findOpenShareFileInArgv(argv: readonly string[]): string | null {
  return findAbsolutePathAfterFlag(argv, OPEN_SHARE_FILE_FLAG);
}

function findAbsolutePathAfterFlag(argv: readonly string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    if (arg === flag) {
      const next = argv[i + 1];
      if (typeof next === 'string' && next.length > 0 && isAbsoluteFilesystemPath(next)) return next;

      // Electron's Windows second-instance argv can interleave Chromium switches
      // between our custom flag and Explorer's folder path. Recover by taking the
      // first absolute path after the flag instead of returning a Chromium flag.
      for (let j = i + 1; j < argv.length; j++) {
        const candidate = argv[j];
        if (typeof candidate === 'string' && candidate.length > 0 && isAbsoluteFilesystemPath(candidate)) {
          return candidate;
        }
      }
      return null;
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      return value.length > 0 && isAbsoluteFilesystemPath(value) ? value : null;
    }
  }
  return null;
}

function isAbsoluteFilesystemPath(value: string): boolean {
  if (isWindowsSlashSwitch(value)) return false;
  if (process.platform !== 'win32') {
    return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
  }
  // Windows argv may contain Chromium-style switches such as `/prefetch:1`.
  // `path.win32.isAbsolute('/prefetch:1')` treats those as drive-rooted paths,
  // but Explorer hands us full drive/UNC paths for file system open actions.
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(value);
}

function isWindowsSlashSwitch(value: string): boolean {
  return /^\/[A-Za-z][A-Za-z0-9_-]*(?::|=)/.test(value);
}

/**
 * 把当前 packaged / unpackaged 状态下的 client 注册给 OS。主 + 历史 scheme
 * 逐个注册(Windows/Linux 运行时写注册表 / .desktop;macOS 以 Info.plist 的
 * CFBundleURLTypes 双注册为准,此调用是兜底,同样遍历保持行为一致)。
 * - packaged:直接 setAsDefaultProtocolClient(scheme) 即可
 * - dev:需要带 execPath + argv 让系统知道怎么把链接路由回当前 Electron 解释器
 *
 * 必须在 app.whenReady 之前调用一次(Electron 文档要求)。重复调用幂等。
 */
export function registerDeepLinkProtocol(): void {
  for (const scheme of DEEP_LINK_SCHEMES) {
    if (process.defaultApp) {
      // dev:用 Electron 解释器跑 main 入口
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(scheme, process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      } else {
        app.setAsDefaultProtocolClient(scheme);
      }
    } else {
      // packaged:直接调,OS 用 app bundle 路径
      app.setAsDefaultProtocolClient(scheme);
    }
  }
}
