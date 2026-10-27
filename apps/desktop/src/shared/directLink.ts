import type { DirectRuntimeCommand, DirectRuntimeEvent } from '@cindy/device-link';
export const DIRECT_LINK_LOCAL = {
  REGISTER: 'direct-link:host:register',
  COMMAND: 'direct-link:host:command',
  EVENT: 'direct-link:host:event',
} as const;
export interface DirectLinkHostApi {
  register(): Promise<void>;
  onCommand(fn: (command: DirectRuntimeCommand) => void): () => void;
  event(event: DirectRuntimeEvent): void;
}
