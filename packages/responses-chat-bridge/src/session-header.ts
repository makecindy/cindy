/**
 * Chat bridge 的「稳定会话标识」出站头(#4073)。
 *
 * OpenCode Go 自 2026-09-06 起强制要求每个对话携带稳定的 `x-opencode-session`(路由 +
 * prompt cache),缺失直接 400 `MissingSessionID`。Codex app-server 每个 thread 自带稳定的
 * `thread-id` 入站头,但本 bridge 发往上游的请求头是从零构造的(只有供应商凭证 +
 * content-type/accept),上游看不到任何会话标识。
 *
 * 这里**只**把稳定会话 ID 映射成一个出站头,不做入站 header 透传:Authorization / API key /
 * Codex 账号与内部元数据头一律不出网(与 codex-proxy-host 的凭证隔离边界一致)。
 *
 * 取值优先级:入站已带 `x-opencode-session`(客户端或代理明确给出)> Codex `thread-id`。
 * `x-codex-parent-thread-id` 是子线程路由信息,不当作普通会话 ID。值必须是 token 形态
 * (字母数字 . _ : -,≤128 字符),避免把任意字符串塞进请求头。
 */

export const CONVERSATION_SESSION_HEADER = 'x-opencode-session';
export const CODEX_THREAD_ID_HEADER = 'thread-id';
/**
 * OpenCode Go 要求客户端用自己的 User-Agent 而非通用 SDK / HTTP 库名。供应商 header 已显式
 * 给出 UA 时尊重之;否则补一个稳定的 Cindy bridge 标识(不伪装成 OpenCode 或 Codex 本身)。
 */
export const CHAT_BRIDGE_USER_AGENT = 'Cindy-CodexChatBridge/1';

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function headerValue(headers: Readonly<Record<string, string>>, name: string): string {
  const direct = headers[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 从已验证的入站请求头解析出站会话头;拿不到稳定 ID 或形态非法时返回空对象。 */
export function resolveConversationSessionHeaders(
  requestHeaders: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!requestHeaders) return {};
  const explicit = headerValue(requestHeaders, CONVERSATION_SESSION_HEADER);
  const candidate = explicit || headerValue(requestHeaders, CODEX_THREAD_ID_HEADER);
  if (!candidate || !SESSION_ID_PATTERN.test(candidate)) return {};
  return { [CONVERSATION_SESSION_HEADER]: candidate };
}

/** 供应商 header 没有 User-Agent 时补 bridge 自己的标识;已有则原样保留。 */
export function withChatBridgeUserAgent(
  providerHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const hasUserAgent = Object.keys(providerHeaders).some((key) => key.toLowerCase() === 'user-agent');
  return hasUserAgent ? { ...providerHeaders } : { ...providerHeaders, 'user-agent': CHAT_BRIDGE_USER_AGENT };
}

/**
 * 用 overrides 覆盖 base 中的同名头。HTTP 头名不区分大小写,但对象键区分:供应商静态配置里
 * 写成 `X-OpenCode-Session` 时,普通展开不会覆盖它,两个键一起交给 fetch 会被合并成
 * `fixed, thread-id` 这种非法复合值(Greptile P1)。这里先按小写头名剔除 base 里的同名项,
 * 再写入 overrides;overrides 为空时原样返回 base 的拷贝。
 */
export function overrideHeadersCaseInsensitive(
  base: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const overridden = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!overridden.has(key.toLowerCase())) merged[key] = value;
  }
  return { ...merged, ...overrides };
}
