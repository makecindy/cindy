import type { HeadlessProfile } from './profile.js';
import registry from '../capability-registry.json';

export const HEADLESS_CONTRACT_VERSION = 1;
export const CINDY_HEADLESS_VERSION = '0.4.2';
export const CINDY_UPSTREAM_COMMIT = 'e2089e1e0d9f6f5aceed73b1d3550656d5f72359';

export interface HeadlessFeatureCapability {
  type: 'boolean' | 'object' | 'array';
  control: 'profile';
  default: boolean | Record<string, unknown> | unknown[];
  label?: string;
  description?: string;
}

export interface HeadlessControlCapability {
  type: string;
  control: string;
  [key: string]: unknown;
}

export interface HeadlessCapabilityConstraint {
  type: 'mutuallyExclusive';
  features: string[];
  harnesses?: string[];
  offLabel?: string;
}

export interface HeadlessHarnessCapability {
  id: string;
  backend: string;
  features: string[];
  adapterSupported: boolean;
  supportedModelIds?: string[];
  defaultModel?: HeadlessProfile['model'];
}

export interface HeadlessCapabilityCatalog {
  schemaVersion: 1;
  contractVersion: number;
  harnesses: HeadlessHarnessCapability[];
  features: Record<string, HeadlessFeatureCapability>;
  controls: Record<string, HeadlessControlCapability>;
  defaultValues: Record<string, boolean | Record<string, unknown> | unknown[]>;
  constraints?: HeadlessCapabilityConstraint[];
}

const FEATURE_CAPABILITIES = registry.features as Record<string, HeadlessFeatureCapability>;
const CONTROL_CAPABILITIES = registry.controls as Record<string, HeadlessControlCapability>;

export function validateCapabilityRegistry(value: unknown): asserts value is typeof registry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('capability registry must be an object');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || candidate.contractVersion !== HEADLESS_CONTRACT_VERSION) throw new Error('unsupported capability registry schema or contract');
  if (!candidate.features || typeof candidate.features !== 'object' || Array.isArray(candidate.features)) throw new Error('capability registry features must be an object');
  if (!candidate.controls || typeof candidate.controls !== 'object' || Array.isArray(candidate.controls)) throw new Error('capability registry controls must be an object');
  if (!candidate.harnesses || typeof candidate.harnesses !== 'object' || Array.isArray(candidate.harnesses)) throw new Error('capability registry harnesses must be an object');
  const features = candidate.features as Record<string, unknown>;
  for (const [id, raw] of Object.entries(features)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid capability registry feature: ${id}`);
    const feature = raw as Record<string, unknown>;
    if (!['boolean', 'object', 'array'].includes(String(feature.type)) || feature.control !== 'profile' || !Object.hasOwn(feature, 'default')) throw new Error(`invalid capability registry feature: ${id}`);
  }
  for (const [backend, raw] of Object.entries(candidate.harnesses as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid capability registry harness: ${backend}`);
    const harness = raw as Record<string, unknown>;
    if (typeof harness.id !== 'string' || !Array.isArray(harness.features) || harness.features.some((id) => typeof id !== 'string' || !(id in features))) throw new Error(`invalid capability registry harness: ${backend}`);
  }
  if (!Array.isArray(candidate.constraints)) throw new Error('capability registry constraints must be an array');
  for (const raw of candidate.constraints) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid capability registry constraint');
    const constraint = raw as Record<string, unknown>;
    if (constraint.type !== 'mutuallyExclusive' || !Array.isArray(constraint.features) || constraint.features.length < 2 || constraint.features.some((id) => typeof id !== 'string' || !(id in features))) throw new Error('invalid capability registry constraint');
  }
}

validateCapabilityRegistry(registry);

export const ADAPTER_FEATURES = new Set(Object.keys(FEATURE_CAPABILITIES));
export const ADAPTER_HARNESSES = new Set<HeadlessProfile['agentBackend']>(['claude-code', 'codex', 'pi']);

export function capabilityCatalog(backend?: HeadlessProfile['agentBackend']): HeadlessCapabilityCatalog {
  const backends = backend ? [backend] : [...ADAPTER_HARNESSES];
  return {
    schemaVersion: 1,
    contractVersion: registry.contractVersion,
    harnesses: backends.map((item) => ({
      id: registry.harnesses[item].id,
      backend: item,
      features: registry.harnesses[item].features,
      adapterSupported: true,
    })),
    features: { ...FEATURE_CAPABILITIES },
    controls: { ...CONTROL_CAPABILITIES },
    defaultValues: Object.fromEntries(Object.entries(FEATURE_CAPABILITIES).map(([id, feature]) => [id, feature.default])),
    constraints: registry.constraints as HeadlessCapabilityConstraint[],
  };
}

