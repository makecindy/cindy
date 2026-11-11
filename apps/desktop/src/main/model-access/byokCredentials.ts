/** Main-only ephemeral credentials. The owner-scoped synchronizer supplies the readers. */
let keyReader: (providerId: string, agent: string) => string | null = () => null;
let endpointReader: (providerId: string) => string | null = () => null;
let managedProviderReader: (providerId: string) => boolean = () => false;

export function setByokCredentialReader(next: typeof keyReader): void {
  keyReader = next;
}

export function setByokEndpointReader(next: typeof endpointReader): void {
  endpointReader = next;
}

export function setByokManagedProviderReader(next: typeof managedProviderReader): void {
  managedProviderReader = next;
}

export function readByokCredential(providerId: string, agent: string): string | null {
  return keyReader(providerId, agent);
}

/** Includes pending directory entries, so a personal same-id connection cannot be revived. */
export function isInstalledByokProvider(providerId: string): boolean {
  return managedProviderReader(providerId);
}

/** Live OpenAI-images origin: no trailing slash, no trailing `/v1`. */
export function readByokInferenceBase(providerId: string): string | null {
  const endpoint = endpointReader(providerId)?.trim();
  if (!endpoint) return null;
  return endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
}
