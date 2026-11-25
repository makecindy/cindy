/**
 * repoAccountResolver — 本机登录了多个 gh 账号时,按仓库选该用哪个账号读 PR。
 *
 * 动机:有人用不同 GitHub 账号维护不同项目。私有仓库对没有权限的账号返回 404
 * (不是 403),只认活跃账号就会把「另一个账号能看到」的 PR 显示成不存在。
 *
 * 约束:
 *   - 活跃账号仍是默认;只有它 404 之后才按仓库去试其它已登录账号,正常路径零额外请求。
 *   - 判断依据是**仓库**权限,不是某一条 PR:否则一次查错的 PR 编号会把整个仓库记成读不到。
 *   - 选中的账号按仓库记住(默认 30 分钟);确认所有账号都读不到时也记 10 分钟。
 *   - 没查成(网络/限流/5xx/账号列表读不到)不算「读不到」,不写失败记忆,下一次刷新重试。
 *   - 记着的账号也会失去权限:它自己 404 时按失败的那份 token 重新探测,而不是一直用它。
 *   - 401/403 不换账号:凭证失效、限流和无权限是不同的事,不能靠换身份掩盖。
 */

import type { PrIdentity } from '@cindy/maker-shared';
import type { GhCliLoginList, GhCliTokenReadResult } from './ghCliTokenSource.js';

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MISS_TTL_MS = 10 * 60_000;
/** 长期缓存的全局上限:TTL 只在同一仓库再次访问时生效,不设就随仓库数无界增长。 */
const MAX_TRACKED_REPOS = 200;

export interface RepoAccountDeps {
  /** 当前活跃账号(原 gh → 插件 PAT → GitHub App 的同一条链)。 */
  readToken(): Promise<GhCliTokenReadResult>;
  /** 本机登录的账号;`null` 表示这次探测没做成(不能当成「没有备用账号」)。 */
  listLogins(): Promise<GhCliLoginList | null>;
  readTokenForLogin(login: string): Promise<string | null>;
  /** 这个 token 对这个仓库有没有读权限;'unknown' 表示没查成,不能当成没有权限。 */
  repoAccess(token: string, pr: PrIdentity): Promise<boolean | 'unknown'>;
  ttlMs?: number;
  missTtlMs?: number;
  now?: () => number;
}

export interface RepoAccountResolver {
  /** 这个仓库该用哪个账号:记过的账号优先,否则活跃账号。永不抛错。 */
  tokenFor(pr: PrIdentity): Promise<GhCliTokenReadResult>;
  /**
   * 404 之后换一个能读到它的账号并记住;没有这样的账号时返回 null。永不抛错。
   * failedToken 是刚被拒的那份凭证:如果它就是记住的账号,丢掉这个记忆重新探测。
   */
  recover(pr: PrIdentity, failedToken?: string): Promise<GhCliTokenReadResult | null>;
  reset(): void;
}

export function createRepoAccountResolver(deps: RepoAccountDeps): RepoAccountResolver {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const missTtl = deps.missTtlMs ?? DEFAULT_MISS_TTL_MS;
  const now = deps.now ?? Date.now;
  const chosen = new Map<string, { login: string; until: number }>();
  const missing = new Map<string, number>();
  const pending = new Map<string, Promise<GhCliTokenReadResult | null>>();
  const key = (pr: PrIdentity) => `${pr.owner}/${pr.repo}`.toLowerCase();
  // 登录态变化会重置缓存;重置前发起的探测不能把旧结果写回来。
  let generation = 0;

  /** 超过上限时丢掉最早写入的仓库;TTL 命中只在同一仓库访问时才会清理。 */
  function remember<K, V>(map: Map<K, V>, k: K, value: V): void {
    if (map.size >= MAX_TRACKED_REPOS && !map.has(k)) map.delete(map.keys().next().value!);
    map.set(k, value);
  }

  async function saved(pr: PrIdentity): Promise<GhCliTokenReadResult | null> {
    const k = key(pr);
    const hit = chosen.get(k);
    if (!hit) return null;
    if (hit.until <= now()) {
      chosen.delete(k);
      return null;
    }
    const token = await deps.readTokenForLogin(hit.login).catch(() => null);
    if (token) return { ok: true, token };
    // 那个账号登出了:忘掉它,回到活跃账号。
    chosen.delete(k);
    return null;
  }

  async function find(
    pr: PrIdentity,
    failedToken?: string,
    gen: number = generation,
  ): Promise<GhCliTokenReadResult | null> {
    const k = key(pr);
    // 这个仓库已经选好账号了:直接用,不必再探一遍。
    const known = await saved(pr).catch(() => null);
    if (known) return known;
    if ((missing.get(k) ?? 0) > now()) return null;
    let unknown = false;
    const active = await deps.readToken();
    const listed = await deps.listLogins();
    // 账号列表没探测成功:整体当没查成,不留失败记忆(下次重新探测)。
    if (!listed) return null;
    for (const login of listed.logins) {
      const token = await deps.readTokenForLogin(login);
      // 账号在列表里但读不到它的 token(钥匙串/子进程失败)不等于「这个账号读不到仓库」,
      // 不能据此写失败记忆。
      if (!token) {
        unknown = true;
        continue;
      }
      // 刚被拒的凭证已经单独复核过;没有它的时候按老规矩跳过活跃账号。
      if (token === failedToken || (!failedToken && active.ok && active.token === token)) continue;
      const access = await deps.repoAccess(token, pr);
      if (access === 'unknown') {
        unknown = true;
        continue;
      }
      if (!access) continue;
      if (gen !== generation) return null;
      remember(chosen, k, { login, until: now() + ttl });
      missing.delete(k);
      return { ok: true, token };
    }
    // 没查成、列表不完整,或者登录态刚变过:不留下失败记忆,下一次刷新重新探测。
    if (unknown || !listed.complete || gen !== generation) return null;
    remember(missing, k, now() + missTtl);
    return null;
  }

  return {
    async tokenFor(pr: PrIdentity): Promise<GhCliTokenReadResult> {
      return (await saved(pr)) ?? deps.readToken();
    },
    async recover(pr: PrIdentity, failedToken?: string): Promise<GhCliTokenReadResult | null> {
      const k = key(pr);
      const gen = generation;
      const inflight = pending.get(k);
      if (inflight) return inflight;
      // 同一仓库的多条 PR 共用一次探测。
      const p = (async () => {
        // 先复核「刚被拒的那份凭证」本身能不能读这个仓库:PR 编号写错或 PR 已删时,
        // PR 接口同样回 404,那不是权限问题,不该因此在这个仓库上换账号或写失败记忆。
        // 只有确定「读不到」才继续换账号;没查成("unknown")不留任何缓存结论。
        if (failedToken && (await deps.repoAccess(failedToken, pr)) !== false) return null;
        // 探测期间登录态变了:这次恢复已经过期,不能删掉新选择、也不能写入新结果。
        if (gen !== generation) return null;
        // 能走到这一步就是因为这个 token 被拒了,而它可能就是记住的选择。
        // 不先丢掉,find() 会把同一个 token 原样取回来,后面的账号探测一次都不跑。
        chosen.delete(k);
        return find(pr, failedToken, gen);
      })()
        .catch(() => null)
        .finally(() => {
          if (pending.get(k) === p) pending.delete(k);
        });
      pending.set(k, p);
      return p;
    },
    reset() {
      generation += 1;
      chosen.clear();
      missing.clear();
      pending.clear();
    },
  };
}
