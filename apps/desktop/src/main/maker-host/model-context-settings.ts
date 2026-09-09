import type { AgentKind, Catalog } from '@cindy/model-providers';

import { desktopCodexAuthAdapter, readClaudeApiKey } from './auth-adapters.js';
import { hasClaudeAiOAuth } from './claude-credentials-store.js';
import { gatewayDefaultRouteDecision } from './provider-route.js';
import { resolveModelContextProviderId, resolveVerifiedContextWindow } from './catalog-to-descriptors.js';
import { readModelContextLimit } from './model-context-limit-store.js';

/** Shared settings identity for startup, refresh and history protection of implicit routes. */
export function resolveDesktopModelContextProviderId(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): string | null {
  const source = resolveModelContextProviderId(catalog, agent, providerId, modelId);
  if (source || providerId) return source;
  // Claude's OAuth spawn may still route through XD; login alone is not its destination.
  // Codex's ordinary implicit models instead inherit subscription-first spawn credentials.
  const defaultSource = agent === 'claude-code'
    ? gatewayDefaultRouteDecision(agent, readClaudeApiKey()) ? 'xd'
      : hasClaudeAiOAuth() ? 'anthropic' : null
    : agent === 'codex'
      ? modelId.startsWith('codex/') ? 'xd'
        : desktopCodexAuthAdapter.hasCodexOAuthLoginReadOnly() ? 'openai' : 'xd'
      : null;
  return resolveModelContextProviderId(catalog, agent, providerId, modelId, defaultSource);
}

/** Working budgets can tighten history protection, but never raise its verified ceiling. */
export function resolveConfiguredContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): number | null {
  const source = resolveDesktopModelContextProviderId(catalog, agent, providerId, modelId);
  return resolveVerifiedContextWindow(catalog, agent, source, modelId,
    source ? readModelContextLimit(agent, source, modelId) : null);
}
