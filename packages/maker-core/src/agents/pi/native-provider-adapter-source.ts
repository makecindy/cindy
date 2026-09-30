/** Preserve Pi's provider-specific serializers for independently named Cindy connections. */
export function nativeProviderAdapterAliases(
  nativeProviders: Array<{ id: string; name: string; adapterProvider?: string; apiKeyEnvVar?: string }>,
): Array<{ id: string; name: string; provider: string; keyEnv?: string }> {
  return nativeProviders.flatMap((provider) =>
    provider.adapterProvider
      ? [{
          id: provider.id,
          name: provider.name,
          provider: provider.adapterProvider,
          ...(provider.apiKeyEnvVar ? { keyEnv: provider.apiKeyEnvVar } : {}),
        }]
      : [],
  );
}

export const PI_NATIVE_PROVIDER_ADAPTER_SOURCE = String.raw`
type CindyAdapterAlias = { id: string; name: string; provider: string; keyEnv?: string };
type CindyProviderRefreshSnapshot = {
  nonce: string;
  env: Record<string, string>;
  aliases: CindyAdapterAlias[];
};

const CINDY_DYNAMIC_KEY_ENV_PATTERN = /^CINDY_PI_KEY_[A-Z0-9_]+$/;
function cindyRefreshEnvAllowed(name: string): boolean {
  return CINDY_DYNAMIC_KEY_ENV_PATTERN.test(name)
    || name === 'CINDY_PI_SESSION_TOKEN'
    || name === 'CINDY_PI_API_KEY'
    || CINDY_FIXED_ADAPTER_KEYS.has(name);
}
const CINDY_FIXED_ADAPTER_KEYS = new Set([
  'CINDY_PI_OPENAI_PROXY_KEY',
  'CINDY_PI_XAI_PROXY_API_KEY',
]);

function parseCindyProviderRefreshSnapshot(raw: unknown, nonce: string): CindyProviderRefreshSnapshot | undefined {
  if (typeof raw !== 'string') return undefined;
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return undefined; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.nonce !== nonce) return undefined;
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) return undefined;
  if (!Array.isArray(payload.aliases)) return undefined;
  const env: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(payload.env)) {
    if (!cindyRefreshEnvAllowed(name) || typeof value !== 'string') return undefined;
    env[name] = value;
  }
  const aliases: CindyAdapterAlias[] = [];
  const seen = new Set<string>();
  for (const alias of payload.aliases) {
    if (!alias || typeof alias !== 'object' || Array.isArray(alias)) return undefined;
    if (typeof alias.id !== 'string' || !alias.id || seen.has(alias.id)) return undefined;
    if (typeof alias.name !== 'string') return undefined;
    if (typeof alias.provider !== 'string' || !alias.provider) return undefined;
    if (alias.keyEnv !== undefined && (
      typeof alias.keyEnv !== 'string'
      || !cindyRefreshEnvAllowed(alias.keyEnv)
      || !Object.hasOwn(env, alias.keyEnv)
    )) return undefined;
    seen.add(alias.id);
    aliases.push({ id: alias.id, name: alias.name, provider: alias.provider,
      ...(alias.keyEnv ? { keyEnv: alias.keyEnv } : {}) });
  }
  return { nonce, env, aliases };
}

async function registerCindyNativeProviderAdapters(pi: any) {
  let aliases: CindyAdapterAlias[] = [];
  try {
    const initial = JSON.parse(process.env.CINDY_PI_NATIVE_PROVIDER_ADAPTERS ?? '[]');
    if (Array.isArray(initial)) aliases = initial;
  } catch { /* A malformed startup hint cannot affect other Pi extensions. */ }
  const registered = new Set<string>();
  let apis: { lazyStream: any; envApiKeyAuth: any; getApiProvider: any } | undefined;
  async function loadApis() {
    if (!apis) {
      const [{ lazyStream, envApiKeyAuth }, { getApiProvider }] = await Promise.all([
        import('@earendil-works/pi-ai'),
        import('@earendil-works/pi-ai/compat'),
      ]);
      apis = { lazyStream, envApiKeyAuth, getApiProvider };
    }
    return apis;
  }
  function registerAliases(models: any[], currentAliases: CindyAdapterAlias[]) {
    if (!apis) throw new Error('Native provider adapter is unavailable');
    const { lazyStream, envApiKeyAuth, getApiProvider } = apis;
    for (const alias of currentAliases) {
      const providerModels = models.filter((model: any) => model.provider === alias.id);
      if (providerModels.length === 0) continue;
      const stream = (model: any, context: any, options: any, simple: boolean) => lazyStream(model, async () => {
        const api = getApiProvider(model.api);
        if (!api) throw new Error('The selected native provider API is unavailable');
        const nativeModel = { ...model, provider: alias.provider };
        const nativeContext = { ...context, messages: context.messages.map((message: any) =>
          message.role === 'assistant' && message.provider === alias.id
            ? { ...message, provider: alias.provider } : message) };
        const token = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
        const placeholderKey = !token || ['pi-native-keyless', 'cindy-pi-provider-auth-placeholder', 'cindy-local-provider'].includes(token);
        const gatewayKey = token && !placeholderKey
          ? 'Bearer ' + token : options?.headers?.['cf-aig-authorization'];
        const nativeOptions = alias.provider === 'cloudflare-ai-gateway'
          ? { ...options, apiKey: undefined, headers: { ...options?.headers,
              ...(gatewayKey ? { 'cf-aig-authorization': gatewayKey } : {}),
              Authorization: null, 'x-api-key': null } }
          : options;
        const events = simple ? api.streamSimple(nativeModel, nativeContext, nativeOptions) : api.stream(nativeModel, nativeContext, nativeOptions);
        return (async function* () {
          for await (const event of events) yield { ...event,
            ...(event.partial ? { partial: { ...event.partial, provider: alias.id } } : {}),
            ...(event.message ? { message: { ...event.message, provider: alias.id } } : {}),
            ...(event.error ? { error: { ...event.error, provider: alias.id } } : {}),
          };
        })();
      });
      pi.registerProvider({ id: alias.id, name: alias.name,
        ...(alias.keyEnv ? { auth: { apiKey: envApiKeyAuth('API key', [alias.keyEnv]) } } : {}),
        getModels: () => providerModels,
        stream: (model: any, context: any, options: any) => stream(model, context, options, false),
        streamSimple: (model: any, context: any, options: any) => stream(model, context, options, true),
      });
      registered.add(alias.id);
    }
  }
  if (aliases.length) await loadApis();
  pi.on('session_start', (_event: any, ctx: any) => {
    if (aliases.length) registerAliases(ctx.modelRegistry.getAll(), aliases);
  });
  return {
    async refresh(snapshot: CindyProviderRefreshSnapshot, ctx: any, secretEnvNames: Set<string>) {
      if (snapshot.aliases.length) await loadApis();
      // The host supplies the entire current dynamic-key snapshot, so deleted
      // provider/header keys disappear from both Pi and future bash children.
      for (const name of Object.keys(process.env)) {
        if (cindyRefreshEnvAllowed(name) && !Object.hasOwn(snapshot.env, name)) {
          delete process.env[name];
          secretEnvNames.delete(name);
        }
      }
      for (const [name, value] of Object.entries(snapshot.env)) {
        process.env[name] = value;
        secretEnvNames.add(name);
      }
      for (const id of registered) pi.unregisterProvider(id);
      registered.clear();
      const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
      if (result?.aborted || result?.errors?.size) throw new Error('Native provider catalog refresh failed');
      aliases = snapshot.aliases;
      if (aliases.length) registerAliases(ctx.modelRegistry.getAll(), aliases);
      // Registering providers schedules an internal refresh in Pi. Await one
      // public refresh so the receipt reflects the final provider snapshot.
      const final = await ctx.modelRegistry.refresh({ allowNetwork: false });
      if (final?.aborted || final?.errors?.size) throw new Error('Native provider adapter refresh failed');
    },
  };
}
`;
