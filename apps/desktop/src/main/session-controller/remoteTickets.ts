import { randomUUID } from 'node:crypto';
import type { SessionControlRequest } from '@cindy/maker-shared/session-controller';
import { sessionIntentFingerprint } from './idempotency.js';
import { SessionAdmissionError } from './controller.js';

export interface RemoteSessionPrincipal {
  sourceSessionId: string;
  /** A classification produced by source-host authority, never a tool parameter. */
  authority: 'owner-turn' | 'ordinary-session';
  callerKey: string;
}
export interface RemoteSessionTicketOwner {
  assertCurrent(): void;
  authorizeRemote(request: SessionControlRequest): Promise<RemoteSessionPrincipal>;
}

/** Request-scoped attestations. The target resolves a token over the authenticated
 * device link back to its issuer. JSON claims cannot grant Session permissions.
 * Tickets disappear on completion/restart; business receipts live separately. */
export function createRemoteSessionTickets() {
  const tickets = new Map<string, { digest: string; request: SessionControlRequest; owner: RemoteSessionTicketOwner }>();
  return {
    assertCurrent(targetDeviceId: string, token: string, digest: string): void {
      const ticket = tickets.get(token);
      if (!ticket || ticket.digest !== digest || ticket.request.deviceId !== targetDeviceId) {
        throw new SessionAdmissionError('NOT_AUTHORIZED', 'Session invocation expired');
      }
      ticket.owner.assertCurrent();
    },
    async issue(request: SessionControlRequest, owner: RemoteSessionTicketOwner) {
      owner.assertCurrent();
      await owner.authorizeRemote(request);
      owner.assertCurrent();
      const token = randomUUID();
      const digest = sessionIntentFingerprint(request);
      tickets.set(token, { digest, request, owner });
      return { token, digest, release: () => { tickets.delete(token); } };
    },
    async attest(targetDeviceId: string, token: string, digest: string): Promise<RemoteSessionPrincipal> {
      const ticket = tickets.get(token);
      if (!ticket || ticket.digest !== digest || ticket.request.deviceId !== targetDeviceId) {
        throw new SessionAdmissionError('NOT_AUTHORIZED', 'Session invocation is no longer authorized');
      }
      ticket.owner.assertCurrent();
      const principal = await ticket.owner.authorizeRemote(ticket.request);
      ticket.owner.assertCurrent();
      if (tickets.get(token) !== ticket) throw new SessionAdmissionError('NOT_AUTHORIZED', 'Session invocation expired');
      return principal;
    },
  };
}

export const remoteSessionTickets = createRemoteSessionTickets();
