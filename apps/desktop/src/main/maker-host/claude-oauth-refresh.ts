/**
 * claude-oauth-refresh —— Claude.ai 订阅 OAuth access token 的 host 侧到期刷新。
 *
 * 为什么 host 要管刷新(cc >= 2.1.19x 语义变化):
 *   XDMaker 给 cc 子进程注入 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1(防 workdir
 *   settings.json 覆盖 app 注入的 provider 路由,见 env-builder.ts)。cc 2.1.198 起
 *   该 flag 的语义从「过滤 settings 来源的 provider env」扩大为「凭证也由 host 全权
 *   提供」——设了 flag 后 cc **完全不再读**系统凭证库(keychain / .credentials.json)
 *   的 claudeAiOauth;host 必须经 CLAUDE_CODE_OAUTH_TOKEN env 显式递入订阅 access
 *   token(官方桌面宿主协议)。env 递入的是纯 access token(cc 侧 refreshToken=null),
 *   cc 无法自行刷新,到期刷新责任随之转移到 host:
 *     - spawn 前:getAuthEnv 经 getOAuthForSpawn 注入现值(**不阻塞**——临期只触发
 *       后台刷新,新会话首响应不吃刷新 RTT;真撞上刷新失败就注旧 token,靠 401 回调兜底);
 *     - turn 中途 401:cc 经 SDK control 协议(oauth_token_refresh)回调 host
 *       (见 maker-core claude-code getOAuthToken),host 锁内比对后按需刷新;
 *     - 后台预续期:离过期 < EXPIRY_MARGIN_MS 提前刷,让 spawn 几乎总是缓存命中。
 *
 * 跨进程互斥(阻塞级约束):
 *   refresh token 是轮换制;并发刷新者不止本进程——用户终端里的 standalone `claude`
 *   (没被注 flag,自己会刷)、dev + release 双开的另一个 XDMaker 实例。基于旧值刷新
 *   会触发服务端 refresh-token 复用检测把两边同时登出,陈旧整块回写还会静默回滚
 *   凭证 blob 里 cc 的 mcpOAuth 等字段。cc 自己的刷新走跨进程锁协议
 *   (反编译 2.1.198:proper-lockfile,lockfilePath = <configDir>/.oauth_refresh.lock,
 *   stale 10s,冲突时 1-2s 退避重试最多 5 次)。host 刷新遵守**同一把锁**:
 *   锁内重读凭证库 → 别人已经刷过就直接用、不再刷 → 仍旧才刷 → 写回 → 释放。
 *   锁实现为 proper-lockfile 兼容语义:mkdir 原子建目录 = 持锁,mtime 超 stale 视为
 *   死锁可抢,持锁期间周期 touch 防被误判 stale。
 *
 * 刷新协议(对齐 cc 官方实现,字段/端点从 2.1.198 核实):
 *   POST https://platform.claude.com/v1/oauth/token  (JSON)
 *     { grant_type: "refresh_token", refresh_token, client_id, scope: "<空格分隔>" }
 *   200 → { access_token, refresh_token?(缺省沿用旧值), expires_in(秒), scope? }
 *   结果读改写回系统凭证库(claude-credentials-store,保留 blob 其它字段),与本地
 *   `claude` CLI 共享同一份凭证——谁先刷新都对双方生效;这也让 cc 401 恢复链的
 *   磁盘兜底(tengu_oauth_401_recovered_from_disk)自动成立。
 *
 * 失效收尾:
 *   - 登出:invalidate() 令 generation 递增 + 撤销预续期 timer,在途刷新完成后不写回
 *     ——否则「已断开」状态下在途刷新回写会让凭证复活;
 *   - invalid_grant(锁内重读仍旧 + 服务端明确拒绝)= refresh token 已被作废,刷新
 *     无望,经 onInvalidGrant 通知 adapter 走 invalidate 广播让 UI 提示重登,
 *     不让用户停在「显示已连接、会话连环 401」的假状态。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearClaudeAiOAuth,
  readClaudeAiOAuth,
  writeClaudeAiOAuth,
  type ClaudeAiOAuth,
} from './claude-credentials-store.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { outboundFetch } from './outbound-fetch.js';

const log = desktopMakerLogger.child('claude-oauth-refresh');

// 对齐 claude-oauth-login.ts 的 prod 常量(cc constants/oauth.ts PROD_OAUTH_CONFIG)。
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** 订阅身份 profile 端点(反编译 cc n0e:GET + Bearer,10s 超时)。 */
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TIMEOUT_MS = 10_000;

