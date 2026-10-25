/** Codex CLI 的 OAuth client_id(codex 登录用的同一个;refresh 走它)。取自 codex CLI prod 配置。 */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** access_token 剩余寿命低于此阈值就提前刷新(秒)。 */
const REFRESH_MARGIN_SEC = 120;
// token 刷新 fetch 超时 —— 刷新在 _refreshChain mutex 内串行,不设超时会拖住所有排队请求。
const REFRESH_FETCH_TIMEOUT_MS = 15_000;

export interface CodexAuthFile {
  auth_mode?: string;
  last_refresh?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  [k: string]: unknown;
}

/** 解 JWT 的 exp 声明(秒)。解不出返回 null(视为不主动刷新,交给 401 兜底)。 */
function jwtExpSec(token: string | undefined): number | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

export function isCodexAccessTokenExpired(
  accessToken: string | undefined,
): boolean {
  const exp = jwtExpSec(accessToken);
  if (exp == null) return false; // 解不出 exp → 不主动刷,靠上游 401 暴露
  return Date.now() / 1000 >= exp - REFRESH_MARGIN_SEC;
}

// 刷新串行 mutex —— 防同一进程内并发请求同时打 refresh(会各自旋转 refresh_token 互相作废)。
export function createCodexCredentialRefresh(host: {
  read(authPath: string): Promise<CodexAuthFile | null>;
  write(authPath: string, value: CodexAuthFile): Promise<void>;
  fetch: typeof fetch;
  log: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
  };
}) {
  const { read: readAuthFile, fetch: outboundFetch, log } = host;
  const refreshChains = new Map<string, Promise<void>>();

  /**
   * 兜底刷新:用 refresh_token + codex client_id 打 auth.openai.com/oauth/token,原地写回 auth.json。
   * mutex 串行 + 刷新前重读(app-server 刚刷过就直接用其结果,不重复消耗 refresh_token 旋转)。
   */
  async function refreshIfNeeded(
    authPath: string,
    current: CodexAuthFile,
  ): Promise<CodexAuthFile> {
    if (!isCodexAccessTokenExpired(current.tokens?.access_token))
      return current;

    let result = current;
    const run = (refreshChains.get(authPath) ?? Promise.resolve()).then(
      async () => {
        // 重读:可能有别的进程(codex app-server)刚刷过。
        const fresh = await readAuthFile(authPath);
        if (fresh === null) {
          // 刷新期间 auth 文件被删除(用户已登出)——不重建,让本次请求用旧 token 自然失败。
          result = current;
          return;
        }
        if (!isCodexAccessTokenExpired(fresh.tokens?.access_token)) {
          result = fresh;
          return;
        }
        const refreshToken = fresh.tokens?.refresh_token;
        if (!refreshToken) {
          log.warn(
            "access_token 过期但无 refresh_token,无法刷新(请在设置里重新登录 OpenAI)",
          );
          result = fresh;
          return;
        }
        log.info("bridge 兜底刷新 codex access_token", {
          last_refresh: fresh.last_refresh,
        });
        // 必须带超时:本 fetch 在 _refreshChain mutex 内,undici 默认 headersTimeout 5 分钟,
        // auth.openai.com 挂起会让所有排队的 chatgpt/ 请求一起卡住。超时走 catch → 本次用旧 token。
        const res = await outboundFetch(OPENAI_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: CODEX_CLIENT_ID,
          }).toString(),
          signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          log.warn("codex token 刷新失败", { status: res.status });
          result = fresh;
          return;
        }
        const tok = (await res.json()) as {
          access_token?: string;
          refresh_token?: string;
          id_token?: string;
        };
        if (!tok.access_token) {
          log.warn("codex token 刷新响应缺 access_token");
          result = fresh;
          return;
        }
        const next: CodexAuthFile = {
          ...fresh,
          last_refresh: new Date().toISOString(),
          tokens: {
            ...fresh.tokens,
            access_token: tok.access_token,
            refresh_token: tok.refresh_token ?? fresh.tokens?.refresh_token,
            id_token: tok.id_token ?? fresh.tokens?.id_token,
          },
        };
        // 落盘前复核:刷新 fetch / res.json() 期间用户可能已登出(文件被删)或已重登 / 他方进程
        // 已刷(文件被改写)。删了 → 不得用旧账号的刷新结果重建文件(否则等于撤销登出),本次用
        // 旧 token 自然失败(同上方 null 重读语义);改了 → 以磁盘新状态为准,丢弃本次刷新结果。
        const beforeWrite = await readAuthFile(authPath);
        if (beforeWrite === null) {
          result = fresh;
          return;
        }
        if (beforeWrite.tokens?.refresh_token !== refreshToken) {
          result = beforeWrite;
          return;
        }
        try {
          await host.write(authPath, next);
        } catch (err) {
          log.warn("刷新后写回 auth.json 失败(本次仍用新 token,内存生效)", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        result = next;
      },
    );
    // 把本次刷新接到链上(无论成败都释放锁给下一个)。
    const settled = run.catch(() => undefined);
    refreshChains.set(authPath, settled);
    void settled.then(() => {
      if (refreshChains.get(authPath) === settled)
        refreshChains.delete(authPath);
    });
    await run.catch((err) => {
      log.warn("token 刷新异常", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
    return result;
  }

  return refreshIfNeeded;
}
