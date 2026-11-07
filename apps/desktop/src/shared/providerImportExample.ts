/** Public, deliberately non-working example. Never populate it from saved providers. */
const providerImportExample = {
  kind: 'custom',
  name: 'Example AI',
  auth: { method: 'apiKey', apiKey: 'REPLACE_WITH_YOUR_API_KEY' },
  endpoints: [{
    protocol: 'openai-chat',
    baseUrl: 'https://example.invalid/v1',
    targets: ['pi'],
    models: [{
      id: 'your-model-id',
      name: 'Example model',
      group: 'custom:example',
      contextWindow: 200000,
      maxOutputTokens: 32000,
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    }],
  }],
};
export const PROVIDER_IMPORT_EXAMPLE_JSON = JSON.stringify(providerImportExample, null, 2) + '\n';
export const PROVIDER_IMPORT_BATCH_EXAMPLE_JSON = JSON.stringify({ providers: [
  providerImportExample,
  { ...providerImportExample, name: 'Example AI 2', endpoints: [{
    ...providerImportExample.endpoints[0], baseUrl: 'https://second.example.invalid/v1',
  }] },
] }, null, 2) + '\n';
