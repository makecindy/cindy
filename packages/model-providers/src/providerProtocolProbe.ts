import type { ProviderWireProtocol } from './types.js';

/** A candidate is a persistable Pi route, never a diagnostic-only request path. */
export interface ProviderProtocolCandidate {
  baseUrl: string;
  wireProtocol: ProviderWireProtocol;
}

/** Bounded standard routes: preserve deployment prefixes, never guess another host. */
export function providerProtocolCandidates(input: string, previous?: ProviderWireProtocol): ProviderProtocolCandidate[] {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('automatic protocol detection requires a plain HTTP API base URL');
  }
  let path = url.pathname.replace(/\/+$/, '');
  let preferred: ProviderWireProtocol | undefined = previous;
  let exactEndpoint = false;
  for (const [suffix, protocol] of [
    ['/chat/completions', 'openai-chat'], ['/responses', 'openai-responses'],
    ['/messages', 'anthropic-messages'],
  ] as const) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length); preferred = protocol; exactEndpoint = true;
      if (protocol === 'anthropic-messages' && !path.endsWith('/v1')) {
        throw new TypeError('this exact messages path cannot be represented by the native Pi SDK');
      }
      break;
    }
  }
  if (/\/v1beta$/.test(path)) preferred = 'google-generative-ai';
  const order: ProviderWireProtocol[] = ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
  if (preferred) order.splice(0, 0, ...order.splice(order.indexOf(preferred), 1));
  return order.map(wireProtocol => {
    let basePath = path;
    // These are SDK standard roots, not a scan of sibling deployment paths.
    if (!basePath && !exactEndpoint) basePath = wireProtocol === 'google-generative-ai' ? '/v1beta'
      : wireProtocol === 'anthropic-messages' ? '' : '/v1';
    // Anthropic's SDK itself appends /v1/messages.
    if (wireProtocol === 'anthropic-messages') basePath = basePath.replace(/\/v1$/, '');
    return { baseUrl: url.origin + basePath, wireProtocol };
  });
}
