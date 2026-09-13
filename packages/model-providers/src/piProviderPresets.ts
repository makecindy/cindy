import { alignModelApiRoute, providerInterfaceModelRoute } from './providerInterfaceRoutes.js';
import { compatibilityProtocol, selectCompatibilityRoute } from '@cindy/model-compat/protocol';
import { PI_PROVIDER_PRESET_IDS as existingConnections, sourceProviderForPreset } from './providerPresetIdentity.js';
import { PROVIDER_MODEL_CATALOG } from './providerModelCatalog.js';
import { PI_MODEL_APIS } from './types.js';
import type { ProviderPreset, ProviderWireProtocol, PiModelApi } from './types.js';

/** Connection labels only; model IDs, APIs and endpoints remain in the standard catalog. */
const labels: Record<string, string> = {
  'openai-api': 'OpenAI API', 'anthropic-api': 'Anthropic API', 'xai-api': 'xAI API',
  'amazon-bedrock': 'Amazon Bedrock', 'azure-openai-responses': 'Azure OpenAI',
  'google-vertex': 'Google Vertex AI', 'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI', 'github-copilot': 'GitHub Copilot',
  'ant-ling': '蚂蚁百灵', baseten: 'Baseten', cerebras: 'Cerebras', fireworks: 'Fireworks AI',
  groq: 'Groq', huggingface: 'Hugging Face', nvidia: 'NVIDIA NIM', together: 'Together AI',
  mistral: 'Mistral AI', opencode: 'OpenCode Zen', 'qwen-token-plan': 'Qwen Token Plan (Global)',
  'qwen-token-plan-cn': 'Qwen Token Plan（中国大陆）',
  'qwen-token-plan-individual': 'Qwen Token Plan（个人版）',
  'xiaomi-token-plan-ams': 'MiMo Token Plan (Amsterdam)',
  'xiaomi-token-plan-sgp': 'MiMo Token Plan (Singapore)',
};

const wire = (api: string): ProviderWireProtocol | undefined =>
  api === 'openai-completions' ? 'openai-chat' :
  api === 'openai-responses' || api === 'anthropic-messages' ? api : undefined;

/** New client bridge capability; existing endpoints and model membership stay authoritative. */
export function withClaudeProviderRuntime(preset: ProviderPreset): ProviderPreset {
  if (preset.runtimes['claude-code']) return preset;
  const portable = preset.runtimes.codex ?? preset.runtimes.pi;
  if (!portable) return preset;
  return { ...preset, runtimes: { ...preset.runtimes, 'claude-code': {
    ...portable, wireProtocol: portable.wireProtocol ?? 'openai-responses',
    models: portable.models.map(({ piApi, ...model }) => ({ ...model, ...(model.api ?? piApi ? { api: model.api ?? piApi } : {}) })),
  } } };
}

