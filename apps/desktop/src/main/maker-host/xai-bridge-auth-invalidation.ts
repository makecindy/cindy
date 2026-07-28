/**
 * xai-bridge-auth-invalidation —— api.x.ai 拒绝订阅 OAuth 凭证后的失效收口(纯逻辑)。
 *
 * 与 chatgpt-bridge-auth-invalidation 同构:只认上游明确声明的凭证作废信号,并把同一
 * token 的并发失败合并成一次收口。差异在恢复动作 —— ChatGPT 侧凭证由 codex CLI /
 * app-server 一起持有,判失效即断开;xAI 侧没有任何子进程替我们刷新(见 grok-oauth-login
 * 头注),所以先强制刷新自愈,刷不动才登出。因此这里回传 outcome 而不是 boolean。
 *
 * Electron-free:只做判定、并发合并与响应观察,凭证读写留在 grok-oauth-login。
 */

import type { ResponseObserver, ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';

import { bearerAccessTokenFromHeaders } from './chatgpt-bridge-auth-invalidation.js';
import { decodeUpstreamErrorBody } from './provider-upstream-error-observer.js';

/** 错误体累积上限(判定只看开头的 code/error 字段)。 */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** xAI bridge 上游认证失效原因。 */
export type XaiBridgeAuthInvalidationReason = 'access_token_rejected';

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
  | 'refreshed'
  | 'logged_out'
  | 'superseded'
  | 'unchanged';

/** 收口入口的返回值;`ignored` = 不是凭证作废信号,未触碰凭证。 */
export type XaiBridgeAuthInvalidationResult = XaiBridgeAuthRecoveryOutcome | 'ignored';

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
  if (/unauthenticated:\s*bad-credentials/i.test(body)) return 'access_token_rejected';
  if (/OAuth2 access token could not be validated/i.test(body)) return 'access_token_rejected';
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
  const inFlightByToken = new Map<string, Promise<XaiBridgeAuthInvalidationResult>>();

  return async (failure) => {
    const reason = detectXaiBridgeAuthInvalidationReason(failure.status, failure.body);
    if (!reason) return 'ignored';

    const existing = inFlightByToken.get(failure.failedAccessToken);
    if (existing) return await existing;

    const run = (async (): Promise<XaiBridgeAuthInvalidationResult> => {
      const currentAccessToken = await dependencies.getCurrentAccessToken();
      if (currentAccessToken !== failure.failedAccessToken) return 'superseded';
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
function isXaiUpstream(upstreamBase: string): boolean {
  try {
    return new URL(upstreamBase).hostname === 'api.x.ai';
  } catch {
    return false;
  }
}

/**
 * codex 链路的凭证收口观察器。
 *
 * claude-code 侧的 xai/ 请求由 anthropic-responses-bridge 接管,收口挂在它的
 * onUpstreamError;codex 原生就是 Responses 协议,proxy 只注入 header 后原样转发,
 * 只有 responseObserver 能看到上游状态码 —— 缺这一条,同一把坏 token 在 codex agent
 * 下依旧无人收口。
 *
 * proxy 热路径契约(规则 10):非认证状态码与非 xAI 上游直接返回 null,零 tee 零开销;
 * 只读观察,不改写、不阻塞响应 pipe。
 */
export function createXaiAuthInvalidationObserver(
  handleFailure: (failure: XaiBridgeAuthFailure) => Promise<unknown>,
): ResponseObserver {
  return (ctx: ResponseObserverCtx) => {
    if (ctx.status !== 401 && ctx.status !== 403) return null;
    if (!isXaiUpstream(ctx.upstreamBase)) return null;
    // 必须读 outboundHeaders:xAI token 是路由期经 headerOverride 注入的,requestHeaders
    // 里的 authorization 还是 codex 子进程自带的那把,拿它做等值关联会永远 superseded,
    // 等于这条链路的收口完全不生效。省略时回落 requestHeaders(无路由改写 = 两者相同)。
    const failedAccessToken = bearerAccessTokenFromHeaders(
      ctx.outboundHeaders ?? ctx.requestHeaders,
    );
    if (!failedAccessToken) return null;

    const chunks: Buffer[] = [];
    let size = 0;
    return {
      onData: (chunk: Buffer) => {
        // 按剩余空间裁剪后再缓存:上游可能一个 chunk 就远超上限,整段留到 onEnd 会把
        // 大 Buffer 一直挂住(判定只需要开头的 code/error 字段)。
        // 超限时必须 Buffer.from 拷贝而不是只取 subarray —— 后者是共享底层内存的视图,
        // 留着它等于留着整段原始 chunk,起不到限量的作用。
        const remaining = MAX_ERROR_BODY_BYTES - size;
        if (remaining <= 0) return;
        const slice =
          chunk.length > remaining ? Buffer.from(chunk.subarray(0, remaining)) : chunk;
        chunks.push(slice);
        size += slice.length;
      },
      onEnd: () => {
        const encoding = ctx.responseHeaders['content-encoding'];
        // size 在 onData 已按上限裁过,这里直接用即可。
        const body = decodeUpstreamErrorBody(
          Buffer.concat(chunks, size),
          typeof encoding === 'string' ? encoding : undefined,
        );
        // observer 契约是同步只读:收口只能 fire-and-forget,且必须自己吃掉异常 ——
        // 未捕获的 rejection 会冒成进程级 unhandledRejection,而上游原始错误必须原样
        // 到达调用方,不能被收口失败改写。
        void handleFailure({ status: ctx.status, body, failedAccessToken }).catch(() => {});
      },
      // 上游流错误:本次观察放弃即可(连接层问题由 proxy 主路径处理与记日志)。
      onError: () => {},
    };
  };
}