/** 距 expiresAt 不足此余量即视为「临期」:spawn 触发后台刷、预续期 timer 的提前量。 */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/**
 * 刷新 HTTP 超时。必须显著小于 cc 侧 oauth_token_refresh control 请求的 30s 超时
 * (反编译 eqf=30000),给锁等待(最多 ~7.5s)留出预算,让回调路径总耗时可控。
 */
const REFRESH_TIMEOUT_MS = 10_000;

// ── 跨进程锁参数(必须与 cc 的 proper-lockfile 配置一致,反编译 Lzr/Mzr) ────────
const LOCK_FILENAME = '.oauth_refresh.lock';
const LOCK_STALE_MS = 10_000;
/** 持锁期间 touch 周期 —— proper-lockfile 语义 update=stale/2,取更保守值防误判。 */
const LOCK_TOUCH_INTERVAL_MS = 4_000;
const LOCK_RETRY_MAX = 5;
const LOCK_RETRY_BASE_DELAY_MS = 1_000;
/**
 * 拿锁失败(健康持有者在刷)后的凭证轮询:持有者的刷新 HTTP 预算 10s 可能比我们
 * ~7.5s 的锁等待长,放弃前再等一小段捡它的写回结果,避免「差 1-2 秒」的 turn 失败。
 * 7.5s 锁等待 + 3s 轮询 ≈ 10.5s,仍在 401 回调 12s 预算内。
 */
const LOCK_LOSER_POLL_ATTEMPTS = 6;
const LOCK_LOSER_POLL_INTERVAL_MS = 500;

/** 预续期 timer 最短延迟 —— 防 expiresAt 异常值导致 0ms 自旋。 */
const PROACTIVE_MIN_DELAY_MS = 30_000;

interface RefreshTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** cc pCn 的 organization_type → subscriptionType 映射(逐字对齐反编译)。 */
const ORG_TYPE_TO_SUBSCRIPTION: Record<string, string> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_enterprise: 'enterprise',
  claude_team: 'team',
};

