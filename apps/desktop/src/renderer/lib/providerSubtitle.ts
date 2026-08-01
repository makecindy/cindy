import type { AgentKind, ProviderView } from '@cindy/model-providers';

const AGENT_DISPLAY_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

export function providerAgentSupportLabel(provider?: Pick<ProviderView, 'agents'> | null): string {
  if (!provider?.agents.length) return '';
  return provider.agents.map((agent) => AGENT_DISPLAY_LABELS[agent] ?? agent).join(' / ');
}

export function providerSubtitleForDisplay(
  provider: Pick<ProviderView, 'agents'> | null | undefined,
  modelLabel: string,
  options?: {
    suffix?: string | null;
    fallback?: string;
  },
): string {
  const support = providerAgentSupportLabel(provider);
  if (!support) return options?.fallback ?? modelLabel;
  return [modelLabel, support, options?.suffix].filter((part): part is string => Boolean(part)).join(' · ');
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

/** 自定义供应商副标题:单 runtime 展示 host + runtime,多 runtime 直接展示实际支持的 agent。 */
export function customProviderSubtitleForDisplay(
  provider: Pick<ProviderView, 'agents' | 'routing'>,
): string {
  const support = providerAgentSupportLabel(provider);
  if (provider.agents.length !== 1) return support;
  const host = hostOf(provider.routing[provider.agents[0]]?.upstream);
  return host ? `${host} · ${support}` : support;
}
