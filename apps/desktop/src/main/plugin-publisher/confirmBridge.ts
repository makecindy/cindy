/**
 * Member-publish confirm bridge. Main pauses until the originating window
 * answers. Payload is anti-footgun only: org / ghostId / version / size.
 * Never includes paths, URLs, or review-policy guesses.
 */
import { randomUUID } from 'node:crypto';

import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import type { PluginPublisherConfirmFacts } from './types.js';

export interface PluginPublisherConfirmRequest {
  requestId: string;
  ownerStamp: DataOwnerPushStamp;
  facts: PluginPublisherConfirmFacts;
}

interface PendingConfirm {
  requesterId: number;
  resolve: (confirmed: boolean) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class PluginPublisherConfirmBridge {
  private readonly pending = new Map<string, PendingConfirm>();

  request(
    requesterId: number,
    facts: PluginPublisherConfirmFacts,
    ownerStamp: DataOwnerPushStamp,
    send: (request: PluginPublisherConfirmRequest) => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => this.settle(requestId, false);
      this.pending.set(requestId, { requesterId, resolve, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      let delivered = false;
      try {
        delivered = send({ requestId, ownerStamp, facts });
      } finally {
        if (!delivered) this.settle(requestId, false);
      }
    });
  }

  resolve(requesterId: number, requestId: string, confirmed: unknown): boolean {
    const pending = this.pending.get(requestId);
    // requesterId 0 = broadcast confirm (agent path); any trusted window may answer.
    if (!pending || (pending.requesterId !== 0 && pending.requesterId !== requesterId)) {
      return false;
    }
    this.settle(requestId, confirmed === true);
    return true;
  }

  cancelRequester(requesterId: number): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.requesterId === requesterId) this.settle(requestId, false);
    }
  }

  /** Drop every pending confirm, including broadcast (requesterId 0) agent confirms. */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, false);
  }

  private settle(requestId: string, confirmed: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.resolve(confirmed);
  }
}
