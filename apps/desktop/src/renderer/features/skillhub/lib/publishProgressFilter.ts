import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';

export function shouldHandlePublishProgressEvent(
  event: object & { name?: unknown; ownerStamp?: unknown },
  activeName: string | null,
): boolean {
  if (!activeName || !isDataOwnerPushCurrent(event.ownerStamp)) return false;
  const eventName = typeof event.name === 'string' && event.name.length > 0
    ? event.name
    : null;
  return eventName === null || eventName === activeName;
}
