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
    // skills-hub 的 path 都带用户/第三方 skill 身份(`/api/skills-hub/skills/<name>[/download]`),
    // 4xx/5xx 落进 serverApiClient 的 not_ok 日志会外泄它。用不含身份的路由模板代替真实 path,
    // 并借此在日志里连 msg 一起省掉(2026-08-06 review)。这里**不**设 redactErrorDetails:SkillHub
    // 依赖 ServerApiError.code(VERSION_RACE 等)做业务分支,logLabel 只改日志、不动抛出的错误。
    logLabel: opts.logLabel ?? '/api/skills-hub',
  });
}
