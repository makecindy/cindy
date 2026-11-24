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
 * 同时探测国内与国际 auth-server，等待两侧结束后选择企业所在区域。
 *
 * 默认要求另一侧明确 ORG_SSO_NOT_FOUND，保持邮箱发现与登录后提示的严格策略。
 * 显式企业标识入口可启用 allowPartialSuccess：只有一侧通过客户端的响应、区域及
 * 非空连接校验时即可继续；双命中仍报冲突，两侧均无有效结果保留原错误。
 */
export async function discoverSsoOrgRealm(
  org: string,
  clients: SsoOrgRealmClients,
  options: { allowPartialSuccess?: boolean } = {},
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
    (options.allowPartialSuccess || isNotFound(global.reason))
  ) {
    return { region: "cn", discovery: cn.value };
  }
  if (
    global.status === "fulfilled" &&
    cn.status === "rejected" &&
    (options.allowPartialSuccess || isNotFound(cn.reason))
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
