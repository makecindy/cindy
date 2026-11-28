import type { DirectRuntimeCommand, DirectRuntimeEvent } from '@cindy/device-link';
export const DIRECT_LINK_LOCAL = {
  REGISTER: 'direct-link:host:register',
  COMMAND: 'direct-link:host:command',
  EVENT: 'direct-link:host:event',
  FINISH_TRAFFIC: 'direct-link:host:finish-traffic',
  TRAFFIC: 'direct-link:host:traffic',
} as const;
export interface DirectLinkHostApi {
  onFinishTraffic(finish: () => Promise<{ sent: number; received: number }>): void;
  traffic(sent: number, received: number): void;
  register(): Promise<void>;
  onCommand(fn: (command: DirectRuntimeCommand) => void): () => void;
  event(event: DirectRuntimeEvent): void;
}
