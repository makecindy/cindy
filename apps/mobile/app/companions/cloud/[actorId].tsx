import { deviceDisplayName } from '@/device-link/deviceName';
import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { CloudCompanionScreen } from '@/session/CloudCompanionScreen';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * A companion whose main computer is offline (docs/product-rules/cloud-companions.md §3.1): the
 * read-only cloud conversation and「换一台电脑继续」. Opened from the teammates list; the row's
 * computer is the companion's main computer.
 */
export default function CloudCompanionRoute() {
  const params = useLocalSearchParams<{ actorId?: string | string[]; botId?: string | string[]; deviceId?: string | string[];
    deviceName?: string | string[]; title?: string | string[] }>();
  const { accountGeneration } = useAuth();
  const actorId = firstParam(params.actorId);
  const deviceId = firstParam(params.deviceId);
  return <CloudCompanionScreen key={`${accountGeneration}:${actorId}`} actorId={actorId} botId={firstParam(params.botId)}
    deviceId={deviceId} deviceName={deviceDisplayName(deviceId, firstParam(params.deviceName))} title={firstParam(params.title)} />;
}
