/** Preserve Pi's provider-specific serializers for independently named Cindy connections. */
export const PI_NATIVE_PROVIDER_ADAPTER_SOURCE = String.raw`
async function registerCindyNativeProviderAdapters(pi: any) {
  const raw = process.env.CINDY_PI_NATIVE_PROVIDER_ADAPTERS;
  if (!raw) return;
  const aliases = JSON.parse(raw);
  if (!Array.isArray(aliases) || aliases.length === 0) return;
  const { lazyStream, envApiKeyAuth } = await import('@earendil-works/pi-ai');
  const { getApiProvider } = await import('@earendil-works/pi-ai/compat');
  pi.on('session_start', (_event: any, ctx: any) => {
    for (const alias of aliases) {
      if (typeof alias.id !== 'string' || typeof alias.provider !== 'string' || typeof alias.keyEnv !== 'string') continue;
      const models = ctx.modelRegistry.getAll().filter((model: any) => model.provider === alias.id);
      if (models.length === 0) continue;
      const stream = (model: any, context: any, options: any, simple: boolean) => lazyStream(model, async () => {
        const api = getApiProvider(model.api);
        if (!api) throw new Error('The selected native provider API is unavailable');
        const nativeModel = { ...model, provider: alias.provider };
        const nativeContext = { ...context, messages: context.messages.map((message: any) =>
          message.role === 'assistant' && message.provider === alias.id
            ? { ...message, provider: alias.provider } : message) };
        const nativeOptions = alias.provider === 'cloudflare-ai-gateway'
          ? { ...options, apiKey: undefined, headers: { ...options?.headers,
              'cf-aig-authorization': 'Bearer ' + options?.apiKey, Authorization: null, 'x-api-key': null } }
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
      pi.registerProvider({ id: alias.id, name: alias.name ?? alias.id,
        auth: { apiKey: envApiKeyAuth('API key', [alias.keyEnv]) },
        getModels: () => models,
        stream: (model: any, context: any, options: any) => stream(model, context, options, false),
        streamSimple: (model: any, context: any, options: any) => stream(model, context, options, true),
      });
    }
  });
}
`;
