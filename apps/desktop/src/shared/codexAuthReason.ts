/**
 * Codex 共享凭证连不上时的稳定 reason —— desktop main、host 与 renderer 共用同一份字面量。
 *
 * 场景:本机 Codex CLI 已登录(~/.codex/auth.json 在),Windows 又没有创建符号链接的
 * 权限,Cindy 自己的 codex-home 建不出指向那份凭证的链接 —— 凭证是「连不上」而不是
 * 「没登录」。这时若报通用 no_oauth,用户只会反复重登,而卡点其实是链接权限。
 *
 * 一份常量三处用:desktop main 与 host 产生它,desktop renderer 把它翻译成可执行的引导。
 */
export const CODEX_SHARED_AUTH_LINK_UNAVAILABLE = 'codex_shared_auth_link_unavailable';

/**
 * 该不该报「共享凭证连不上」。
 *
 * 两个条件同时成立才是这个场景:这轮 reconcile 确实建不出链接(系统侧凭证存在却
 * 连不上),而且系统侧凭证确实还在(否则是「没登录」,不归这里管)。
 */
export function codexSharedAuthLinkUnavailableReason(input: {
  linkUnavailable: boolean;
  systemAuthPresent: boolean;
}): string | undefined {
  if (!input.linkUnavailable) return undefined;
  if (!input.systemAuthPresent) return undefined;
  return CODEX_SHARED_AUTH_LINK_UNAVAILABLE;
}

/**
 * 这条错误是不是「共享凭证连不上」。
 *
 * reason 产生后要穿过 `AgentNotAuthenticatedError` 与宿主 send failure 两层包装才到
 * 界面(`LAZY_CREATE_FAILED: codex not authenticated: <reason>`),renderer 拿不到结构化
 * 的 errorReason,只能认这个稳定 token —— 于是「主侧留下结论」与「界面翻译结论」必须
 * 共用同一份字面量,否则两侧各写一遍字符串,迟早对不上。
 */
export function isCodexSharedAuthLinkUnavailableError(message: string): boolean {
  return message.includes(CODEX_SHARED_AUTH_LINK_UNAVAILABLE);
}
