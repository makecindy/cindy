export interface ClaudeCliLoginStatus {
  /** CLI 用 Claude.ai 订阅账号登录(只有这种才算「Claude 订阅」)。 */
  loggedIn: boolean;
  /**
   * CLI 已登录,但不是 Claude.ai 订阅(Console 账号、API Key、apiKeyHelper、中转 token 等)。
   * 这类登录按 API 计费或指向别的上游,Cindy 不把它当订阅使用。仅 loggedIn=false 时出现。
   */
  notSubscription?: true;
  /** CLI 报告的登录方式;仅作展示。 */
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 解析 `claude auth status --json`;形状不符按未登录处理(不抛)。 */
export function parseClaudeCliLoginStatus(
  stdout: string,
): ClaudeCliLoginStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== "boolean") return null;
  const authMethod = optionalString(record.authMethod);
  const apiProvider = optionalString(record.apiProvider);
  if (!record.loggedIn || authMethod === "none") return { loggedIn: false };
  // 只认 Claude.ai 订阅账号的 OAuth 登录。CLI 对 Console 账号(`/login managed key`)也报
  // authMethod 'claude.ai',但会同时给出 apiKeySource;API Key / apiKeyHelper / 中转 token
  // (ANTHROPIC_AUTH_TOKEN 等)与 Bedrock / Vertex 等第三方云都不是「Claude 订阅」。
  const subscription =
    authMethod === "claude.ai" &&
    optionalString(record.apiKeySource) === undefined &&
    (apiProvider === undefined || apiProvider === "firstParty");
  if (!subscription) return { loggedIn: false, notSubscription: true };
  const subscriptionType = optionalString(record.subscriptionType);
  const email = optionalString(record.email);
  return {
    loggedIn: true,
    ...(authMethod ? { authMethod } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(email ? { email } : {}),
  };
}
