import { compatibilityProtocol } from '@cindy/model-compat/protocol';
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
  provider: Pick<Provider, 'id' | 'routing'> & Partial<Pick<Provider, 'source'>>,
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
    const outbound = model.api ?? (
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
          ));
    const harness: PiModelApi | null =
      agent === 'pi' ? outbound : agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
    const outboundProtocol = compatibilityProtocol(outbound) ?? outbound;
    const harnessProtocol = compatibilityProtocol(harness) ?? harness;
    const referenceProtocol = compatibilityProtocol(reference) ?? reference;
    const localConversion = Boolean(agent !== 'pi' && outboundProtocol && harnessProtocol && outboundProtocol !== harnessProtocol);
    // Pi speaks the selected upstream API directly. Fixed-protocol harnesses
    // also need compatibility when the supplier converts the model's native API.
    // The location of that conversion never changes the default-on decision.
    const compatibility =
      localConversion || Boolean(agent !== 'pi' && referenceProtocol && outboundProtocol && referenceProtocol !== outboundProtocol);
    return {
      harness,
      outbound,
      localConversion,
      mode: compatibility
        ? ('compatibility' as const)
        : outbound && (reference || agent === 'pi')
          ? ('matching' as const)
          : ('unknown' as const),
    };
  };
  return { reference, forAgent };
}

/** Default-on engines use a configured protocol without harness or provider compatibility. */
export function nativeModelAgents(
  provider: Pick<Provider, 'id' | 'routing'> & Partial<Pick<Provider, 'source'>>,
  models: Partial<Record<AgentKind, CatalogModel>>,
): AgentKind[] {
  const comparison = modelProtocolComparison(provider, models);
  return (Object.keys(models) as AgentKind[]).filter(agent => {
    const protocol = comparison.forAgent(agent);
    return !!protocol?.outbound && protocol.mode === 'matching';
  });
}
