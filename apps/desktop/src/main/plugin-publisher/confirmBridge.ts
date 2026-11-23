/**
 * Member-publish confirm bridge. Main pauses until the originating window
 * answers. Payload is anti-footgun only: org / ghostId / version / size, plus
 * what the screen may do with the visibility audience. Never includes paths,
 * URLs, or review-policy guesses.
 */
import { randomUUID } from 'node:crypto';

import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import type { AuthorVisibilityAudience } from '../../shared/pluginAuthor.js';
import type {
  PluginPublisherConfirmDecision,
  PublisherAudienceContext,
} from '../../shared/pluginPublisher.js';
import type { PluginPublisherConfirmFacts } from './types.js';

export interface PluginPublisherConfirmRequest {
  requestId: string;
  ownerStamp: DataOwnerPushStamp;
  facts: PluginPublisherConfirmFacts;
  audience: PublisherAudienceContext;
}

interface PendingConfirm {
  requesterId: number;
  audience: PublisherAudienceContext;
  resolve: (decision: PluginPublisherConfirmDecision) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const UNSUPPORTED: PublisherAudienceContext = { kind: 'unsupported' };

export class PluginPublisherConfirmBridge {
  private readonly pending = new Map<string, PendingConfirm>();

  request(
    requesterId: number,
    facts: PluginPublisherConfirmFacts,
    ownerStamp: DataOwnerPushStamp,
    send: (request: PluginPublisherConfirmRequest) => boolean,
    signal?: AbortSignal,
    audience: PublisherAudienceContext = UNSUPPORTED,
  ): Promise<PluginPublisherConfirmDecision> {
    if (signal?.aborted) return Promise.resolve({ confirmed: false });
    const requestId = randomUUID();
    return new Promise<PluginPublisherConfirmDecision>((resolve) => {
      const onAbort = (): void => this.settle(requestId, { confirmed: false });
      this.pending.set(requestId, { requesterId, audience, resolve, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      let delivered = false;
      try {
        delivered = send({ requestId, ownerStamp, facts, audience });
      } finally {
        if (!delivered) this.settle(requestId, { confirmed: false });
      }
    });
  }

  /**
   * The chosen audience is kept only when the screen was allowed to edit it; a window cannot
   * attach an audience to a publish whose current audience must be left untouched.
   */
  resolve(
    requesterId: number,
    requestId: string,
    confirmed: unknown,
    visibilityAudience?: AuthorVisibilityAudience,
  ): boolean {
    const pending = this.pending.get(requestId);
    // requesterId 0 = broadcast confirm (agent path); any trusted window may answer.
    if (!pending || (pending.requesterId !== 0 && pending.requesterId !== requesterId)) {
      return false;
    }
    const accepted = confirmed === true;
    this.settle(requestId, {
      confirmed: accepted,
      ...(accepted && pending.audience.kind === 'editable' && visibilityAudience
        ? { visibilityAudience }
        : {}),
    });
    return true;
  }

  cancelRequester(requesterId: number): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.requesterId === requesterId) this.settle(requestId, { confirmed: false });
    }
  }

  /** Drop every pending confirm, including broadcast (requesterId 0) agent confirms. */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, { confirmed: false });
  }

  private settle(requestId: string, decision: PluginPublisherConfirmDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.resolve(decision);
  }
}
