import { isCodexGatewayWireModel, type AgentKind, type Catalog } from '@cindy/model-providers';
import { gatewayDefaultRouteDecision } from './provider-route.js';
import { resolveModelContextProviderId } from './catalog-to-descriptors.js';

export function createModelContextProviderResolver(ports: { readGatewayKey(): string | null; hasClaudeNativeLogin(): boolean; hasCodexOAuthLogin(): boolean }) {
return function resolveDesktopModelContextProviderId(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): string | null {
  const source = resolveModelContextProviderId(catalog, agent, providerId, modelId);
  if (source || providerId) return source;
  // Implicit Claude sessions use the gateway whenever a gateway key exists; only without one
  // do they fall back to the local Claude Code login (same order as the Claude auth adapter).
  // Codex's ordinary implicit models instead inherit subscription-first spawn credentials.
  const defaultSource = agent === 'claude-code'
    ? gatewayDefaultRouteDecision(agent, ports.readGatewayKey()) ? 'xd'
      : ports.hasClaudeNativeLogin() ? 'anthropic' : null
    : agent === 'codex'
      ? isCodexGatewayWireModel(modelId) ? 'xd'
        : ports.hasCodexOAuthLogin() ? 'openai' : 'xd'
      : null;
  return resolveModelContextProviderId(catalog, agent, providerId, modelId, defaultSource);
}

}
