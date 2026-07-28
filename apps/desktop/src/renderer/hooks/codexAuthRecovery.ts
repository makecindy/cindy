/**
 * 识别需要用户重新连接 ChatGPT 账号的 OpenAI OAuth 失效原因。
 *
 * 这些字符串来自 Codex app-server / CLI 或 Claude 的 ChatGPT bridge，不应直接展示
 * 给用户；renderer 统一把它们收口为“OpenAI 连接需要更新”的可恢复状态。
 */
export function isCodexOAuthReconnectRequired(reason: string | undefined): boolean {
  if (!reason) return false;
  // "access token could not be refreshed" 覆盖 codex-rs 永久刷新失败的整个文案家族
  // (revoked / expired / already used / account mismatch / unknown)——这些句式只在
  // refresh token 已不可用时产生，重试必然无效，只能重新连接。
  return /app_session_terminated|token_invalidated|token_revoked|refresh_token_reused|Your session has ended|authentication token has been invalidated|authentication token has been revoked|refresh token was already used|refresh_token.*already used|access token could not be refreshed|refresh token (?:was|has been) revoked|bridge auth unavailable for chatgpt\//i.test(
    reason,
  );
}
