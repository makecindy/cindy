import type { GhostSetupInteractionResponseTarget } from '../cindy-brain/ghostSetupInteractionBridge.js';
import { SessionAdmissionError } from './controller.js';

/** Trusted Desktop sender capability. Never accepted from a wire decision. */
export interface HostInteractionOrigin {
  assertTrustedSender(): void;
  responseTarget?: GhostSetupInteractionResponseTarget;
}
export function requireInteractionOrigin(origin?: HostInteractionOrigin): HostInteractionOrigin {
  if (!origin) throw new SessionAdmissionError('NOT_AUTHORIZED', '此确认必须来自可信的 Cindy 窗口。');
  return origin;
}
