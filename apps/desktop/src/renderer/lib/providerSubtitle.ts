import type { AgentKind, ProviderView } from '@cindy/model-providers';

const AGENT_DISPLAY_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  'grok-build': 'Grok Build',
};

type ProviderSubtitleView = Pick<ProviderView, 'agents'> & Partial<Pick<ProviderView, 'id'>>;

export function providerAgentSupportLabel(
  provider?: ProviderSubtitleView | null,
): string {
  if (!provider?.agents.length) return '';
  const agents = [...provider.agents];
  // Grok Build is a Cindy harness on SuperGrok, not a catalog runtime. Settings
  // still needs to list it next to Claude Code / Codex / Pi.
  if (provider.id === 'xai' && !agents.includes('grok-build')) {
    agents.push('grok-build');
  }
  return agents.map((agent) => AGENT_DISPLAY_LABELS[agent] ?? agent).join(' / ');
}

export function providerSubtitleForDisplay(
  provider: ProviderSubtitleView | null | undefined,
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
