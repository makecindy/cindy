import type { HeadlessCapabilityCatalog, HeadlessHarnessCapability } from './compatibility.js';
import { ADAPTER_HARNESSES, discoverCapabilityCatalog } from './compatibility.js';
import type { HeadlessProfile } from './profile.js';
import { validateProfile } from './profile.js';

export interface ProfileGenerationOptions {
  manifestPath: string;
  outputPath: string;
  harness: string;
  features?: string[];
  modelId?: string;
  providerId?: string;
  providerName?: string;
  providerBaseUrl?: string;
  providerApi?: 'anthropic-messages' | 'openai-responses' | 'openai-completions' | 'google-generative-ai';
  apiKeyEnvVar?: string;
  contextLimit?: number;
  maxOutputTokens?: number;
  mcpServers?: HeadlessProfile['mcpServers'];
  effort?: HeadlessProfile['model']['effort'];
  gatewayModel?: boolean;
  exactFeatures?: boolean;
}

type BundleManifest = Record<string, unknown> & { capabilityCatalog?: HeadlessCapabilityCatalog };

const HARNESS_FILES = {
  'claude-code': { binary: 'bin/claude', prompt: 'prompt.md', version: 'claudeCodeVersion', digest: 'systemPromptDigest' },
  codex: { binary: 'bin/codex', prompt: 'codex-prompt.md', version: 'codexVersion', digest: 'codexSystemPromptDigest' },
  pi: { binary: 'bin/pi/pi', prompt: 'pi-prompt.md', version: 'piVersion', digest: 'piSystemPromptDigest' },
} as const;

const DEFAULT_MODELS: Record<keyof typeof HARNESS_FILES, HeadlessProfile['model']> = {
  'claude-code': { provider: 'anthropic', requestedId: 'claude-sonnet-4-6', effort: 'high' },
  codex: { provider: 'openai', requestedId: 'gpt-5.4-mini', effort: 'high' },
  pi: { provider: 'cindy', requestedId: 'claude-sonnet-4-6', contextLimit: 200_000, maxOutputTokens: 32_000, effort: 'high' },
};

// This is implementation coverage, not a second capability catalog. Adding a
// registry entry without teaching the generator how to materialize it must fail
// closed instead of being advertised and silently ignored.
export const PROFILE_GENERATION_FEATURES = new Set([
  'projectContext', 'makerMemory', 'nativeMemory', 'attachments', 'piProjectSkills',
]);

function assertGeneratorCoverage(catalog: HeadlessCapabilityCatalog): void {
  const missing = Object.keys(catalog.features).filter((id) => !PROFILE_GENERATION_FEATURES.has(id));
  if (missing.length) throw new Error(`DETECTED_BUT_UNSUPPORTED: profile generator has no implementation for ${missing.join(', ')}`);
}

function requireManifestString(manifest: BundleManifest, field: string): string {
  const value = manifest[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`bundle manifest is missing ${field}`);
  return value;
}

function harnessEntry(catalog: HeadlessCapabilityCatalog, harness: string): HeadlessHarnessCapability {
  const entry = catalog.harnesses.find((item) => item.backend === harness);
  if (!entry) throw new Error(`bundle does not provide harness: ${harness}`);
  if (!ADAPTER_HARNESSES.has(harness as HeadlessProfile['agentBackend']) || entry.adapterSupported === false) {
    throw new Error(`DETECTED_BUT_UNSUPPORTED: harness ${harness}`);
  }
  return entry;
}

export function generateProfileFromManifest(manifest: BundleManifest, options: ProfileGenerationOptions): HeadlessProfile {
  const discovered = discoverCapabilityCatalog(manifest.capabilityCatalog);
  const catalog = manifest.capabilityCatalog as HeadlessCapabilityCatalog;
  assertGeneratorCoverage(catalog);
  const entry = harnessEntry(catalog, options.harness);
  const harness = options.harness as keyof typeof HARNESS_FILES;
  const selected = new Set(options.features ?? []);
  const unsupported = [...selected].filter((id) => discovered.support[id] !== 'SUPPORTED' || !entry.features.includes(id));
  if (unsupported.length) throw new Error(`DETECTED_BUT_UNSUPPORTED: ${unsupported.join(', ')}`);

  const files = HARNESS_FILES[harness];
  const defaults = catalog.defaultValues ?? {};
  const enabled = (id: string) => selected.has(id) || (!options.exactFeatures && selected.size === 0 && defaults[id] === true);
  const defaultModel = entry.defaultModel ?? DEFAULT_MODELS[harness];
  const supportedModelIds = entry.supportedModelIds?.length ? [...entry.supportedModelIds] : [defaultModel.requestedId];
  const requestedId = options.modelId ?? defaultModel.requestedId;
  const customModel = !supportedModelIds.includes(requestedId);
  const customPiModel = harness === 'pi' && customModel;
  if (harness !== 'pi' && customModel && !options.gatewayModel) throw new Error(`model ${requestedId} is not supported by harness ${harness}`);
  if (options.gatewayModel && (!options.modelId || !options.providerId || !options.providerBaseUrl || !options.providerApi)) {
    throw new Error('gateway models require --model, --provider, --base-url and --api');
  }

  let nativeProviders: HeadlessProfile['nativeProviders'];
  let model: HeadlessProfile['model'] = { ...defaultModel, requestedId, effort: options.effort ?? defaultModel.effort ?? 'high' };
  if (customPiModel) {
    if (!options.providerId || !options.providerBaseUrl || !options.providerApi || !options.contextLimit || !options.maxOutputTokens) {
      throw new Error('custom Pi models require --provider, --base-url, --api, --context-limit and --max-output-tokens');
    }
    model = { provider: options.providerId, requestedId, contextLimit: options.contextLimit, maxOutputTokens: options.maxOutputTokens, effort: options.effort ?? defaultModel.effort ?? 'high' };
    nativeProviders = [{
      id: options.providerId,
      name: options.providerName ?? options.providerId,
      baseUrl: options.providerBaseUrl,
      api: options.providerApi,
      ...(options.apiKeyEnvVar ? { apiKeyEnvVar: options.apiKeyEnvVar } : {}),
      models: [{ id: requestedId, contextWindow: options.contextLimit, maxTokens: options.maxOutputTokens }],
    }];
    supportedModelIds.push(requestedId);
  }
  if (customModel && harness !== 'pi') {
    model = { ...model, provider: options.providerId!, requestedId };
    supportedModelIds.push(requestedId);
  }
  const compaction = defaults.compaction;
  return validateProfile({
    id: `generated-${harness}`,
    version: 1,
    agentBackend: harness,
    agentBinaryPath: `bundle:${files.binary}`,
    agentBinaryVersion: requireManifestString(manifest, files.version),
    supportedModelIds,
    model,
    permissionMode: 'bypassPermissions',
    systemPromptFile: `bundle:${files.prompt}`,
    expectedSystemPromptDigest: requireManifestString(manifest, files.digest),
    makerMemory: enabled('makerMemory'),
    nativeMemory: enabled('nativeMemory'),
    projectContext: enabled('projectContext'),
    containerSandbox: true,
    ...(enabled('attachments') ? { inputPolicy: { attachments: true, workspaceOnly: true } } : {}),
    ...(enabled('piProjectSkills') ? { piProjectSkills: { enabled: true, roots: ['.pi/skills', '.agents/skills'] } } : {}),
    ...(compaction && typeof compaction === 'object' ? { compaction } : {}),
    ...(nativeProviders ? { nativeProviders } : {}),
    ...(options.mcpServers?.length ? { mcpServers: options.mcpServers } : {}),
  });
}
