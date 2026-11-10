import type { ProviderView } from '@cindy/model-providers';

/** Never expose runtime header credentials to WebViews or synthetic remote events. */
export function withoutProviderHeaderCredentials(provider: ProviderView): ProviderView {
  if (!provider.routing) return provider;
  const routing = Object.fromEntries(
    Object.entries(provider.routing).map(([agent, descriptor]) => {
      if (!descriptor) return [agent, descriptor];
      const safeDescriptor = { ...descriptor };
      delete safeDescriptor.headerOverride;
      return [agent, safeDescriptor];
    }),
  ) as ProviderView['routing'];
  return { ...provider, routing };
}

