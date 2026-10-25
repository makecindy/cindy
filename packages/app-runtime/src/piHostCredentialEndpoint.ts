import { PROVIDER_MODEL_CATALOG, providerEndpointBindings } from '@cindy/model-providers';

export const HOST_CREDENTIAL_APIS = new Set<string>(['google-vertex', 'bedrock-converse-stream']);

/** Vertex ADC / Bedrock IAM may only target Main-approved cloud endpoints. */
export function hostCredentialEndpointAllowed(api: string, destination: string): boolean {
  if (!HOST_CREDENTIAL_APIS.has(api)) return true;
  return Object.values(PROVIDER_MODEL_CATALOG.providers).some((rows) =>
    rows.some((row) => row.execution.pi.api === api && providerEndpointBindings(row.upstream, destination) !== null));
}

