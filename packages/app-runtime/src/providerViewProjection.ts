import type { ProviderView } from '@cindy/model-providers';
export function projectProviderList(input: {
  dataOwnerId: string | null;
  ownerGeneration: number;
  providers: ProviderView[];
  providerOrder: string[];
  modelVisibilityOverrides: Record<string, boolean>;
  remoteAccess?: ((providerId: string) => boolean) | null;
}) {
  const {remoteAccess,...snapshot}=input;
  return {...snapshot,providers:input.providers.map(provider=>{
    const safe=withoutProviderHeaderCredentials(provider);
    const view={...safe,...(safe.models ? {models:Object.fromEntries(Object.entries(safe.models).map(([agent,models])=>[
      agent,models?.map(model=>({...model,effortsUnknown:model.effortsUnknown===true})),
    ]))} : {})};
    return remoteAccess ? {...view,remoteInvocationEnabled:remoteAccess(provider.id)} : view;
  })};
}
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
