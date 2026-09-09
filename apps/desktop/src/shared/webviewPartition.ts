/**
 * BROWSER_PARTITION — RSB 内置浏览器(web-browser plugin)使用的 Electron session
 * partition,单一来源。
 *
 * 命名规则:`persist:` 前缀让 Electron 把 cookie / IndexedDB / cache / localStorage
 * 持久化到 userData 下的子目录(关 app 重开仍登录态保留)。
 * `xdmaker-browser-app` 是分区名,跟 Feishu OAuth 用的默认 session(空 partition)、
 * Electron 主窗 webContents 自己的 session 等所有内部 session 都隔离开,网页不会
 * 看到应用本身的 cookie / IDB。
 *
 * Phase 4 主进程 webview hardener 用它强制覆盖所有 `<webview>` 的 partition 属性,
 * 即便 renderer 端写了别的 partition 或没写,最终落到 guest webContents 上的都是
 * 这一个 partition;Phase 5 web-browser plugin 渲染 `<webview partition={...} />`
 * 也用它(双保险:即使硬编码忘了带,hardener 兜底)。
 *
 * 同时跨 main / renderer 共用,放到 shared/ 保持单一来源。
 */
export const BROWSER_PARTITION = 'persist:xdmaker-browser-app';

/**
 * LOGIN_CAPTCHA_PARTITION — 登录页人机验证(Turnstile 托管挑战页)webview 的专用
 * 分区。不带 `persist:` 前缀 = 纯内存 session,关闭 overlay 即弃,不与 RSB 浏览器
 * 或主窗共享任何 cookie / 存储。主进程 webview hardener 对该分区做显式白名单:
 * 只允许加载 auth-server 的 /captcha/ 托管页(来源与路径校验见 webview-security.ts),
 * 其余一律拒附加。
 */
export const LOGIN_CAPTCHA_PARTITION = 'login-captcha';

/** guest 获得焦点时，Main 用这个静态 hash 把 Esc 取消意图送回宿主 Renderer。 */
export const LOGIN_CAPTCHA_CANCEL_RESULT_CODE = 'cancelled';
export const LOGIN_CAPTCHA_CANCEL_HASH =
  `#cindy-captcha=err.${LOGIN_CAPTCHA_CANCEL_RESULT_CODE}`;

import { CAPTCHA_CHALLENGE_PAGE_PATH } from '@cindy/auth-client';

/**
 * auth-server 托管挑战页的固定路径(wire 契约单一来源在 @cindy/auth-client,
 * 双端共用)。完整 URL = authApiBaseUrl + 本路径 + query,由 main 惰性拼出;
 * webview hardener 也用它做附加/导航的路径白名单。
 */
export const LOGIN_CAPTCHA_PAGE_PATH = CAPTCHA_CHALLENGE_PAGE_PATH;
