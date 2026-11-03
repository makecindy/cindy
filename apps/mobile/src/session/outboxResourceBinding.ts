import type { RemoteResourceRef } from '@cindy/device-link';
import { getRemoteResource } from '@/device-link/remoteResources';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import type { RemoteSession } from './types';

/** Presentation caches never authorize the app-owned outbox to send to a companion. */
export async function validateOutboxResourceBinding(
  invoke: RemoteInvoke, deviceId: string, sessionId: string, ref: RemoteResourceRef, locale: string,
) {
  const resource = await getRemoteResource(invoke, { deviceId, deviceName: deviceId }, ref, locale);
  if (resource.ref.collectionId !== ref.collectionId || resource.ref.kind !== ref.kind || resource.ref.id !== ref.id) {
    throw new Error('[PRECONDITION_FAILED] Resource identity changed');
  }
  const stage = (resource.blocks?.find(block => block.id === 'invitation' && block.primitive === 'status')?.data as { stage?: string } | undefined)?.stage;
  if (stage && stage !== 'ready') {
    throw new Error(stage === 'failed' ? '[PRECONDITION_FAILED] Resource preparation failed' : '[DEVICE_LINK_BUSY] Resource preparing');
  }
  const target = resource.links.find(link => link.rel === 'conversation')?.target;
  if (target?.kind !== 'session' || target.sessionId !== sessionId) {
    throw new Error('[PRECONDITION_FAILED] Resource conversation changed');
  }
  const session = await invoke<RemoteSession>(deviceId, 'local-db:sessions:get', [sessionId]);
  if (!session || session.id !== sessionId || session.status !== 'active' || (ref.kind === 'bot' && session.source !== 'bot')) {
    throw new Error('[PRECONDITION_FAILED] Resource conversation unavailable');
  }
}
