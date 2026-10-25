/** ChatGPT Responses bridge 构造请求头所需的非敏感形状。 */
export interface ChatgptBridgeHeaderInput {
  accessToken: string;
  accountId: string | null;
  sessionId?: string;
}

/**
 * 构造 ChatGPT backend 请求头。
 *
 * Codex CLI 在单账号凭证缺少 account id 时会省略 `chatgpt-account-id`；bridge 必须保持
 * 同一语义，不能把仍可用的 access token 误报成“需要重新登录”。
 */
export function buildChatgptBridgeHeaders({
  accessToken,
  accountId,
  sessionId,
}: ChatgptBridgeHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: sessionId ?? '',
    'user-agent': 'codex_cli_rs/0.0.0 (xdt-maker bridge)',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}
