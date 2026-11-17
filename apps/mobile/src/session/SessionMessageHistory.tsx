import type { ComponentProps } from 'react';
import { useCompanionThreads } from './CompanionThreads';
import { MessageRenderer } from './MessageRenderer';
import { useMessageHistoryActive } from './messageHistoryActivity';

/** Layout-affecting companion reads share the resident list's lifetime. A new
 * route must not replace known capabilities/reply counts with an empty query.
 * Navigation and dispatch readiness still come from the current route. */
export function SessionMessageHistory({ companionThreadOptions, ...props }: Omit<ComponentProps<typeof MessageRenderer>, 'companionThreads'> & {
  companionThreadOptions: Parameters<typeof useCompanionThreads>[0];
}) {
  const active = useMessageHistoryActive();
  const companionThreads = useCompanionThreads({ ...companionThreadOptions, active });
  return <MessageRenderer {...props} companionThreads={companionThreads} />;
}
