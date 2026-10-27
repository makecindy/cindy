/**
 * providerAccountUsage —— API Key 计费供应商的账户余额 / 用量快照（renderer ↔ main 共享形状）。
 *
 * 与订阅制（Claude / Codex / xAI）的 `providerQuotaSource` 互补：那边读的是 OAuth 订阅的
 * 周期配额（5h / 7d 窗口），这边读的是 API Key 供应商自己的账户接口（如 DeepSeek
 * `/user/balance`）。两者互不借用：订阅卡与余额卡各自成立，缺一不显示另一张。
 *
 * 结果是查询型结构化返回（规则 13 例外条款）：网络 / 上游 / 鉴权失败不 throw，落进
 * `error`，renderer 按 code 渲染分类文案与重试入口。快照本身不含任何密钥材料。
 */

import type { AgentKind } from '@cindy/model-providers';

export interface ProviderAccountUsageRequest {
  providerId: string;
  /** 手动刷新（设置页刷新按钮）。绕过 TTL 缓存但仍受最小间隔节流。 */
  forceRefresh?: boolean;
  /**
   * 会话所在引擎（输入框 chip 传入）：同一供应商各引擎可用独立密钥（不同账户），
   * 传入后只读该引擎路由的 key，余额/配额才能对准当前会话用的账户。缺省
   * （设置页供应商级视图）按 claude-code → codex → pi 取第一个指向官方端点的密钥。
   */
  agent?: AgentKind;
}

export interface DeepSeekBalanceLine {
  /** ISO 4217 货币码（如 CNY / USD）。 */
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekAccountUsageSnapshot {
  kind: 'deepseek-balance';
  isAvailable: boolean;
  balances: DeepSeekBalanceLine[];
  /** epoch ms。 */
  fetchedAt: number;
}

export type ProviderAccountUsageSnapshot =
  | DeepSeekAccountUsageSnapshot
  | ZhipuCodingPlanQuotaSnapshot;

/** 智谱 GLM Coding Plan 一个计费窗口的已用比例与重置时间。 */
export interface ZhipuCodingPlanWindow {
  /** 已用百分比（0-100，上游原值）。 */
  usedPercent: number;
  /** epoch ms；null = 上游未提供（如 0% 状态下可能缺席）。 */
  resetsAt: number | null;
}

/**
 * 智谱 GLM Coding Plan 额度快照（GET /api/monitor/usage/quota/limit，鉴权用裸 key）。
 * 窗口语义按上游 unit 字段：3 = 5 小时积分、6 = 每周积分；老套餐只回 5 小时一条。
 * 按量付费账户无套餐：HTTP 200 + 业务错误（msg 提 coding plan 不存在）→ noPlan=true。
 */
export interface ZhipuCodingPlanQuotaSnapshot {
  kind: 'zhipu-coding-plan-quota';
  noPlan: boolean;
  /** 套餐档位（如 lite / pro / max）；noPlan 或未回时为 null。 */
  level: string | null;
  fiveHour: ZhipuCodingPlanWindow | null;
  weekly: ZhipuCodingPlanWindow | null;
  fetchedAt: number;
}

export type ProviderAccountUsageError =
  | 'no-credentials'
  | 'updating'
  | 'auth'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'invalid-response'
  | 'throttled'
  | 'unknown';

export type ProviderAccountUsageResult = (
  /** 该供应商没有可读的账户余额 / 用量接口（renderer 不渲染模块）。 */
  | { status: 'unsupported' }
  | { status: 'unavailable'; error: ProviderAccountUsageError; retryAt?: number }
  | {
      status: 'ready';
      snapshot: ProviderAccountUsageSnapshot;
      stale: boolean;
      error?: ProviderAccountUsageError;
      retryAt?: number;
      /** 本次查询实际使用的 runtime；设置页用它标注余额来自哪个引擎的密钥。 */
      agent?: AgentKind;
    }
) & {
  /** 本次实际查询端点对应的官方看板；同样随鉴权等失败结果返回。 */
  dashboardUrl?: string;
};

/**
 * 智谱 GLM Coding Plan 的官方用量页。无套餐（noPlan）/ 想看积分细则时的一键入口；
 * 额度数值由 /api/monitor/usage/quota/limit 拉取（2026-10 实测可用）。
 */
export const ZHIPU_CODING_PLAN_USAGE_URL = 'https://www.bigmodel.cn/coding-plan/personal/usage';

/** 按官方端点选择看板，不从界面语言或 Cindy 区域推断账号所属网站。 */
export function getProviderAccountUsageDashboardUrl(upstream: string): string | undefined {
  try {
    switch (new URL(upstream).origin) {
      case 'https://api.deepseek.com':
        return 'https://platform.deepseek.com/usage';
      case 'https://open.bigmodel.cn':
        return ZHIPU_CODING_PLAN_USAGE_URL;
      case 'https://api.z.ai':
        return 'https://z.ai/manage-apikey/coding-plan/personal/my-plan';
    }
  } catch {
    // 未配置或非法地址没有对应的官方看板。
  }
  return undefined;
}

/** 余额查询优先用的 runtime 顺序（与用户实际配置密度对齐，命中即止）。 */
export const PROVIDER_ACCOUNT_USAGE_AGENTS: readonly AgentKind[] = [
  'claude-code',
  'codex',
  'pi',
];