export interface SubscriptionProfile {
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

/**
 * best-effort 拉订阅身份 profile(subscriptionType / rateLimitTier)。
 *
 * 为什么需要:经 XDMaker 浏览器 OAuth 登录写入的凭证 subscriptionType 为 null——
 * 旧链路靠「cc 子进程读凭证后自行 refresh 时拉 profile 回填」,而本修复后 cc 不再
 * 读凭证库,回填责任随刷新一起转移到 host。协议对齐反编译 cc n0e/pCn:
 * GET /api/oauth/profile + Bearer,organization.organization_type 映射档位。
 * 失败返回 null(不阻塞刷新主流程,身份字段缺失只影响档位判定不影响鉴权)。
 */
export async function fetchSubscriptionProfile(
  accessToken: string,
  fetchFn: typeof fetch = outboundFetch,
): Promise<SubscriptionProfile | null> {
  try {
    const res = await fetchFn(PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const data = (await res.json()) as {
      organization?: { organization_type?: string; rate_limit_tier?: string };
    };
    const orgType = data.organization?.organization_type;
    return {
      subscriptionType: (orgType && ORG_TYPE_TO_SUBSCRIPTION[orgType]) || null,
      rateLimitTier: data.organization?.rate_limit_tier ?? null,
    };
  } catch (e) {
    log.warn('subscription profile fetch failed (best-effort)', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export interface ClaudeOAuthRefresherDeps {
  readOAuth: () => ClaudeAiOAuth | null;
  writeOAuth: (oauth: ClaudeAiOAuth) => void;
  fetchFn: typeof fetch;
  now: () => number;
  /** 跨进程锁所在目录(= cc config dir);锁路径 <lockDir>/.oauth_refresh.lock。 */
  lockDir: () => string;
  /** 锁冲突退避 sleep(测试注入 0 延迟)。 */
  sleep?: (ms: number) => Promise<void>;
  /** refresh token 被服务端作废(invalid_grant)时通知 —— adapter 接 invalidate 广播。 */
  onInvalidGrant?: () => void;
  /** 预续期开关(测试关掉避免悬挂 timer)。默认开。 */
  proactiveRenewal?: boolean;
}

export interface GetValidOAuthOptions {
  /**
   * true = cc 已经用当前 token 撞了 401(本地 expiresAt 判断不可信)。行为:进锁重读,
   * 凭证库里的 token 已比进锁前新 → 直接返回不刷(防多会话同时 401 引发连环旋转);
   * 仍是同一枚 → 单飞刷新;刷新失败返回 null,绝不把已知坏 token 再递回去。
   */
  forceRefresh?: boolean;
  /**
   * 撞 401 的那枚 token(会话 spawn 时注入 / 上次回调返回的)。凭证库当前值 ≠ 它时,
   * 说明后台预续期 / 其它会话早已换代,库值本身就是「新 token」—— 直接返回,即便
   * forceRefresh 也不再消耗一次轮换(长会话群体 401 时防串行连环旋转)。
   * 不传时退回「以库值为基线」的旧语义(仅锁内比对挡回调间并发)。
   */
  staleToken?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 刷新器工厂 —— 依赖注入版,single-flight / generation / timer 状态挂在实例闭包上
 * (测试各自 create 隔离)。生产用模块底部的默认实例。
 */
export function createClaudeOAuthRefresher(deps: ClaudeOAuthRefresherDeps): {
  getValidOAuth: (opts?: GetValidOAuthOptions) => Promise<ClaudeAiOAuth | null>;
  /** spawn 注入专用:立即返回现值,临期只触发后台刷新,绝不阻塞。 */
  getOAuthForSpawn: () => ClaudeAiOAuth | null;
  /** 登出 / 凭证作废时调:在途刷新不写回、撤销预续期 timer。 */
  invalidate: () => void;
  /** 订阅身份后台回填(登录后调):锁外拉 profile → 拿锁重读 → 缺才 merge 写回。 */
  backfillSubscriptionProfile: (accessToken: string) => Promise<void>;
} {
  const sleep = deps.sleep ?? defaultSleep;
  let inflight: Promise<ClaudeAiOAuth | null> | null = null;
  // generation:invalidate() 递增;在途刷新拿着进入时的 gen,完成时 gen 变了就丢弃结果。
  let generation = 0;
  let proactiveTimer: NodeJS.Timeout | null = null;

  // ── proper-lockfile 兼容的跨进程锁 ────────────────────────────────────────────
  function lockPath(): string {
    return path.join(deps.lockDir(), LOCK_FILENAME);
  }

  /** 尝试拿锁一次:mkdir 原子成功 = 持锁;EEXIST 且 mtime 超 stale → 清掉死锁重试。 */
  function tryAcquireOnce(): boolean {
    const p = lockPath();
    try {
      fs.mkdirSync(p);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 父目录(config dir)不存在:macOS 上仅经 XDMaker 浏览器 OAuth 登录的用户凭证
        // 在 Keychain,~/.claude 可能从未被创建 —— 锁拿不到会导致刷新永远被跳过,
        // 过期后订阅会话全断。先建父目录再重试一次(recursive 幂等)。
        try {
          fs.mkdirSync(deps.lockDir(), { recursive: true });
          fs.mkdirSync(p);
          return true;
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') {
            log.warn('oauth refresh lock mkdir failed after creating config dir', {
              error: e2 instanceof Error ? e2.message : String(e2),
            });
            return false;
          }
          // EEXIST → 建父目录期间他人抢到锁,走下方 stale 判定
        }
      } else if (code !== 'EEXIST') {
        // 其它异常:锁目录建不出来就退化为「拿不到锁」,走锁外语义,不炸调用方。
        log.warn('oauth refresh lock mkdir failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    }
    try {
      const st = fs.statSync(p);
      if (deps.now() - st.mtimeMs <= LOCK_STALE_MS) return false; // 健康锁 → 退避等待
      // stale 锁(持有者已死)接管 —— claim → compare → commit/rollback,无 TOCTOU:
      //  1) claim: rename 原子转移占有权(同一路径只有一个竞争者 rename 成功,失败者
      //     ENOENT 退避)。⚠️ rename 走的可能是「st 之后刚被别人重建的健康新锁」,所以
      //     此刻还不能删;
      //  2) compare: 在 tomb 上比对 mtime —— tomb 已被本进程独占,比对无竞态。mtime
      //     等于刚才判 stale 的值 = 确实是那把死锁;
      //  3) commit: rm tomb + mkdir 原子竞争建新锁;
      //  4) rollback: mtime 不符(claim 到了别人的健康锁)→ rename 原样还回。还锁若撞
      //     EEXIST(第三者已建新锁)则清掉 tomb 响亮记错 —— 三方同时抢同一把 stale 锁
      //     的嵌套竞态,受害者的 touch/release 对 ENOENT 均静默,不炸。
      // (review 2026-07-04 P2 ×2:先前的「re-stat 后无条件 rename」在 re-stat 与
      //  rename 之间仍有单 syscall 窗口;compare-after-claim 把比对挪到独占对象上,
      //  主路径彻底原子。)
      const tomb = path.join(
        deps.lockDir(),
        `.oauth_refresh.stale-${process.pid}-${deps.now().toString(36)}`,
      );
      fs.renameSync(p, tomb); // claim(原子)
      const claimed = fs.statSync(tomb);
      if (claimed.mtimeMs !== st.mtimeMs) {
        // claim 到的是别人刚重建的健康锁 → 原样还回
        try {
          fs.renameSync(tomb, p);
        } catch {
          try {
            fs.rmSync(tomb, { recursive: true, force: true });
          } catch { /* 尽力清理 */ }
          log.error('oauth refresh lock rollback failed (three-way stale takeover race); a healthy holder lost its lock');
        }
        return false;
      }
      try {
        fs.rmSync(tomb, { recursive: true, force: true });
      } catch {
        /* tomb 残留是无害空目录,不影响锁语义 */
      }
      fs.mkdirSync(p);
      return true;
    } catch {
      /* 竞态(别人同时抢 / rename ENOENT / mkdir EEXIST)→ 本轮失败,退避后重试 */
    }
    return false;
  }

  interface LockHandle {
    release: () => void;
    /** 锁已易主(inode 变化 / 目录消失)—— 持有者必须放弃写回。 */
    isCompromised: () => boolean;
  }

  /**
   * 拿锁 + 持锁期间周期 touch。返回句柄;拿不到(对齐 cc 重试 5 次)返回 null。
   * ownership 守卫:mkdir 成功后记录锁目录 inode;touch 时 inode 变化 / ENOENT =
   * 锁被别人接管(嵌套竞态的最后兜底)→ 置 compromised、停止 touch(绝不 touch 别人
   * 的锁)、release 不删;refreshWithLock 写回前检查该标志放弃写回 —— 把理论上的
   * 「双持锁双写」降级为「单写 + 一方放弃」(对齐 proper-lockfile onCompromised 语义)。
   */
  async function acquireLock(): Promise<LockHandle | null> {
    for (let attempt = 0; attempt <= LOCK_RETRY_MAX; attempt++) {
      if (tryAcquireOnce()) {
        let myIno: bigint | number | null = null;
        try {
          myIno = fs.statSync(lockPath()).ino;
        } catch {
          /* stat 失败 → 无法校验归属,保守按可疑处理 */
        }
        let compromised = myIno === null;
        const touch = setInterval(() => {
          try {
            const st = fs.statSync(lockPath());
            if (myIno !== null && st.ino !== myIno) {
              compromised = true;
              clearInterval(touch);
              log.warn('oauth refresh lock compromised (taken over by another process); abandoning write-back');
              return;
            }
            const t = new Date(deps.now());
            fs.utimesSync(lockPath(), t, t);
          } catch {
            compromised = true;
            clearInterval(touch);
          }
        }, LOCK_TOUCH_INTERVAL_MS);
        return {
          isCompromised: () => compromised,
          release: () => {
            clearInterval(touch);
            if (compromised) return; // 锁已是别人的,不许删
            try {
              const st = fs.statSync(lockPath());
              if (myIno !== null && st.ino !== myIno) return;
              fs.rmdirSync(lockPath());
            } catch {
              /* 已被抢走 / 已释放 → no-op */
            }
          },
        };
      }
      if (attempt < LOCK_RETRY_MAX) {
        // 对齐 cc Mzr:1000ms + 抖动退避。抖动用 attempt 序号而非随机数即可满足打散目的。
        await sleep(LOCK_RETRY_BASE_DELAY_MS + (attempt * 250));
      }
    }
    log.warn('oauth refresh lock acquire timed out; skip refreshing (holder still active)');
    return null;
  }

  // ── 刷新请求(纯协议层) ─────────────────────────────────────────────────────
  async function requestRefresh(
    current: ClaudeAiOAuth,
  ): Promise<{ oauth: ClaudeAiOAuth | null; invalidGrant: boolean }> {
    const refreshToken = current.refreshToken;
    if (!refreshToken) return { oauth: null, invalidGrant: false };
    const scopes = Array.isArray(current.scopes) ? current.scopes.filter(Boolean) : [];
    const startedAt = deps.now();
    let res: Response;
    try {
      res = await deps.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
          ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
        }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (e) {
      log.warn('claude oauth refresh request failed (network)', {
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: deps.now() - startedAt,
      });
      return { oauth: null, invalidGrant: false };
    }
    if (res.status !== 200) {
      let errorCode = '';
      try {
        const body = (await res.json()) as { error?: string };
        errorCode = typeof body.error === 'string' ? body.error : '';
      } catch {
        /* 非 JSON 响应 → 只留 status */
      }
      log.error('claude oauth refresh rejected by server', {
        status: res.status,
        errorCode,
        elapsedMs: deps.now() - startedAt,
      });
      return { oauth: null, invalidGrant: errorCode === 'invalid_grant' };
    }
    let data: RefreshTokenResponse;
    try {
      data = (await res.json()) as RefreshTokenResponse;
    } catch (e) {
      log.error('claude oauth refresh: malformed 200 response', {
        error: e instanceof Error ? e.message : String(e),
      });
      return { oauth: null, invalidGrant: false };
    }
    if (!data.access_token) {
      log.error('claude oauth refresh: 200 response missing access_token');
      return { oauth: null, invalidGrant: false };
    }
    const next: ClaudeAiOAuth = {
      ...current,
      accessToken: data.access_token,
      // 服务端可能旋转 refresh token;未返回时沿用旧值(对齐 cc 行为)。
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt:
        typeof data.expires_in === 'number' ? deps.now() + data.expires_in * 1000 : null,
      scopes: data.scope ? data.scope.split(' ').filter(Boolean) : current.scopes,
    };
    // ⚠️ 此处不做订阅身份回填 —— rotated refresh token 必须最快落盘(写回在调用方
    // refreshWithLock),profile RTT(最长 10s)不能夹在「刷」与「写回」之间:旧 refresh
    // token 此刻已在服务端作废,落盘前进程崩溃 = 凭证库剩已作废值 → 下次 invalid_grant
    // 被迫重登;也不能拉长锁临界区 / 吃掉 401 回调 12s 预算。回填走锁外的
    // backfillSubscriptionProfile(review 2026-07-04 P2)。
    return { oauth: next, invalidGrant: false };
  }

  /**
   * 订阅身份回填(锁外后台,best-effort):经 XDMaker 浏览器 OAuth 登录的凭证
   * subscriptionType/rateLimitTier 为 null(旧链路由 cc 刷新时补全,本修复后 cc 不读
   * 凭证库)。刷新主流程落盘后异步触发:锁外拉 profile(纯网络,不占临界区)→ 重新拿锁
   * → 锁内重读最新凭证 → 字段仍缺才 merge 写回(只补身份字段、不动 token —— 期间他人
   * 刷新出的新 token 不会被覆盖)。失败静默,下次刷新再试。
   */
  async function backfillSubscriptionProfile(accessToken: string): Promise<void> {
    const gen = generation;
    const profile = await fetchSubscriptionProfile(accessToken, deps.fetchFn);
    if (!profile || (profile.subscriptionType == null && profile.rateLimitTier == null)) return;
    if (generation !== gen) return; // 拉取期间登出 → 丢弃
    const lock = await acquireLock();
    if (!lock) return;
    try {
      if (generation !== gen) return;
      if (lock.isCompromised()) return;
      const fresh = deps.readOAuth();
      if (!fresh?.accessToken) return;
      if (fresh.accessToken !== accessToken) {
        // 凭证库在 profile 在途期间被换过(换账号登录 / 又一轮刷新)。profile 数据只
        // 允许贴到「拉它时所用那枚 token」对应的凭证上 —— token 轮换与换账号无法
        // 区分,保守丢弃防跨账号档位污染;字段仍缺的话下次刷新会再补。
        log.info('subscription profile backfill discarded: credential changed while fetching');
        return;
      }
      if (fresh.subscriptionType != null && fresh.rateLimitTier != null) return;
      deps.writeOAuth({
        ...fresh,
        subscriptionType: fresh.subscriptionType ?? profile.subscriptionType,
        rateLimitTier: fresh.rateLimitTier ?? profile.rateLimitTier,
      });
      log.info('subscription profile backfilled', {
        subscriptionType: fresh.subscriptionType ?? profile.subscriptionType,
      });
    } catch (e) {
      log.warn('subscription profile backfill write failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      lock.release();
    }
  }

  // ── 锁内刷新流程(single-flight 包裹) ─────────────────────────────────────────
  /**
   * @param preLockToken 进锁前观察到的 accessToken —— 锁内重读若已不同,说明其它
   *   进程/调用刚刷过,直接采用新值不再刷(评审「比对后按需刷新」语义,防连环旋转)。
   * @param force 锁内重读后即使未临期也刷(401 场景本地过期判断不可信,但仅当 token
   *   仍是进锁前那枚 —— 已换新的直接信任)。
   */
  async function refreshWithLock(
    preLockToken: string,
    force: boolean,
  ): Promise<ClaudeAiOAuth | null> {
    const gen = generation;
    const lock = await acquireLock();
    if (!lock) {
      // 拿不到锁:持有者(本机另一实例 / standalone claude)正在刷,其 HTTP 预算(10s)
      // 可能比我们的锁等待(~7.5s)长 —— 放弃前在剩余回调预算内轮询凭证库,写回一落地
      // 就用,避免「对方 1-2 秒后就写好、我们却已 null 掉整个 turn」。轮询到头仍没有
      // 新值才放弃(调用方按 force 语义降级)。
      for (let i = 0; i <= LOCK_LOSER_POLL_ATTEMPTS; i++) {
        const reread = deps.readOAuth();
        if (reread?.accessToken && reread.accessToken !== preLockToken) return reread;
        if (generation !== gen) return null; // 等待期间登出
        if (i < LOCK_LOSER_POLL_ATTEMPTS) await sleep(LOCK_LOSER_POLL_INTERVAL_MS);
      }
      return null;
    }
    try {
      const fresh = deps.readOAuth();
      if (!fresh?.accessToken) return null;
      if (fresh.accessToken !== preLockToken) {
        // 别人已经刷过(锁内重读是唯一可信判定)→ 直接用,不再消耗一次轮换。
        log.info('claude oauth refresh skipped: credential already renewed by another writer');
        return fresh;
      }
      const expiresAt = typeof fresh.expiresAt === 'number' ? fresh.expiresAt : null;
      const expiringSoon = expiresAt !== null && expiresAt - deps.now() < EXPIRY_MARGIN_MS;
      if (!force && !expiringSoon) return fresh;

      const startedAt = deps.now();
      const { oauth: next, invalidGrant } = await requestRefresh(fresh);
      if (generation !== gen) {
        // 刷新期间发生登出:结果作废,绝不写回(否则「已断开」状态凭证复活)。
        log.info('claude oauth refresh discarded: invalidated mid-flight (logout)');
        return null;
      }
      if (!next) {
        if (invalidGrant) {
          // 与下方成功路径同款换代守卫:invalid_grant 报的是**本次刷新用的那枚**
          // refresh token;若 HTTP 在途期间凭证库已被换账号登录替换,invalidate 会把
          // 刚登录的新账号一并清掉 —— 先重读比对,库已换则采信新凭证、不触发失效。
          const postFail = deps.readOAuth();
          if (
            postFail?.accessToken &&
            (postFail.accessToken !== fresh.accessToken ||
              postFail.refreshToken !== fresh.refreshToken)
          ) {
            log.warn('invalid_grant hit a replaced credential; keeping the newly stored one');
            return postFail;
          }
          // 库仍是失败那套凭证且服务端明确作废 → 刷新无望,通知 UI 重登。
          log.error('claude oauth refresh token revoked by server (invalid_grant)');
          try {
            deps.onInvalidGrant?.();
          } catch (e) {
            log.warn('onInvalidGrant handler threw', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return null;
      }
      if (lock.isCompromised()) {
        // 锁在刷新期间易主(嵌套竞态兜底):对方可能正持锁刷新,双写会互相回滚 ——
        // 放弃写回与返回,把「双持锁双写」降级为「单写 + 本方放弃」。
        log.warn('claude oauth refresh discarded: lock compromised mid-refresh');
        return null;
      }
      const postFetch = deps.readOAuth();
      if (
        !postFetch?.accessToken ||
        postFetch.accessToken !== fresh.accessToken ||
        postFetch.refreshToken !== fresh.refreshToken
      ) {
        // 刷新 HTTP 在途期间凭证库被外部替换 —— 换账号登录 / standalone claude 登录
        // 都不经本锁、不 bump generation(登出走 disconnect 已被 gen 检查拦住)。
        // 用旧账号的刷新结果写回会静默撤销用户换号 → 丢弃本次结果,采信库中当前凭证。
        log.warn('claude oauth refresh discarded: credential store replaced mid-refresh (account switch?)');
        return postFetch?.accessToken ? postFetch : null;
      }
      try {
        deps.writeOAuth(next);
      } catch (e) {
        // 写回失败也返回内存新凭证让本次能用;若服务端旋转了 refresh token,凭证库里
        // 留的是已作废旧值,下次刷新会 invalid_grant → 被迫重登,必须响亮记错。
        log.error('claude oauth refresh: token refreshed but credential store write failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      log.info('claude oauth token refreshed', {
        trigger: force ? 'callback-or-force' : 'expiry',
        rotatedRefreshToken: next.refreshToken !== fresh.refreshToken,
        expiresAt: next.expiresAt,
        elapsedMs: deps.now() - startedAt,
      });
      scheduleProactiveRenewal(next);
      // 身份字段缺失 → 锁外后台回填(token 已落盘,不占本次临界区 / 回调预算)。
      if (next.subscriptionType == null || next.rateLimitTier == null) {
        void backfillSubscriptionProfile(next.accessToken).catch((e) =>
          log.warn('subscription profile backfill failed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      return next;
    } finally {
      lock.release();
    }
  }

  // ── 预续期:离过期 < margin 提前后台刷,spawn 几乎永远缓存命中 ────────────────
  function scheduleProactiveRenewal(oauth: ClaudeAiOAuth | null): void {
    if (deps.proactiveRenewal === false) return;
    if (proactiveTimer) {
      clearTimeout(proactiveTimer);
      proactiveTimer = null;
    }
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null;
    if (!oauth?.refreshToken || expiresAt === null) return;
    const delay = Math.max(expiresAt - deps.now() - EXPIRY_MARGIN_MS, PROACTIVE_MIN_DELAY_MS);
    const gen = generation;
    proactiveTimer = setTimeout(() => {
      proactiveTimer = null;
      if (generation !== gen) return;
      log.info('claude oauth proactive renewal firing', { expiresAt });
      void getValidOAuth().catch((e) =>
        log.warn('proactive renewal failed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }, delay);
    // Electron main 常驻,unref 防 timer 阻止测试进程退出。
    proactiveTimer.unref?.();
  }

  // ── 对外 API ─────────────────────────────────────────────────────────────────
  async function getValidOAuth(opts?: GetValidOAuthOptions): Promise<ClaudeAiOAuth | null> {
    const current = deps.readOAuth();
    if (!current?.accessToken) return null;

    if (opts?.staleToken && current.accessToken !== opts.staleToken) {
      // 库值已比失败的那枚新(后台预续期 / 其它会话换代)→ 直接交出,不消耗轮换。
      return current;
    }

    const expiresAt = typeof current.expiresAt === 'number' ? current.expiresAt : null;
    const expiringSoon = expiresAt !== null && expiresAt - deps.now() < EXPIRY_MARGIN_MS;
    if (!opts?.forceRefresh && !expiringSoon) {
      scheduleProactiveRenewal(current);
      return current;
    }

    if (!current.refreshToken) {
      // 无 refresh token 无从刷新:非强制场景把现有 token 原样交出(可能还有残余寿命);
      // 强制场景(401 后)返回 null 让上层报 auth 错。
      return opts?.forceRefresh ? null : current;
    }

    if (!inflight) {
      inflight = refreshWithLock(current.accessToken, opts?.forceRefresh ?? false).finally(
        () => {
          inflight = null;
        },
      );
    }
    const refreshed = await inflight;
    if (refreshed) return refreshed;
    // 刷新失败:非强制场景退回现有 token(临期未必已失效,让请求自然成败);
    // 强制场景绝不复用已确认失效的 token。
    return opts?.forceRefresh ? null : current;
  }

  function getOAuthForSpawn(): ClaudeAiOAuth | null {
    const current = deps.readOAuth();
    if (!current?.accessToken) return null;
    const expiresAt = typeof current.expiresAt === 'number' ? current.expiresAt : null;
    const expiringSoon = expiresAt !== null && expiresAt - deps.now() < EXPIRY_MARGIN_MS;
    if (expiringSoon && current.refreshToken) {
      // 后台单飞刷新,不 await —— spawn 首响应不吃刷新 RTT(规则 10 返回速度约束)。
      // 本次注入旧 token:若它已彻底失效,401 回调链路会兜底换新。
      void getValidOAuth().catch((e) =>
        log.warn('background refresh (spawn-triggered) failed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } else {
      scheduleProactiveRenewal(current);
    }
    return current;
  }

  function invalidate(): void {
    generation += 1;
    if (proactiveTimer) {
      clearTimeout(proactiveTimer);
      proactiveTimer = null;
    }
    log.info('claude oauth refresher invalidated (logout / credential cleared)');
  }

  return { getValidOAuth, getOAuthForSpawn, invalidate, backfillSubscriptionProfile };
}

// ── 生产默认实例(懒初始化,import 零副作用 —— 见 authAdaptersImportPurity 约定) ──

/** 默认 config dir(prod、无 CLAUDE_CONFIG_DIR override)= ~/.claude,与凭证库同根。 */
function defaultLockDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

let defaultRefresher: ReturnType<typeof createClaudeOAuthRefresher> | null = null;
let invalidGrantHandler: (() => void) | null = null;

function getDefaultRefresher(): ReturnType<typeof createClaudeOAuthRefresher> {
  if (!defaultRefresher) {
    defaultRefresher = createClaudeOAuthRefresher({
      readOAuth: readClaudeAiOAuth,
      writeOAuth: writeClaudeAiOAuth,
      // 刷新与 profile 回填都打境外端点,必须吃系统代理(见 outbound-fetch.ts)。
      fetchFn: outboundFetch,
      now: Date.now,
      lockDir: defaultLockDir,
      onInvalidGrant: () => invalidGrantHandler?.(),
    });
  }
  return defaultRefresher;
}

/**
 * 取「当前有效」的 Claude.ai 订阅 OAuth 凭证:未登录 → null;临期 / forceRefresh →
 * 跨进程锁内比对后按需刷新;失败按 forceRefresh 语义降级(见 GetValidOAuthOptions)。
 */
export function getValidClaudeAiOAuth(
  opts?: GetValidOAuthOptions,
): Promise<ClaudeAiOAuth | null> {
  return getDefaultRefresher().getValidOAuth(opts);
}

/** spawn 注入专用:立即返回现值不阻塞;临期触发后台刷新。 */
export function getClaudeAiOAuthForSpawn(): ClaudeAiOAuth | null {
  return getDefaultRefresher().getOAuthForSpawn();
}

/** 登出 / 凭证清除时调:放弃在途刷新写回、撤销预续期 timer。 */
export function invalidateClaudeOAuthRefresh(): void {
  defaultRefresher?.invalidate();
}

/**
 * 后台补订阅身份字段(登录后 fire-and-forget 调用):锁外拉 profile → 拿锁 → 锁内
 * 重读 → 字段仍缺才 merge 写回。login 流程不得 await 它(登录成功页不吃 profile RTT,
 * review 2026-07-04 P1);失败静默,首次刷新时会再补。
 */
export function backfillClaudeSubscriptionProfile(accessToken: string): Promise<void> {
  return getDefaultRefresher().backfillSubscriptionProfile(accessToken);
}

/**
 * 断开 Claude.ai 订阅的唯一正确入口:先失效刷新器(generation++,在途刷新不写回、
 * 预续期 timer 撤销),再清系统凭证。**所有**清除订阅凭证的调用点(adapter.logout、
 * 设置页 CLAUDE_OAUTH_LOGOUT IPC、未来新增入口)必须走本函数而不是直接
 * clearClaudeAiOAuth —— 否则「已断开」状态下在途刷新回写会让凭证复活
 * (review 2026-07-04 P2:IPC 路径曾绕过失效联动)。
 * 顺序约束:invalidate 必须先于 clear,防 clear 与在途写回的窗口竞态;clear 抛错
 * (写后校验失败)原样上抛由调用方决定 UI 反馈,多 bump 的 generation 幂等无害。
 */
export function disconnectClaudeAiOAuth(): void {
  invalidateClaudeOAuthRefresh();
  clearClaudeAiOAuth();
}

/** refresh token 被服务端作废时的通知接线(auth-adapters 装配,内存操作零副作用)。 */
export function setClaudeOAuthInvalidGrantHandler(handler: (() => void) | null): void {
  invalidGrantHandler = handler;
}
