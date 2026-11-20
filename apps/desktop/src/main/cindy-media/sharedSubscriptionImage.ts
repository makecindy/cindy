import { isOpenAiSubscriptionProvider, isOrganizationManagedProvider, type Provider } from '@cindy/model-providers';

export function subscriptionImageModelId(providerId: string): string {
  return `${providerId}/gpt-image-2`;
}

/** The built-in OpenAI row can also list Platform API models. A share uses subscription OAuth only. */
export function canShareSubscriptionImage(provider: Provider, modelId: string): boolean {
  return isOpenAiSubscriptionProvider(provider) && !isOrganizationManagedProvider(provider)
    && (provider.id !== 'openai' || modelId === subscriptionImageModelId(provider.id));
}
