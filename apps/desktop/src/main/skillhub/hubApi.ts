/**
 * skillhub 业务的统一 server API 入口:所有 /api/skills-hub/* 调用固定打
 * 独立部署的 cindy-skill-hub-server(clientEndpoints
 * 'cindySkillHubApiBaseUrl';旧 'skillhubApiBaseUrl' 永久保留给已发布客户端;老主
 * server 的 apiBaseUrl 已随 2026-07 收敛退役)。serverApiFetch 的 Bearer
 * 注入与 401 自动刷新链路不变。
 * getClientEndpoint 每次调用时惰性求值——端点清单在 app.ready 内解析,
 * 模块加载期不可读。
 */
import { ServerApiError, serverApiFetch, type ApiFetchOptions } from '../serverApiClient';
import { getClientEndpoint } from '../clientEndpointsService';

function requireSkillhubApiBaseUrl(): string {
  const baseUrl = getClientEndpoint('cindySkillHubApiBaseUrl');
  if (!baseUrl) {
    throw new ServerApiError(
      'UNSUPPORTED_CAPABILITY',
      0,
      'Cindy Skill Hub is not configured for this environment',
    );
  }
  return baseUrl;
}

export async function skillhubApiFetch<T>(
  apiPath: string,
  opts: Omit<ApiFetchOptions, 'baseUrl'> = {},
): Promise<T> {
  // 空端点是清单级关闭开关。先于 serverApiFetch 拒绝，避免 Electron net.fetch
  // 把 `/api/skills-hub/*` 当作相对地址；resolver 内再次校验，覆盖 401 刷新后
  // 登录区域切换导致目标区域未部署 Skill Hub 的情况。
  requireSkillhubApiBaseUrl();
  return serverApiFetch<T>(apiPath, {
    ...opts,
    // 新客户端绝不回退旧 skillhubApiBaseUrl：XD 身份的只读兼容由新服务自己
    // 路由，回退会让个人/其它组织误连只面向 XD 的旧服务。
    baseUrl: requireSkillhubApiBaseUrl,
    // skills-hub 的 path 都带用户/第三方 skill 身份(`/api/skills-hub/skills/<name>[/download]`),
    // 4xx/5xx 落进 serverApiClient 的 not_ok 日志会外泄它。用不含身份的路由模板代替真实 path,
    // 并借此在日志里连 msg 一起省掉(2026-08-06 review)。这里**不**设 redactErrorDetails:SkillHub
    // 依赖 ServerApiError.code(VERSION_RACE 等)做业务分支,logLabel 只改日志、不动抛出的错误。
    logLabel: opts.logLabel ?? '/api/skills-hub',
  });
}
