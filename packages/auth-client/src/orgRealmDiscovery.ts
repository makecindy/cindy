import { AuthApiError } from "./client.js";
import type { AuthRegion, SsoOrgDiscovery } from "./types.js";

export interface SsoOrgDiscoveryClient {
  discoverSsoOrg(org: string): Promise<SsoOrgDiscovery>;
}

export type SsoOrgRealmClients = Record<AuthRegion, SsoOrgDiscoveryClient>;

export interface SsoOrgRealmDiscovery {
  region: AuthRegion;
  discovery: SsoOrgDiscovery;
}

function isNotFound(reason: unknown): boolean {
  return reason instanceof AuthApiError && reason.code === "ORG_SSO_NOT_FOUND";
}

/**
 * 同时探测国内与国际 auth-server，并以 fail-closed 规则选择企业所在区域。
 *
 * 只有「一侧成功、另一侧明确 ORG_SSO_NOT_FOUND」可以继续。任一侧网络失败、
 * 超时、响应非法或 region 不匹配都不能拿另一侧的成功结果猜测，避免故障期间
 * 把同名企业路由到错误数据面。
 */
export async function discoverSsoOrgRealm(
  org: string,
  clients: SsoOrgRealmClients,
): Promise<SsoOrgRealmDiscovery> {
  const [cn, global] = await Promise.allSettled([
    clients.cn.discoverSsoOrg(org),
    clients.global.discoverSsoOrg(org),
  ]);

  if (cn.status === "fulfilled" && global.status === "fulfilled") {
    throw new AuthApiError(
      "ORG_REALM_AMBIGUOUS",
      409,
      "Enterprise identifier exists in both auth regions",
    );
  }
  if (
    cn.status === "fulfilled" &&
    global.status === "rejected" &&
    isNotFound(global.reason)
  ) {
    return { region: "cn", discovery: cn.value };
  }
  if (
    global.status === "fulfilled" &&
    cn.status === "rejected" &&
    isNotFound(cn.reason)
  ) {
    return { region: "global", discovery: global.value };
  }
  if (
    cn.status === "rejected" &&
    global.status === "rejected" &&
    isNotFound(cn.reason) &&
    isNotFound(global.reason)
  ) {
    throw new AuthApiError(
      "ORG_SSO_NOT_FOUND",
      404,
      "Enterprise SSO configuration was not found in either auth region",
    );
  }
  throw new AuthApiError(
    "ORG_REALM_UNAVAILABLE",
    503,
    "Unable to verify the enterprise auth region",
  );
}
