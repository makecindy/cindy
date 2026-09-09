import type {
  AgentCredentialMode,
  ClaudeSubagentModelAccessResult,
} from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';

const CLAUDE_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

function normalizeModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.endsWith('[1m]')
    ? normalized.slice(0, -'[1m]'.length)
    : normalized;
}

function modelMatches(requested: string, candidate: string): boolean {
  const normalizedCandidate = normalizeModel(candidate);
  if (requested === normalizedCandidate) return true;
  return CLAUDE_ALIASES.some(
    (alias) => requested === alias && normalizedCandidate.includes(`claude-${alias}-`),
  );
}

interface XdAccessModel {
  id: string;
  agents?: readonly string[];
  availability?: 'available' | 'requires_payment';
}

interface XdAccessSnapshot {
  authoritative: boolean;
  models: readonly XdAccessModel[];
  paymentRequiredModelIds: readonly string[];
}

function xdClaudeCodeModels(models: readonly XdAccessModel[]): readonly string[] {
  return models
    .filter(
      (model) =>
        model.availability !== 'requires_payment'
        && model.agents?.includes('claude-code'),
    )
    .map((model) => model.id);
}

export function classifyClaudeSubagentModelAccess(input: {
  providerId?: string | null;
  credentialMode?: AgentCredentialMode;
  model: string;
  gatewayKeyAvailable: boolean;
  xdSnapshot: XdAccessSnapshot;
  providers: readonly Pick<ProviderView, 'id' | 'connected' | 'suspended' | 'models'>[];
}): ClaudeSubagentModelAccessResult {
  const requested = normalizeModel(input.model);
  if (!requested) return { status: 'unknown' };

  const providerId = input.providerId?.trim() || null;
  const usesXdGateway = providerId === 'xd'
    || (!providerId && input.credentialMode === 'gateway-key')
    // OAuth spawn 有 XD key 时，本地 compat proxy 的默认路由同样换成网关 key。
    || (!providerId && input.gatewayKeyAvailable);

  if (usesXdGateway) {
    // A retained payment tombstone is stronger than snapshot freshness. In
    // particular, aliases may drift to any matching paid generation, so one
    // known paid candidate must deny the alias before an older free match can
    // allow it.
    if (input.xdSnapshot.paymentRequiredModelIds.some(
      (id) => modelMatches(requested, id),
    )) return { status: 'denied' };
    if (!input.xdSnapshot.authoritative) return { status: 'unknown' };
    return xdClaudeCodeModels(input.xdSnapshot.models).some((id) => modelMatches(requested, id))
      ? { status: 'allowed' }
      : { status: 'denied' };
  }

  // 非 XD 来源没有统一的权威“负清单”：当前连接来源的正命中可以放行，
  // 缺席只能说明目录未发现/过期，绝不能据此硬阻断。
  const candidates = providerId
    ? input.providers.filter((provider) => provider.id === providerId)
    : input.providers;
  const positivelyAvailable = candidates.some((provider) =>
    provider.connected
    && !provider.suspended
    && (provider.models['claude-code'] ?? []).some(
      (model) => !model.disabled && modelMatches(requested, model.id),
    ),
  );
  return positivelyAvailable ? { status: 'allowed' } : { status: 'unknown' };
}
