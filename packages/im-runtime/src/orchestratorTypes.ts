import type { ImChannelAdapter, ImChannelName } from './types.js';
import type { ImSessionRepo } from './sessionRepo.js';
import type { ImCardBuilders } from './cardBuilders.js';
import type { ImTurnRunner } from './turnRunner.js';

export interface ImOrchestrator {
  readonly channel: ImChannelName;
  readonly adapter: ImChannelAdapter;
  readonly repo: ImSessionRepo;
  readonly cards: ImCardBuilders;
  readonly turnRunner: ImTurnRunner;
  detachFromSession(sessionId: string): void;
  disposeAllSessions(): Promise<void>;
  unregister(): void;
}
