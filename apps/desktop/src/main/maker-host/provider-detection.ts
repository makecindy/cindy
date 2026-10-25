import { detectDeploymentProviders, enrichDetectedModels, providerDeploymentRoot, type DeploymentProvider, type ProviderEvidence } from '@cindy/model-providers';
import { fetchProviderModels, type ProviderModelsFetchSpec } from './provider-model-fetch.js';
import type { DeploymentDetectionResult } from '../../shared/providerDetection.js';
import { outboundFetch } from './outbound-fetch.js';

type Probe = { id: keyof ProviderEvidence; system: DeploymentProvider; path: string; auth?: 'required' | 'optional' };
const PROBES: readonly Probe[] = [
  { id: 'lmGreeting', system: 'lmstudio', path: '/lmstudio-greeting' },
  { id: 'llamaProps', system: 'llamacpp', path: '/props', auth: 'optional' },
  { id: 'vllmVersion', system: 'vllm', path: '/version' },
  { id: 'subPublic', system: 'sub2api', path: '/api/v1/settings/public' },
  { id: 'lmModels', system: 'lmstudio', path: '/api/v1/models', auth: 'optional' },
  { id: 'liteReady', system: 'litellm', path: '/health/readiness/details', auth: 'required' },
  { id: 'subBilling', system: 'sub2api', path: '/v1/sub2api/billing', auth: 'required' },
  { id: 'liteModels', system: 'litellm', path: '/v1/model/info', auth: 'required' },
];

async function readIdentity(response: Response): Promise<unknown> {
  // A cloned stream's cancel waits for its sibling. Do not deadlock the directory reader.
  if (!response.ok || !response.body) { void response.body?.cancel().catch(() => undefined); return; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) return;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => undefined); }
}

/** Bounded read-only probes. All credentials stay in memory; errors never include responses. */
export async function detectProviderDeployment(
  spec: ProviderModelsFetchSpec,
  signal: AbortSignal,
  fetchImpl: typeof fetch = outboundFetch,
  timeoutSignal: (ms: number) => AbortSignal = ms => AbortSignal.timeout(ms),
): Promise<DeploymentDetectionResult> {
  const root = providerDeploymentRoot(spec.baseUrl);
  if (!root || signal.aborted) return { candidates: [], reason: 'insufficient_evidence' };
  const evidence: ProviderEvidence = {};
  const deadline = timeoutSignal(8000);
  const identitySignal = AbortSignal.any([signal, deadline]);
  let index = 0;
  let candidates: DeploymentProvider[] = [];
  const wrappedFetch: typeof fetch = async (url, init) => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    // Only a plain account-visible OpenAI directory supplies cross-check evidence.
    if (String(url) === root + '/v1/models') {
      try { evidence.models = await readIdentity(response.clone()); candidates = detectDeploymentProviders(evidence); } catch { /* optional clue */ }
    }
    return response;
  };
  const catalogPromise = fetchProviderModels({ ...spec, baseUrl: root + '/v1', modelsUrl: root + '/v1/models', redirect: 'error', allowEmpty: true, responseByteLimit: 8 * 1024 * 1024 }, wrappedFetch);
  const worker = async () => {
    while (index < PROBES.length && !identitySignal.aborted) {
      const probe = PROBES[index++];
      if (probe.auth === 'required' && !spec.apiKey?.trim()) continue;
      const headers: Record<string, string> = {};
      if (probe.auth) {
        for (const [key, value] of Object.entries(spec.headers ?? {})) {
          if (!['authorization', 'x-api-key', 'x-goog-api-key', 'host', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) headers[key] = value;
        }
        if (spec.authMethod !== 'none' && spec.apiKey?.trim()) headers.Authorization = `Bearer ${spec.apiKey.trim()}`;
      }
      try {
        const response = await fetchImpl(root + probe.path, { method: 'GET', headers, redirect: 'error',
          signal: AbortSignal.any([identitySignal, timeoutSignal(3000)]) });
        evidence[probe.id] = await readIdentity(response);
        candidates = detectDeploymentProviders(evidence);
      } catch { /* Missing/forbidden diagnostics only disable identification. */ }
    }
  };
  await Promise.all([worker(), worker()]);
  const catalog = await catalogPromise;
  candidates = detectDeploymentProviders(evidence);
  if (catalog.models && candidates.length === 1) catalog.models = enrichDetectedModels(catalog.models, candidates[0], evidence);
  return { candidates, reason: candidates.length > 1 ? 'conflict' : candidates.length === 1 ? 'matched'
    : deadline.aborted ? 'budget_exhausted' : 'insufficient_evidence',
    // Return only existing classified errors/model metadata, never diagnostic/billing JSON.
    catalog: signal.aborted ? undefined : { ok: catalog.ok, models: catalog.models, code: catalog.code, status: catalog.status } };
}
