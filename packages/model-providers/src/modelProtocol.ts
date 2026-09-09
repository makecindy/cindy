import type {
  AgentKind,
  CatalogModel,
  PiModelApi,
  Provider,
  ProviderWireProtocol,
} from './types.js';

function apiFromWireProtocol(protocol: ProviderWireProtocol | undefined): PiModelApi | null {
  return protocol === 'openai-chat' ? 'openai-completions' : (protocol ?? null);
}

/** Protocol comparison for one provider's logical row. Never borrow another provider's model. */
export function modelProtocolComparison(
  provider: Pick<Provider, 'id' | 'routing'>,
  models: Partial<Record<AgentKind, CatalogModel>>,
) {
  // Canonical protocol is model metadata, never reverse-engineered from a harness configuration.
  const declared = Object.values(models)
    .filter((m) => m.nativeApi !== undefined)
    .map((m) => m.nativeApi);
  const reference: PiModelApi | null = declared.length
    ? new Set(declared).size === 1
      ? declared[0]!
      : null
    : provider.id === 'anthropic' && models['claude-code']
      ? 'anthropic-messages'
      : provider.id === 'openai' && models.codex
        ? 'openai-responses'
        : null;
  const forAgent = (agent: AgentKind) => {
    const model = models[agent];
    if (!model) return null;
    const routing = provider.routing?.[agent];
    const outbound =
      agent === 'pi'
        ? (model.piApi ?? apiFromWireProtocol(model.route?.wireProtocol ?? routing?.wireProtocol))
        : apiFromWireProtocol(
            model.route?.wireProtocol ??
              routing?.wireProtocol ??
              // A missing descriptor (e.g. a redacted remote view) is not evidence of a route.
              (routing?.authStrategy
                ? agent === 'codex'
                  ? 'openai-responses'
                  : 'anthropic-messages'
                : undefined),
          );
    const harness: PiModelApi | null =
      agent === 'pi' ? outbound : agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
    const localConversion = Boolean(outbound && harness && outbound !== harness);
    const compatibility =
      localConversion || Boolean(reference && outbound && reference !== outbound);
    return {
      harness,
      outbound,
      localConversion,
      mode: compatibility
        ? ('compatibility' as const)
        : reference && outbound
          ? ('matching' as const)
          : ('unknown' as const),
    };
  };
  return { reference, forAgent };
}