/** Add concrete portable connections; cloud identity/OAuth providers require their own setup. */
export function appendPiProviderPresets(presets: readonly ProviderPreset[]): ProviderPreset[] {
  const portablePresets = presets.map(withClaudeProviderRuntime);
  const out = portablePresets.map(preset => {
    const sourceId = sourceProviderForPreset(preset.id);
    const rows = PROVIDER_MODEL_CATALOG.providers[sourceId];
    if (!rows) return preset;
    return { ...preset, runtimes: Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => {
      if (!runtime) return [agent, runtime];
      const known = new Set(runtime.models.map(model => model.id));
      const additions = rows.filter(row => !known.has(row.id) && (() => {
        try { return new URL(row.upstream).origin === new URL(runtime.baseUrl).origin; } catch { return false; }
      })()).map(row => ({ id: row.id, name: row.name, defaultEnabled: false, api: row.execution.pi.api as PiModelApi,
        ...(agent === 'pi' ? { piApi: row.execution.pi.api as PiModelApi } : {}),
        route: { baseUrl: row.upstream, wireProtocol: wire(row.execution.pi.api) ?? 'openai-chat' },
      }));
      return [agent, { ...runtime, models: [...runtime.models.map(model => {
        // Maintained upstream API wins over old harness-specific preset transports.
        // Match exact IDs at this official origin; never borrow from a custom host.
        if (sourceId !== 'opencode' && sourceId !== 'opencode-go') return model;
        const candidates = rows.filter(row => row.id === model.id && (() => {
          try { return new URL(row.upstream).origin === new URL(runtime.baseUrl).origin; } catch { return false; }
        })());
        if (candidates.length !== 1) return model;
        const row = candidates[0];
        const api = row.execution.pi.api as PiModelApi;
        return { ...model, api, ...(agent === 'pi' ? { piApi: api } : {}),
          route: { baseUrl: row.upstream, wireProtocol: wire(api) ?? 'openai-chat' } };
      }), ...additions] }];
    })) };
  });
  const ids = new Set(out.map(p => p.id));
  const entries = Object.entries(PROVIDER_MODEL_CATALOG.providers).flatMap(([id, rows]) => {
    if (id !== 'amazon-bedrock') return [[id, rows] as const];
    const origins = [...new Set(rows.map(row => row.upstream))];
    return origins.map((origin, index) => [index === 0 ? id : `${id}-${new URL(origin).hostname.split('.')[1]}`,
      rows.filter(row => row.upstream === origin)] as const);
  });
  for (const [sourceId, sourceRows] of entries) {
    if (sourceId === 'openai-codex') continue; // Existing ChatGPT native login, never an API-key template.
    const id = existingConnections[sourceId] ?? sourceId;
    const rows = sourceRows.map(row => ({ ...row, upstream: row.upstream || 'https://{resource}.openai.azure.com/openai/v1' }));
    if (!rows.length || ids.has(id)) continue;
    if (!rows.every(r => /^https:\/\//.test(r.upstream) && PI_MODEL_APIS.some(api => api === r.execution.pi.api))) continue;
    const runtimes: ProviderPreset['runtimes'] = {};
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const supported = rows;
      if (!supported.length) continue;
      const first = supported[0];
      const protocol = wire(first.execution.pi.api) ?? 'openai-chat';
      runtimes[agent] = {
        baseUrl: first.upstream, wireProtocol: protocol,
        ...(first.upstream.includes('{') ? { baseUrlEditable: true } : {}),
        models: supported.map(r => ({ id: r.id, name: r.name, defaultEnabled: false,
          api: r.execution.pi.api as PiModelApi,
          ...(agent === 'pi' ? { piApi: r.execution.pi.api as PiModelApi } : {}),
          ...(r.upstream !== first.upstream || (wire(r.execution.pi.api) ?? 'openai-chat') !== protocol
            ? { route: { baseUrl: r.upstream, wireProtocol: wire(r.execution.pi.api) ?? 'openai-chat' } } : {}),
        })),
      };
    }
    out.push({ id, name: labels[id] ?? (id.startsWith('amazon-bedrock-') ? `Amazon Bedrock (${id.slice('amazon-bedrock-'.length)})` : id), regionHint: 'global', runtimes });
    ids.add(id);
  }
  if (!ids.has('nous')) out.push({ id: 'nous', name: 'Nous Research (Hermes)', regionHint: 'global',
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/integrations/nous-portal',
    runtimes: Object.fromEntries(['claude-code', 'codex', 'pi'].map(agent => [agent, {
      baseUrl: 'https://inference-api.nousresearch.com/v1', wireProtocol: 'openai-chat',
      modelsUrl: 'https://inference-api.nousresearch.com/v1/models', models: [],
    }])),
  });
  return out.map(preset => ({ ...preset, runtimes: Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => {
    if (!runtime) return [agent, runtime];
    return [agent, { ...runtime, models: runtime.models.map(originalModel => {
      const model = providerInterfaceModelRoute(originalModel, agent as 'claude-code' | 'codex' | 'pi', preset.id, runtime.baseUrl, true);
      if (runtime.requestPath || (model.route && 'requestPath' in model.route && model.route.requestPath)) return model;
      const routeOf = (rt: typeof runtime, m: typeof model) => {
        m = alignModelApiRoute(m, rt.baseUrl, rt.wireProtocol);
        const route = m.route ?? { baseUrl: rt.baseUrl, wireProtocol: rt.wireProtocol ?? (agent === 'claude-code' ? 'anthropic-messages' : agent === 'codex' ? 'openai-responses' : 'openai-chat'), ...(rt.requestPath ? { requestPath: rt.requestPath } : {}) };
        const api = m.api ?? m.piApi ?? (route.wireProtocol === 'openai-chat' ? 'openai-completions' : route.wireProtocol);
        return { route, api, model: m, protocol: compatibilityProtocol(api) };
      };
      const current = routeOf(runtime, model);
      const candidates = [current];
      for (const [otherAgent, other] of Object.entries(preset.runtimes)) {
        if (!other || otherAgent === agent || JSON.stringify(other.headers ?? {}) !== JSON.stringify(runtime.headers ?? {})) continue;
        const sibling = other.models.find(m => m.id === model.id);
        if (!sibling) continue;
        const explicit = sibling.api ?? sibling.piApi ?? sibling.route?.wireProtocol ?? other.wireProtocol
          ?? (otherAgent === 'claude-code' ? 'anthropic-messages' : otherAgent === 'codex' ? 'openai-responses' : 'openai-chat');
        const candidate = routeOf(other, { ...sibling, api: explicit === 'openai-chat' ? 'openai-completions' : explicit });
        try { if (new URL(candidate.route.baseUrl).origin !== new URL(current.route.baseUrl).origin) continue; } catch { continue; }
        candidates.push(candidate);
      }
      const selected = selectCompatibilityRoute(agent as 'claude-code' | 'codex' | 'pi', candidates)!;
      if (selected === current) return current.model;
      return { ...selected.model, id: model.id, name: model.name, defaultEnabled: model.defaultEnabled, api: selected.api, ...(agent === 'pi' ? { piApi: selected.api } : {}), route: selected.route };
    }) }];
  })) }));
}
