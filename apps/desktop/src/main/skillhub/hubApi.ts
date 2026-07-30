/**
 * skillhub 业务的统一 server API 入口:所有 /api/skills-hub/* 调用固定打
 * 独立部署的 skillhub-server(clientEndpoints 'skillhubApiBaseUrl';老主
 * server 的 apiBaseUrl 已随 2026-07 收敛退役)。serverApiFetch 的 Bearer
 * 注入与 401 自动刷新链路不变。
 * getClientEndpoint 每次调用时惰性求值——端点清单在 app.ready 内解析,
 * 模块加载期不可读。
 */
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient';
import { getClientEndpoint } from '../clientEndpointsService';
import { requireAppCapability } from '../appCapabilities.js';

export function skillhubApiFetch<T>(
  apiPath: string,
  opts: Omit<ApiFetchOptions, 'baseUrl'> = {},
): Promise<T> {
  requireAppCapability('canUseSkillHubCloud', 'SkillHub cloud requires a Cindy account.');
  return serverApiFetch<T>(apiPath, {
    ...opts,
    baseUrl: () => getClientEndpoint('skillhubApiBaseUrl'),
  });
}
