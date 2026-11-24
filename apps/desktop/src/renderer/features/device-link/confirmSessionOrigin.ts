import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getSessionOnDevice } from '@/lib/makerTransport';
import { resolveReferences } from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';
import { remoteProjectsStore } from './remoteProjectsStore';
import { getStickySessionDeviceId } from './stickySessionOrigin';

export async function confirmSessionOrigin(sessionId: string, deviceId: string, active: () => boolean) {
  const owner = getDataOwnerGeneration();
  const check = () => {
    if (!active() || !isDataOwnerGenerationCurrent(owner)) throw new Error('Session navigation expired');
    const known = getStickySessionDeviceId(sessionId);
    if ((known && known !== deviceId) || sessionsStore.findById(sessionId)) {
      throw new Error('[PERMISSION_DENIED] Conflicting session origin');
    }
  };
  check();
  const mirrored = () => remoteProjectsStore.getDeviceSessions(deviceId).find(row => row.id === sessionId);
  const existing = mirrored();
  if (existing) return existing;

  const needsLocalCheck = !getStickySessionDeviceId(sessionId);
  const current = remoteProjectsStore.captureSessionRead(deviceId, sessionId);
  const row = await getSessionOnDevice(sessionId, deviceId);
  check();
  if (row?.id === sessionId && needsLocalCheck) {
    const [local] = await resolveReferences([sessionId]);
    check();
    if (local?.sessionId !== sessionId || local.state !== 'missing') {
      throw new Error('[PERMISSION_DENIED] Conflicting local session');
    }
  }
  if (!current()) {
    const newer = mirrored();
    if (newer) return newer;
    throw new Error('Remote task read invalidated');
  }
  if (!row || row.id !== sessionId || row.status === 'deleted') throw new Error('[NOT_FOUND] Remote task missing');
  const confirmed = current.mergeActivity(row);
  remoteProjectsStore.mergeDeviceSessions(deviceId, remoteProjectsStore.getDeviceName(deviceId) ?? '', [confirmed],
    confirmed.status === 'archived' ? 'archived' : 'active');
  getStickySessionDeviceId(sessionId);
  return confirmed;
}
