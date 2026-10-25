/** xAI bridge 上游认证失效原因。 */
export type XaiBridgeAuthInvalidationReason = "access_token_rejected";

/** 单次 bridge 上游失败与实际请求凭证的关联信息。 */
export interface XaiBridgeAuthFailure {
  status: number;
  body: string;
  failedAccessToken: string;
}

/**
 * 收口结果。
 *
 * - `refreshed`:强制刷新拿到新 token,凭证已自愈(本次请求仍失败,下次即恢复);
 * - `logged_out`:refresh_token 也被服务端拒绝,已清空本机凭证,UI 回落未登录;
 * - `superseded`:期间用户重登或其它请求已换过 token,本次失败关联的是旧凭证,不动;
 * - `unchanged`:刷新遇到网络或临时错误,保留凭证等下次重试(不因抖动误杀登录态)。
 */
export type XaiBridgeAuthRecoveryOutcome =
  "refreshed" | "logged_out" | "superseded" | "unchanged";

/** 收口入口的返回值;`ignored` = 不是凭证作废信号,未触碰凭证。 */
export type XaiBridgeAuthInvalidationResult =
  XaiBridgeAuthRecoveryOutcome | "ignored";

/** bridge 认证失效协调器所需的 host 能力。 */
export interface XaiBridgeAuthInvalidatorDependencies {
  getCurrentAccessToken: () => Promise<string | null>;
  /**
   * 执行收口。**必须接住 failedAccessToken 并在开始时重新校验** —— 下面的等值检查到这里
   * 还隔着一次 await 边界,期间可能完成新登录或切换数据归属;只凭 reason 恢复会拿新账号的
   * 凭证去承担旧 token 的失败。
   */
  recover: (
    reason: XaiBridgeAuthInvalidationReason,
    failedAccessToken: string,
  ) => Promise<XaiBridgeAuthRecoveryOutcome>;
}

/**
 * 只接受 api.x.ai 明确声明「OAuth2 凭证没通过校验」的信号。
 *
 * 实测口径(2026-07):形态合法但验不过的 OAuth token 返 403 +
 * `{"code":"unauthenticated:bad-credentials","error":"The OAuth2 access token could not be
 * validated."}`;完全不成形的 token 走的是另一条 400 `invalid-argument` /
 * "Incorrect API key provided" 分支,不在此列。普通 401/403(配额、地域、模型未授权)
 * 不带这两个标记 —— 据此删用户凭证会把「有登录但没权限」误判成「登录失效」。
 */
export function detectXaiBridgeAuthInvalidationReason(
  status: number,
  body: string,
): XaiBridgeAuthInvalidationReason | null {
  if (status !== 401 && status !== 403) return null;
  if (/unauthenticated:\s*bad-credentials/i.test(body))
    return "access_token_rejected";
  if (/OAuth2 access token could not be validated/i.test(body))
    return "access_token_rejected";
  return null;
}

/**
 * 创建请求级失效协调器。
 *
 * 同一 token 的并发失败合并为一次收口(一轮对话可能有多个请求同时撞上同一坏 token,
 * 各自刷新会互相作废 refresh_token 的轮换);执行前再读一次当前凭证,确保旧请求迟到时
 * 不会把用户刚完成重连的新凭证一并注销。
 */
export function createXaiBridgeAuthInvalidator(
  dependencies: XaiBridgeAuthInvalidatorDependencies,
): (failure: XaiBridgeAuthFailure) => Promise<XaiBridgeAuthInvalidationResult> {
  const inFlightByToken = new Map<
    string,
    Promise<XaiBridgeAuthInvalidationResult>
  >();

  return async (failure) => {
    const reason = detectXaiBridgeAuthInvalidationReason(
      failure.status,
      failure.body,
    );
    if (!reason) return "ignored";

    const existing = inFlightByToken.get(failure.failedAccessToken);
    if (existing) return await existing;

    const run = (async (): Promise<XaiBridgeAuthInvalidationResult> => {
      const currentAccessToken = await dependencies.getCurrentAccessToken();
      if (currentAccessToken !== failure.failedAccessToken) return "superseded";
      // 这一步之后还有 await 边界,recover 必须自己再绑一次被拒的 token(见依赖注释)。
      return await dependencies.recover(reason, failure.failedAccessToken);
    })();
    inFlightByToken.set(failure.failedAccessToken, run);
    try {
      return await run;
    } finally {
      if (inFlightByToken.get(failure.failedAccessToken) === run) {
        inFlightByToken.delete(failure.failedAccessToken);
      }
    }
  };
}

/** 该请求是否发往 xAI 推理上游(codex 链路按 upstreamBase 判归属)。 */
