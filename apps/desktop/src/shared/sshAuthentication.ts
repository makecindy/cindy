import type { KeyboardInteractiveChallenge } from '@cindy/maker-remote-ssh';

/** Public challenge text only. Answers are never part of a snapshot. */
export interface SshAuthenticationRequest extends KeyboardInteractiveChallenge {
  requestId: string;
  expiresAt: number;
}
