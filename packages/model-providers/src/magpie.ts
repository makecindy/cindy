/**
 * Magpie is a local gateway that exposes one model list for several native wire
 * APIs. Its `/v1/models` entries declare `native_endpoints` with the paths the
 * model is relayed on as-is (see Magpie `internal/provider/native_endpoints.go`):
 *
 *   /v1/chat/completions → OpenAI Chat
 *   /v1/responses        → OpenAI Responses
 *   /v1/messages         → Anthropic Messages
 *
 * An absent or empty list means Magpie translates the request itself, so the
 * runtime's own default protocol is safe. A non-empty list is the only evidence
 * we have about which path is valid for that model; respecting it prevents
 * sending a Chat-only model to `/v1/responses` (Magpie rejects those requests).
 */

import type {
  AgentKind,
  ProviderModelRouteConfig,
  ProviderWireProtocol,
} from './types.js';

export const MAGPIE_PRESET_ID = 'magpie';
export const MAGPIE_LOOPBACK_ORIGIN = 'http://127.0.0.1:3425';
export const MAGPIE_MODELS_URL = `${MAGPIE_LOOPBACK_ORIGIN}/v1/models`;

export const MAGPIE_NATIVE_ENDPOINTS = {
  messages: '/v1/messages',
  responses: '/v1/responses',
  chat: '/v1/chat/completions',
} as const;

export type MagpieNativeEndpoint =
  (typeof MAGPIE_NATIVE_ENDPOINTS)[keyof typeof MAGPIE_NATIVE_ENDPOINTS];

const ENDPOINT_BY_PATH: Record<string, ProviderWireProtocol> = {
  [MAGPIE_NATIVE_ENDPOINTS.messages]: 'anthropic-messages',
  [MAGPIE_NATIVE_ENDPOINTS.responses]: 'openai-responses',
  [MAGPIE_NATIVE_ENDPOINTS.chat]: 'openai-chat',
};

/**
 * Agent preference, not a capability claim. Cindy can bridge the other two
 * protocols, so every model stays usable from every harness; this order only
 * decides which native path we use when the model offers more than one.
 */
const AGENT_PROTOCOL_PREFERENCE: Record<AgentKind, readonly ProviderWireProtocol[]> = {
  'claude-code': ['anthropic-messages', 'openai-responses', 'openai-chat'],
  codex: ['openai-responses', 'anthropic-messages', 'openai-chat'],
  pi: ['openai-chat', 'openai-responses', 'anthropic-messages'],
};

export function isMagpiePresetId(value: unknown): value is typeof MAGPIE_PRESET_ID {
  return value === MAGPIE_PRESET_ID;
}

/** Any runtime carrying the preset marker identifies this custom connection. */
export function isMagpieCustomProviderConfig(config: {
  id?: string;
  runtimes: Partial<Record<AgentKind, { catalogPresetId?: string } | undefined>>;
}): boolean {
  if (config.id === MAGPIE_PRESET_ID || config.id?.startsWith(`${MAGPIE_PRESET_ID}-`)) {
    return true;
  }
  return Object.values(config.runtimes).some(
    (runtime) => runtime?.catalogPresetId === MAGPIE_PRESET_ID,
  );
}

/**
 * Parse only the chat paths we understand. Unknown entries (e.g. image
 * endpoints) are dropped; a list with no usable chat path is treated as
 * "untranslated", matching Magpie's nil semantics.
 */
export function parseMagpieNativeEndpoints(value: unknown): MagpieNativeEndpoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const endpoints = value.filter(
    (item): item is MagpieNativeEndpoint =>
      typeof item === 'string' && Object.hasOwn(ENDPOINT_BY_PATH, item),
  );
  return endpoints.length > 0 ? [...new Set(endpoints)] : undefined;
}

/**
 * Strip a trailing `/v1` so Messages can be addressed from the gateway root
 * while Responses/Chat stay under `/v1`. A non-`/v1` path prefix is preserved
 * for reverse-proxied gateways.
 */
export function magpieOriginPrefix(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') || '/';
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }
}

function baseUrlForWire(wireProtocol: ProviderWireProtocol, baseUrl: string): string {
  const prefix = magpieOriginPrefix(baseUrl);
  return wireProtocol === 'anthropic-messages' ? prefix : `${prefix}/v1`;
}

function defaultRuntimeWire(agent: AgentKind): ProviderWireProtocol {
  return agent === 'claude-code'
    ? 'anthropic-messages'
    : agent === 'codex'
      ? 'openai-responses'
      : 'openai-chat';
}

/**
 * Route only when the model's native path differs from this runtime's default.
 * `undefined` means "use the runtime as configured"; for a translated model
 * that keeps Magpie's own negotiation, and for a native model it is the path
 * the model already declares.
 */
export function magpieRouteForAgent(
  agent: AgentKind,
  nativeEndpoints: readonly string[] | undefined,
  baseUrl: string,
  runtimeWireProtocol?: ProviderWireProtocol,
): ProviderModelRouteConfig | undefined {
  const wires = nativeEndpoints
    ?.map((endpoint) => ENDPOINT_BY_PATH[endpoint])
    .filter((wire): wire is ProviderWireProtocol => wire !== undefined);
  if (!wires?.length) return undefined;
  const chosen = AGENT_PROTOCOL_PREFERENCE[agent].find((wire) => wires.includes(wire));
  if (!chosen || chosen === (runtimeWireProtocol ?? defaultRuntimeWire(agent))) return undefined;
  return { baseUrl: baseUrlForWire(chosen, baseUrl), wireProtocol: chosen };
}

/** Apply the native-endpoint route to a discovered model without copying metadata. */
export function magpieModelForAgent<T extends {
  nativeEndpoints?: readonly string[];
}>(
  model: T,
  agent: AgentKind,
  baseUrl: string,
  runtimeWireProtocol?: ProviderWireProtocol,
): T & { route?: ProviderModelRouteConfig } {
  const route = magpieRouteForAgent(agent, model.nativeEndpoints, baseUrl, runtimeWireProtocol);
  return route ? { ...model, route } : { ...model };
}
