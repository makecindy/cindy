/**
 * auth generation —— 「作废在途认证结果」的单一机制(纯函数,规则 9)。
 *
 * 认证类异步动作(冷启动 / 自愈 `refresh`、`loadMe`、canary 同步、`acceptOutcome`)在
 * 开始时捕获一次 generation,结果落地前再与当前值比对:**不等即代表期间发生了会话切换,
 * 结果必须整条丢弃**(见 AuthContext 里各处 `authGenerationRef.current !== generation`)。
 *
 * 需要切换会话的路径统一调用本函数 bump,而不是各自散写 `++ref`:
 * - `clearLocalSession`(登出 / 会话终止 / 账号注销 / ACCOUNT_UNAVAILABLE)
 * - `enterLocalMode`(进入「跳过登录」无账号态)
 *
 * 少一处漏 bump 就意味着迟到的结果能推翻用户的选择。历史事故(2026-07-28 review P1):
 * `enterLocalMode` 早期只写「跳过」标记、没 bump generation —— 启动 `refresh` 超过
 * `AUTH_STARTUP_GATE_TIMEOUT_MS` 后界面已放行、那条请求仍在飞,它迟到成功仍能通过
 * generation 校验并 `applyUser()`,把用户明确选择的「不登录」翻成已登录。
 *
 * 注意本函数**只作废在途结果**,不清 token / user / 落盘凭证:完整的登录态清除是
 * `clearLocalSession` 的职责,「跳过登录」只需要让在途结果落空。bump 也不会影响之后
 * 用户**主动**发起的登录——那条链路在自己开始时重新捕获(`acceptOutcome` 里
 * `++authGenerationRef.current`),拿到的是 bump 之后的新值。
 */
export interface InFlightAuthRefs {
  /** 当前会话代号;每次会话切换 +1。 */
  authGeneration: { current: number };
  /** 共享的 in-flight refresh promise(auth-server 轮换 refresh token,必须共用一条)。 */
  refreshInFlight: { current: Promise<string | null> | null };
}

/**
 * 作废所有在途认证结果,返回新的 generation。
 *
 * 同步执行:调用方必须在任何 `await` 之前调用,否则中间的异步窗口里迟到结果仍会落地。
 */
export function invalidateInFlightAuth(refs: InFlightAuthRefs): number {
  refs.authGeneration.current += 1;
  // 共享 promise 一并丢弃:它的结果已按 generation 作废,留着只会让下一个调用方拿到
  // 一条注定返回 null 的旧 promise,而不是发起真正的新请求。
  refs.refreshInFlight.current = null;
  return refs.authGeneration.current;
}
