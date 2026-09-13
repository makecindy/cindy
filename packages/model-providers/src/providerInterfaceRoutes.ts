import interfaceModels from '../catalog/provider-interface-models.json';
import raw from '../catalog/providers.json';
import type { AgentKind, ProviderPreset, ProviderRuntimeModelConfig } from './types.js';

// These contracts describe supplier front doors, not a model manufacturer's API.
// Sources and limits: docs/dev-rules/provider-interface-audit.md. Never infer an
// endpoint from a model name, a sibling hostname, or a Pi serializer alone.
const maintained = new Set([
  'openrouter', 'vercel-ai-gateway', 'deepseek', 'zhipu-glm-cn', 'zhipu-glm-global',
  'moonshot-kimi-cn', 'moonshot-kimi-global', 'moonshot-kimi-code', 'minimax-cn', 'minimax-global',
  'aliyun-bailian-coding', 'aliyun-bailian-token-plan-cn', 'aliyun-bailian-token-plan-team-cn',
  'zhipu-coding-plan-cn', 'zai-coding-plan-global', 'xiaomi-mimo-api-cn', 'xiaomi-mimo-token-plan-cn',
  'volcengine-agent-plan', 'volcengine-coding-plan', 'tencentcloud-coding-plan',
]);
const presets = raw.presets as ProviderPreset[];
type Route = { baseUrl: string; api: 'anthropic-messages' | 'openai-responses' | 'openai-completions'; inputs: string[] };
const overrides: Record<string, Partial<Record<AgentKind, Route>>> = {
  baseten: { 'claude-code': { baseUrl: 'https://inference.baseten.co', api: 'anthropic-messages', inputs: ['https://inference.baseten.co/v1'] } },
  groq: { codex: { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-responses', inputs: ['https://api.groq.com/openai/v1'] } },
  huggingface: { codex: { baseUrl: 'https://router.huggingface.co/v1', api: 'openai-responses', inputs: ['https://router.huggingface.co/v1'] } },
  fireworks: {
    'claude-code': { baseUrl: 'https://api.fireworks.ai/inference', api: 'anthropic-messages', inputs: ['https://api.fireworks.ai/inference', 'https://api.fireworks.ai/inference/v1'] },
    codex: { baseUrl: 'https://api.fireworks.ai/inference/v1', api: 'openai-responses', inputs: ['https://api.fireworks.ai/inference', 'https://api.fireworks.ai/inference/v1'] },
  },
  lmstudio: { codex: { baseUrl: 'http://127.0.0.1:1234/v1', api: 'openai-responses', inputs: ['http://127.0.0.1:1234/v1'] } },
  litellm: { 'claude-code': { baseUrl: 'http://127.0.0.1:4000', api: 'anthropic-messages', inputs: ['http://127.0.0.1:4000/v1'] } },
  longcat: { codex: { baseUrl: 'https://api.longcat.chat/openai/v1', api: 'openai-completions', inputs: ['https://api.longcat.chat/openai/v1'] } },
};
const clean = (value: string) => value.replace(/\/+$/, '');

/** The selected HTTP API and its route must agree. In particular, a model's
 * explicit Responses API cannot inherit a connection's Chat default. SDK-only
 * adapters retain their own transport, and custom request paths stay explicit. */
export function alignModelApiRoute<T extends ProviderRuntimeModelConfig>(model: T, baseUrl: string, runtimeWire?: string): T {
  const api = model.api ?? model.piApi;
  const wireProtocol = api === 'openai-completions' ? 'openai-chat'
    : api === 'anthropic-messages' || api === 'openai-responses' ? api : undefined;
  if (!wireProtocol || model.route?.requestPath || (model.route?.wireProtocol ?? runtimeWire) === wireProtocol) return model;
  return { ...model, route: { ...model.route, baseUrl: model.route?.baseUrl ?? baseUrl, wireProtocol } };
}
function contract(presetId: string, agent: AgentKind): Route | undefined {
  const override = overrides[presetId]?.[agent];
  if (override) return override;
  const rt = maintained.has(presetId) ? presets.find(p => p.id === presetId)?.runtimes[agent] : undefined;
  if (!rt) return undefined;
  const api = rt.wireProtocol === 'openai-chat' ? 'openai-completions' : rt.wireProtocol
    ?? (agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-completions');
  if (api !== 'anthropic-messages' && api !== 'openai-responses' && api !== 'openai-completions') return undefined;
  return { baseUrl: rt.baseUrl, api, inputs: Object.values(presets.find(p => p.id === presetId)!.runtimes).flatMap(value => value ? [value.baseUrl] : []) };
}

export function declaredModelInterface(presetId: string, modelId: string) {
  const declaration = (interfaceModels as Record<string, { models: Record<string, { api: string; endpoint: string }> }>)[presetId]?.models[modelId];
  if (!declaration) return undefined;
  const baseUrl = declaration.endpoint.replace(/(?:\/v1\/messages|\/chat\/completions|\/responses|\/models\/[^/]+)$/, '');
  return { api: declaration.api as NonNullable<ProviderRuntimeModelConfig['api']>, baseUrl };
}

/** Correct generated catalog routes and their stored imports. Explicit custom
 * paths and unrelated hosts/products (including subscription endpoints) stay put. */
export function providerInterfaceModelRoute<T extends ProviderRuntimeModelConfig>(
  model: T, agent: AgentKind, presetId: string | undefined, baseUrl: string, managed = false,
): T {
  if (!presetId || model.route?.requestPath) return model;
  const specific = declaredModelInterface(presetId, model.id);
  if (specific) {
    const product = presetId === 'opencode-go' ? 'https://opencode.ai/zen/go' : 'https://opencode.ai/zen';
    const allowed = [product, `${product}/v1`];
    if (!allowed.includes(clean(baseUrl)) || (model.route && !allowed.includes(clean(model.route.baseUrl)))) return model;
    if (!managed && ((model.api && model.api !== 'openai-completions') || (model.piApi && model.piApi !== 'openai-completions') || (model.route && model.route.wireProtocol !== 'openai-chat'))) return model;
    return { ...model, api: specific.api, ...(agent === 'pi' ? { piApi: specific.api } : {}), route: {
      baseUrl: specific.baseUrl, wireProtocol: specific.api === 'anthropic-messages' || specific.api === 'openai-responses' ? specific.api : 'openai-chat',
    } };
  }
  if (agent === 'pi') return model;
  if (managed && maintained.has(presetId) && !model.api && !model.piApi && !model.route) return model;
  const route = contract(presetId, agent);
  if (!route || ![...route.inputs, route.baseUrl].some(input => clean(input) === clean(baseUrl))) return model;
  // Stored legacy Pi projections used Chat. Do not overwrite explicit non-Chat choices.
  if (!managed && model.api && model.api !== 'openai-completions') return model;
  if (model.route) {
    if (!managed && model.route.wireProtocol !== 'openai-chat') return model;
    const declaredBases = new Set([...route.inputs, route.baseUrl,
      ...Object.values(presets.find(p => p.id === presetId)?.runtimes ?? {}).flatMap(rt => rt ? [rt.baseUrl] : []),
    ].map(clean));
    if (!declaredBases.has(clean(model.route.baseUrl))) return model;
  }
  return { ...model, api: route.api, route: { baseUrl: route.baseUrl,
    wireProtocol: route.api === 'openai-completions' ? 'openai-chat' : route.api,
  } };
}

export function hasDeclaredProviderInterface(model: ProviderRuntimeModelConfig, agent: AgentKind, presetId: string | undefined, baseUrl: string): boolean {
  const route = presetId ? contract(presetId, agent) : undefined;
  return !!route && agent !== 'pi' && model.api === route.api && !model.route?.requestPath
    && [...route.inputs, route.baseUrl].some(input => clean(input) === clean(baseUrl))
    && clean(model.route?.baseUrl ?? baseUrl) === clean(route.baseUrl);
}
