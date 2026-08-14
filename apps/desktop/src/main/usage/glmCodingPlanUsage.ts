/**
 * glmCodingPlanUsage(main)— 拉取 GLM Coding Plan 订阅余量的 HTTP 层。
 *
 * 端点:GET {origin}/api/monitor/usage/quota/limit(智谱官方 Claude Code 插件
 * glm-plan-usage 的 query-usage.mjs 同源,未列入正式 API 文档)。要求:
 *   - `Authorization: <API key 原文>`(无 Bearer 前缀,官方插件实测口径)
 *   - origin 按 provider 的 runtime baseUrl 白名单推导:open.bigmodel.cn(zhipu)/
 *     api.z.ai(zai)/dev.bigmodel.cn(zhipu 开发端点,官方插件同款白名单成员)
 *
 * 白名单是精确 host 匹配(不是 includes):普通 GLM API 与 Coding Plan 共用
 * /api/anthropic 端点,调用方必须先经 CustomProviderConfig.usage 确认订阅身份,
 * 再把 key 发给这里 —— 本模块不再做身份判断,只做 URL 收口。
 *
 * 错误语义(供 glmCodingPlanUsageRefresh 的 reader 消费,与 claudeSubscriptionUsage 对齐):
 *   - 401 / 403 → GlmCodingPlanUsageUnauthorizedError(清缓存快照;**不动 API key**——
 *     也可能是套餐类型或内部接口权限不支持,不是 key 错的证据)
 *   - 429       → GlmCodingPlanUsageRateLimitedError(退避,保留缓存快照)
 *   - 其它失败  → null(保留缓存,下轮再试)
 */

import { createLogger } from '../logger.js';
import {
  parseGlmCodingPlanQuotaLimitResponse,
  type GlmCodingPlanUsageSnapshot,
} from '../../shared/glmCodingPlanUsage.js';

const log = createLogger('usage:glm-coding-plan');

const QUOTA_LIMIT_PATH = '/api/monitor/usage/quota/limit';
const GLM_USAGE_TIMEOUT_MS = 5000;

/** 用量端点 origin 白名单 —— 精确 host 匹配(拒绝相似后缀域名 / 任意自定义 host)。 */
const GLM_USAGE_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'open.bigmodel.cn',
  'api.z.ai',
  'dev.bigmodel.cn',
]);

export class GlmCodingPlanUsageUnauthorizedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GLM coding plan usage unauthorized (${status})`);
    this.name = 'GlmCodingPlanUsageUnauthorizedError';
    this.status = status;
  }
}

export class GlmCodingPlanUsageRateLimitedError extends Error {
  constructor() {
    super('GLM coding plan usage rate limited (429)');
    this.name = 'GlmCodingPlanUsageRateLimitedError';
  }
}

/**
 * 端点成功(2xx)但解析不出任何已知窗口 —— 团队版 / 接口形状再变等。
 * 与网络失败(null)语义不同:调用方应**清除**缓存快照让 chip 降级为无数据,
 * 而不是继续展示过期值。
 */
export const GLM_CODING_PLAN_USAGE_EMPTY = 'empty' as const;
export type GlmCodingPlanUsageFetchResult =
  | GlmCodingPlanUsageSnapshot
  | typeof GLM_CODING_PLAN_USAGE_EMPTY
  | null;

/** 白名单 host → 用量端点 URL;host 不在白名单 → null(调用方按"不可查询"降级)。 */
export function buildGlmUsageEndpointUrl(runtimeBaseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(runtimeBaseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!GLM_USAGE_ALLOWED_HOSTS.has(u.hostname)) return null;
  return `${u.protocol}//${u.host}${QUOTA_LIMIT_PATH}`;
}

export async function fetchGlmCodingPlanUsageSnapshot(opts: {
  runtimeBaseUrl: string;
  apiKey: string;
  platform: 'zhipu' | 'zai';
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: number;
}): Promise<GlmCodingPlanUsageFetchResult> {
  const endpoint = buildGlmUsageEndpointUrl(opts.runtimeBaseUrl);
  if (!endpoint) {
    // 配置层不该把非白名单 baseUrl 送进来(身份经 usage 能力标记确认过);
    // 到这里说明配置被手改成任意端点 —— 拒绝把订阅 key 发出去,只记脱敏日志。
    log.warn('glm coding plan usage endpoint rejected: runtime baseUrl not allowlisted');
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? GLM_USAGE_TIMEOUT_MS);
  try {
    const res = await (opts.fetchFn ?? fetch)(endpoint, {
      method: 'GET',
      headers: {
        // 官方插件口径:Authorization 直接传 API key 原文,不加 Bearer 前缀。
        Authorization: opts.apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 不打响应体 —— 错误体可能回显请求材料;状态码足够定位。
      log.warn('glm coding plan usage fetch failed', { status: res.status });
      if (res.status === 401 || res.status === 403) {
        throw new GlmCodingPlanUsageUnauthorizedError(res.status);
      }
      if (res.status === 429) {
        throw new GlmCodingPlanUsageRateLimitedError();
      }
      return null;
    }
    const data: unknown = await res.json();
    const snapshot = parseGlmCodingPlanQuotaLimitResponse(
      data,
      opts.now ?? Date.now(),
      opts.platform,
    );
    if (!snapshot) {
      log.warn('glm coding plan usage response had no parsable windows');
      return GLM_CODING_PLAN_USAGE_EMPTY;
    }
    return snapshot;
  } catch (err) {
    if (
      err instanceof GlmCodingPlanUsageUnauthorizedError
      || err instanceof GlmCodingPlanUsageRateLimitedError
    ) {
      throw err;
    }
    log.warn('glm coding plan usage fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
