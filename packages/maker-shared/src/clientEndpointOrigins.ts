// ── 缓存端点的受信任域约束 ──────────────────────────────────────────────────

/**
 * **各构建区域的端点域**——离线缓存的信任锚点,写死在源码里。
 *
 * 为什么不从自举基址「去掉最左一段」推导(第一次 review 抓到):那样做在多段公共后缀上
 * 会**放宽**信任。`https://example.co.uk` 去掉一段得到 `co.uk`,于是任何人注册的
 * `attacker.co.uk` 都被判成可信。要正确推导注册域必须查公共后缀表(PSL);为一处启动期
 * 校验引入 PSL 数据不划算,而且推导本身并不比一份显式清单更可靠。
 *
 * 为什么必须**按区域分开**、不能给一个「两个域都信」的并集(第二次 review 抓到,这是
 * 上一版的真实漏洞):两份线上清单都**没有** `region` 字段,而 `region` 本身也是清单里
 * 的、未认证的数据。并集 + 缺失 region 的组合意味着——CN 构建下,攻击者只要伪造一份
 * sourceUrl 匹配 CN 的缓存、把 `authApiBaseUrl` 换成 Global 的**真实**服务
 * (`https://auth.cindy.app`),就能通过全部校验;用户点离线启动后,CN 的 token 会被
 * 发到 Global 区域。跨区 token 误发正是 auth-realm 设计里最要防的事。
 *
 * 这些常量是**安全常量**(性质同证书固定),不是"生产端点地址"——shared/endpoints.ts
 * 不保存业务端点是为了让端点能远程改;信任锚点恰恰**不能**远程改,否则它就不是锚点。
 *
 * 域名迁移时必须同步更新这里。忘了更新的后果是 fail closed——新域名的缓存被判不可信、
 * 离线按钮消失,并由 findBootstrapHostOutsideTrustedDomains 在启动日志里报出来;
 * 绝不会反过来继续信任别的东西。
 */
export const REGION_ENDPOINT_DOMAIN: Readonly<Record<'cn' | 'global', string>> =
  {
    cn: 'cindy.com.cn',
    global: 'cindy.app',
  };

/**
 * 跨区共享的 hook 服务:两份清单(含 CN)都指向 cindy.app,所以只有这几个 hook key
 * 允许落在 Global 域。**别往这里加 key** —— 每加一个就等于允许该端点跨区,而这个集合之外
 * 的所有端点(尤其 auth / device-link / oauth-broker / model-access / voice)必须锁在
 * 本构建区域,否则就回到上面说的跨区 token 误发。
 */
export const CROSS_REGION_ENDPOINT_KEYS: ReadonlySet<string> = new Set([
  'slackHookWsUrl',
  'telegramHookWsUrl',
  'xHookWsUrl',
]);

/** 缓存端点的来源策略:按 key 决定它允许落在哪个域。 */
export interface CachedEndpointOriginPolicy {
  /** 本构建区域的端点域(REGION_ENDPOINT_DOMAIN[buildRegion])。 */
  regionDomain: string;
  /** 跨区共享 hook 允许落在的域(固定是 Global 域)。 */
  crossRegionDomain: string;
}

/** 某个 key 允许落在的域。 */
function allowedDomainForKey(
  key: string,
  policy: CachedEndpointOriginPolicy,
): string {
  return CROSS_REGION_ENDPOINT_KEYS.has(key)
    ? policy.crossRegionDomain
    : policy.regionDomain;
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * 自检:构建期烘焙的自举基址是否都落在受信任域内。返回第一个越界的主机(供日志),
 * 全部落在域内返回 null。
 *
 * 它把「写死的域名清单」和「构建实际使用的基址」钉在一起:域名迁移后如果忘了更新
 * 清单,这里会在启动日志里明确报出来,而不是让离线出口静默失效到没人知道为止。
 */
export function findBootstrapHostOutsideTrustedDomains(
  bootstrapBaseUrls: readonly string[],
  trustedDomains: readonly string[] = Object.values(REGION_ENDPOINT_DOMAIN),
): string | null {
  for (const baseUrl of bootstrapBaseUrls) {
    if (!baseUrl?.trim()) continue;
    const host = hostOf(baseUrl);
    if (!host) return baseUrl;
    if (!isHostWithinDomain(host, trustedDomains)) return host;
  }
  return null;
}

function isHostWithinDomain(host: string, domains: readonly string[]): boolean {
  return domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/**
 * 检查一份**缓存**端点集合是否全部落在受信任域内。返回第一个越界的 key(供日志),
 * 全部合规返回 null。空值跳过(缺失端点本就归一成空串)。
 *
 * 只用于缓存路径:网络路径的清单来自烘焙 https 基址、由 TLS 认证来源,不需要这层
 * 约束,加上反而会在合法改配置时误伤。
 */
export function findUntrustedCachedEndpoint(
  endpoints: Readonly<Record<string, string>>,
  policy: CachedEndpointOriginPolicy,
): string | null {
  if (!policy.regionDomain || !policy.crossRegionDomain)
    return 'origin-policy-unavailable';
  for (const [key, value] of Object.entries(endpoints)) {
    if (!value) continue;
    const host = hostOf(value);
    if (host === null) return key;
    if (!isHostWithinDomain(host, [allowedDomainForKey(key, policy)]))
      return key;
  }
  return null;
}
