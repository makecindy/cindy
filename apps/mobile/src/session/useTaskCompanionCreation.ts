import { useEffect, useRef, useState } from 'react';
import { isSharedTaskPeer } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import type { DeviceLinkContextValue } from '@/device-link/DeviceLinkContext';
import type { RemoteSession } from './types';

/** Probe the source host; old hosts never show an operation they cannot execute. */
export function useTaskCompanionCreation(options: {
  visible: boolean; deviceId: string; session: RemoteSession | null | undefined;
  invoke: DeviceLinkContextValue['invoke'];
  onCreated(result: { botId: string; sessionId: string }): void;
}) {
  const { visible, deviceId, session, invoke } = options;
  const [available, setAvailable] = useState(false);
  const generation = useRef(0);
  const eligible = !!session && session.source === 'desktop' && !session.remoteHostId
    && !session.agentDeviceId && !session.orcaRole && !isSharedTaskPeer(deviceId);
  useEffect(() => {
    generation.current++;
    let current = true;
    setAvailable(false);
    if (visible && eligible && deviceId) {
      const owner = getMobileAuthOwner();
      void invoke<{ version?: number }>(deviceId, 'maker:task-companion', [{ action: 'capabilities' }])
        .then(result => { if (current && isMobileAuthOwnerCurrent(owner)) setAvailable(result.version === 1); })
        .catch(() => {});
    }
    return () => { current = false; generation.current++; };
  }, [visible, eligible, deviceId, session?.id, invoke]);
  return available && session ? async (name: string, description: string) => {
    const owner = getMobileAuthOwner();
    const epoch = generation.current;
    const result = await invoke<{ version: number; botId: string; sessionId: string }>(deviceId,
      'maker:task-companion', [{ action: 'create', sourceSessionId: session.id, name, description }]);
    if (!isMobileAuthOwnerCurrent(owner) || epoch !== generation.current) return;
    options.onCreated(result);
  } : undefined;
}
