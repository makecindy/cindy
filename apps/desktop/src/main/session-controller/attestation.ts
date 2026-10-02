import { randomUUID } from 'node:crypto';
import type { RemoteSessionPrincipal } from './remoteTickets.js';
import { SessionAdmissionError } from './controller.js';

export const SESSION_ATTEST_CHANNEL = 'maker:session-control:attest:v1';
export type SessionAttestationFrame =
  | { kind: 'challenge'; challenge: string; token: string; digest: string }
  | { kind: 'answer'; challenge: string; principal: RemoteSessionPrincipal | null };

/** A challenge is part of an already admitted invoke, never a control grant.
 * Both directions use the existing authenticated return-frame lane. This works
 * when only the target allows control, without a second link-open or server change. */
export function createSessionAttestations(timeoutMs = 10_000) {
  const pending = new Map<string, { peer: string; settle(value: RemoteSessionPrincipal | null): void }>();
  return {
    async request(peer: string, token: string, digest: string, send: (frame: SessionAttestationFrame) => void): Promise<RemoteSessionPrincipal> {
      const challenge = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<RemoteSessionPrincipal>((resolve, reject) => {
          pending.set(challenge, { peer, settle: principal => principal ? resolve(principal)
            : reject(new SessionAdmissionError('NOT_AUTHORIZED', '来源设备未能确认本次调用权限。')) });
          timer = setTimeout(() => reject(new SessionAdmissionError('NOT_AUTHORIZED', '调用权限确认已超时。')), timeoutMs);
          timer.unref?.();
          send({ kind: 'challenge', challenge, token, digest });
        });
      } finally { if (timer) clearTimeout(timer); pending.delete(challenge); }
    },
    answer(peer: string, value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const frame = value as Partial<Extract<SessionAttestationFrame, { kind: 'answer' }>>;
      if (frame.kind !== 'answer' || typeof frame.challenge !== 'string') return;
      const entry = pending.get(frame.challenge);
      if (!entry || entry.peer !== peer) return;
      const p = frame.principal;
      if (p !== null && (!p || typeof p.callerKey !== 'string' || typeof p.sourceSessionId !== 'string'
        || !['owner-turn', 'ordinary-session'].includes(p.authority))) return;
      pending.delete(frame.challenge);
      entry.settle(p);
    },
  };
}

export const sessionAttestations = createSessionAttestations();