export interface CapabilityDetection {
  schemaVersion: 1;
  contractVersion: number;
  harnesses: Array<HeadlessHarnessCapability & { status: 'SUPPORTED' | 'DETECTED_BUT_UNSUPPORTED' }>;
  features: Record<string, HeadlessFeatureCapability>;
  controls: Record<string, HeadlessControlCapability>;
  defaultValues: Record<string, boolean | Record<string, unknown> | unknown[]>;
  constraints?: HeadlessCapabilityConstraint[];
  adapter: {
    understoodFeatures: string[];
    understoodHarnesses: string[];
    detected: Array<{ id: string; status: 'SUPPORTED' | 'DETECTED_BUT_UNSUPPORTED' }>;
  };
  support: Record<string, 'SUPPORTED' | 'DETECTED_BUT_UNSUPPORTED'>;
}

export function discoverCapabilityCatalog(value: unknown): CapabilityDetection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bundle manifest does not contain capabilityCatalog');
  const catalog = value as Partial<HeadlessCapabilityCatalog>;
  if (catalog.schemaVersion !== 1 || typeof catalog.contractVersion !== 'number') throw new Error('unsupported capabilityCatalog schema or contract');
  if (!catalog.features || typeof catalog.features !== 'object' || Array.isArray(catalog.features)) throw new Error('capabilityCatalog.features must be an object');
  if (!catalog.controls || typeof catalog.controls !== 'object' || Array.isArray(catalog.controls)) throw new Error('capabilityCatalog.controls must be an object');
  if (!Array.isArray(catalog.harnesses)) throw new Error('capabilityCatalog.harnesses must be an array');
  const detected = Object.keys(catalog.features).map((id) => ({
    id,
    status: ADAPTER_FEATURES.has(id) ? 'SUPPORTED' as const : 'DETECTED_BUT_UNSUPPORTED' as const,
  }));
  const harnesses = catalog.harnesses.map((harness) => {
    if (!harness || typeof harness !== 'object' || typeof harness.id !== 'string' || typeof harness.backend !== 'string' || !Array.isArray(harness.features)) {
      throw new Error('capabilityCatalog contains an invalid harness');
    }
    const understood = ADAPTER_HARNESSES.has(harness.backend as HeadlessProfile['agentBackend']);
    const featuresSupported = harness.features.every((id) => ADAPTER_FEATURES.has(id));
    const status = understood && harness.adapterSupported !== false && featuresSupported ? 'SUPPORTED' as const : 'DETECTED_BUT_UNSUPPORTED' as const;
    return { ...harness, adapterSupported: status === 'SUPPORTED', status };
  });
  return {
    schemaVersion: 1,
    contractVersion: catalog.contractVersion,
    harnesses,
    features: catalog.features,
    controls: catalog.controls,
    defaultValues: catalog.defaultValues ?? {},
    constraints: catalog.constraints ?? [],
    adapter: { understoodFeatures: [...ADAPTER_FEATURES], understoodHarnesses: [...ADAPTER_HARNESSES], detected },
    support: Object.fromEntries(detected.map((item) => [item.id, item.status])),
  };
}

export interface CompatibilityReport {
  schemaVersion: 1;
  contractVersion: number;
  cindyUpstreamCommit: string;
  backend: HeadlessProfile['agentBackend'];
  binaryVersion: string;
  transport: 'claude-agent-sdk' | 'codex-app-server-jsonrpc' | 'pi-rpc-jsonl';
  requiredCapabilities: string[];
  security: {
    permissionMode: HeadlessProfile['permissionMode'];
    containerSandbox: boolean;
    safeForUntrustedWorkloads: boolean;
  };
}

export function compatibilityReport(profile: HeadlessProfile): CompatibilityReport {
  const codex = profile.agentBackend === 'codex';
  const pi = profile.agentBackend === 'pi';
  const isolated = profile.containerSandbox === true;
  const bypass = profile.permissionMode === 'bypassPermissions';
  return {
    schemaVersion: 1,
    contractVersion: HEADLESS_CONTRACT_VERSION,
    cindyUpstreamCommit: CINDY_UPSTREAM_COMMIT,
    backend: profile.agentBackend,
    binaryVersion: profile.agentBinaryVersion,
    transport: pi ? 'pi-rpc-jsonl' : codex ? 'codex-app-server-jsonrpc' : 'claude-agent-sdk',
    requiredCapabilities: [
      'multi-turn-session',
      'structured-agent-events',
      'abort-and-close',
      'usage-reporting',
      ...(profile.makerMemory ? ['mcp'] : []),
    ],
    security: {
      permissionMode: profile.permissionMode,
      containerSandbox: isolated,
      safeForUntrustedWorkloads: !bypass || isolated,
    },
  };
}

export function assertSafeExecutionProfile(profile: HeadlessProfile): void {
  if (
    profile.permissionMode === 'bypassPermissions'
    && profile.containerSandbox !== true
    && profile.unsafeAllowUnsandboxedBypass !== true
    && process.env.CINDY_HEADLESS_ALLOW_UNSANDBOXED_BYPASS !== '1'
  ) {
    throw new Error('bypassPermissions requires containerSandbox=true; set CINDY_HEADLESS_ALLOW_UNSANDBOXED_BYPASS=1 only in a controlled environment');
  }
}
