/**
 * Whether one `DeviceLinkContext.invoke` call wrote its request, decided once for the whole call (dispatcher N-1, O-3).
 *
 * A failed call ends in exactly one of two reports, each at most once:
 * - `onRequestWritten`: a transport says it wrote this request (Device Link at its first socket write of it, Agent-Net once
 *   a session took it, the direct path once tried), or may have;
 * - `onNotSent`: the call failed, no receipt came, and no transport still holds the request. That covers every exit before a
 *   transport got the request (the computer unavailable, a caller's check, no client, the send slot, the relay or link
 *   never ready, link recovery, the history capability, the read queue) and a transport that settled without writing it:
 *   both transports give the receipt only from their own write and never after the call settles, so a transport call that
 *   ended without one is its own evidence the request never left.
 * A call still held by a transport when it failed (none today: every wrapper awaits its transport) reports neither, and its
 * caller treats it as possibly written. A call that succeeded may report neither (an answer read from a cache).
 *
 * Callers that pass neither callback get no receipt wrapper, so the transport sees exactly the options it saw before.
 */
export interface InvokeSendEvidence {
  /** Passed to the transports; undefined when the caller asked for neither report. */
  readonly onRequestWritten: (() => void) | undefined;
  /** Runs one transport call, counting it as holding this request until it settles. */
  viaTransport<R>(run: () => Promise<R>): Promise<R>;
  /** The call failed: report `onNotSent` if nothing says it was written and no transport still holds it. */
  failed(): void;
}

export function invokeSendEvidence(opts?: { onRequestWritten?: () => void; onNotSent?: () => void }): InvokeSendEvidence {
  let reported: 'written' | 'not-sent' | null = null;
  let holding = 0;
  const report = (kind: 'written' | 'not-sent') => {
    if (reported) return;
    reported = kind;
    if (kind === 'written') opts?.onRequestWritten?.();
    else opts?.onNotSent?.();
  };
  return {
    onRequestWritten: opts?.onRequestWritten || opts?.onNotSent ? () => report('written') : undefined,
    async viaTransport<R>(run: () => Promise<R>) {
      holding += 1;
      try { return await run(); } finally { holding -= 1; }
    },
    failed() { if (holding === 0) report('not-sent'); },
  };
}
