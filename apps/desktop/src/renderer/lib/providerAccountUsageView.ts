/**
 * API Key 供应商账户接口的 renderer 侧视图判定（与 main 侧认领规则同口径，见
 * maker-host/provider-account-usage.ts 的 INTEGRATIONS）。
 *
 * 依据官方接入端点而不是 provider 名字：内置预设与从模板创建的自定义连接都按
 * baseUrl 识别；走代理 / 自定义域名的连接不算（key 属于代理，main 侧也不会认领）。
 */

import type { AgentKind, ProviderView } from '@cindy/model-providers';
import { getProviderAccountUsageDashboardUrl, PROVIDER_ACCOUNT_USAGE_AGENTS } from '../../shared/providerAccountUsage';

/** 查询完成前的看板入口；完成后优先消费 main 回带的实际查询端点。 */
export function getProviderAccountUsageDashboardUrlView(
  provider: ProviderView | undefined,
  agent?: AgentKind,
): string | undefined {
  for (const runtime of agent ? [agent] : PROVIDER_ACCOUNT_USAGE_AGENTS) {
    const url = getProviderAccountUsageDashboardUrl(provider?.routing[runtime]?.upstream ?? '');
    if (url) return url;
  }
  return undefined;
}

const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
const ZHIPU_ANTHROPIC_BASES = [
  'https://open.bigmodel.cn/api/anthropic',
  'https://open.bigmodel.cn/api/anthropic/',
  'https://api.z.ai/api/anthropic',
  'https://api.z.ai/api/anthropic/',
];
const ZHIPU_CODING_PREFIXES = [
  'https://open.bigmodel.cn/api/coding/',
  'https://api.z.ai/api/coding/',
];

function routingUpstreams(provider: ProviderView | undefined | null): string[] {
  return Object.values(provider?.routing ?? {}).map(
    (route) => (route as { upstream?: string } | undefined)?.upstream ?? '',
  );
}

/** 任一 runtime 是否指向官方 DeepSeek 端点。 */
export function hasDeepSeekOfficialRouteView(provider: ProviderView | undefined | null): boolean {
  return routingUpstreams(provider).some((upstream) => {
    if (!upstream) return false;
    try {
      const url = new URL(upstream);
      return url.protocol === 'https:' && url.origin === DEEPSEEK_ORIGIN;
    } catch {
      return false;
    }
  });
}

/** 是否智谱 GLM Coding Plan 接入（CN 与 Global，/api/anthropic 或 /api/coding/*）；按量付费不算。 */
export function isZhipuCodingPlanProviderView(provider: ProviderView | undefined | null): boolean {
  if (!provider) return false;
  if (provider.id === 'zhipu-coding-plan-cn' || provider.id === 'zai-coding-plan-global') {
    return true;
  }
  return routingUpstreams(provider).some(
    (upstream) =>
      ZHIPU_ANTHROPIC_BASES.includes(upstream)
      || ZHIPU_CODING_PREFIXES.some((prefix) => upstream.startsWith(prefix)),
  );
}
