import { REMOTE_AGENT_CHANNEL, parseRemoteAgentCaps, readProviderShareGroupSize, type InvokeResultPayload, type ProviderShareReceived } from '@cindy/device-link';
import { PROVIDER_SHARE_AGENT_DEVICE_PREFIX, providerShareIdOfAgentDeviceId } from '../../shared/providerShare.js';
import { readDeviceProviderCatalog } from '../remote-agent/controller/deviceCatalog.js';
import type { ProviderMediaRuntimeModel } from './providerMediaRuntime.js';

const SHARE_CATALOG_TIMEOUT_MS = 10_000;

interface SharedImageAccess {
  captureOwner(): () => boolean;
  getReceivedShares(): readonly ProviderShareReceived[];
  findReceivedShare(shareId: string): ProviderShareReceived | null;
  invoke(deviceId: string, channel: string, args: unknown[], options?: {
    liveProviderMetadata?: true;
    preSend?: () => void;
  }): Promise<InvokeResultPayload>;
}

let access: SharedImageAccess | undefined;

export function configureSharedImageAccess(next: SharedImageAccess): void {
  access = next;
}

export async function listSharedImageModels(sourceId?: string): Promise<ProviderMediaRuntimeModel[]> {
  const shareId = providerShareIdOfAgentDeviceId(sourceId);
  if (sourceId !== undefined && !shareId) return [];
  const ports = access;
  if (!ports) return [];
  const isCurrent = ports.captureOwner();
  if (!isCurrent()) return [];
  const shares = ports.getReceivedShares().filter(share =>
    (!shareId || share.shareId === shareId) && share.status === 'active' && share.hostOnline,
  );
  const entries = await Promise.all(shares.map(async share => {
    const providerId = `${PROVIDER_SHARE_AGENT_DEVICE_PREFIX}${share.shareId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.all([
          readDeviceProviderCatalog(ports.invoke, providerId, { live: true }),
          ports.invoke(providerId, REMOTE_AGENT_CHANNEL, [{ op: 'caps' }]),
        ]),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SHARE_CATALOG_TIMEOUT_MS); }),
      ]);
      if (!result) return [];
      const [catalog, capabilities] = result;
      if (catalog.stale || !capabilities.ok || !parseRemoteAgentCaps(capabilities.result).sharedImageGeneration
        || ports.findReceivedShare(share.shareId)?.status !== 'active') return [];
      const provider = catalog.views.find(view => view.id === share.providerId);
      if (!provider?.connected || provider.suspended || provider.auth?.native !== 'codex' || provider.source === 'organization') return [];
      const group = readProviderShareGroupSize(provider) !== null;
      return (provider.imageModels ?? []).flatMap((model): ProviderMediaRuntimeModel[] =>
        model.disabled || model.availability === 'requires_payment'
          || (!group && provider.availableMediaModelIds && !provider.availableMediaModelIds.includes(model.id))
          || (model.modalities && (!model.modalities.input.includes('text') || !model.modalities.output.includes('image')))
          ? []
          : [{
            id: model.id,
            name: `${model.name} · ${share.owner.displayName}`,
            providerId, mode: 'image_generation', imageProtocol: 'openai',
            modalities: { input: ['text'], output: ['image'] },
          }],
      );
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }));
  return isCurrent() ? entries.flat() : [];
}

export function resolveSharedImageSource(providerId: string) {
  const shareId = providerShareIdOfAgentDeviceId(providerId);
  const share = shareId ? access?.findReceivedShare(shareId) : null;
  return share?.status === 'active' ? share : null;
}

export async function invokeSharedImageSource(providerId: string, command: unknown, assertCurrent: () => void): Promise<unknown> {
  if (!access) throw new Error('SHARED_IMAGE_UNAVAILABLE');
  const reply = await access.invoke(providerId, REMOTE_AGENT_CHANNEL, [command], { preSend: assertCurrent });
  assertCurrent();
  if (!reply.ok) throw new Error('SHARED_IMAGE_UNAVAILABLE');
  return reply.result;
}
