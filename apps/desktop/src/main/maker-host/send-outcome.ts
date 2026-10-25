import { HOST_SEND_FAILURE_CODES, type HostSendFailureCode, type HostSendOutcome, type DesktopSessionDispatchSuccess, type DesktopSessionDispatchFailure, type DesktopSessionDispatchOutcome, type DesktopSendOutcome, type DesktopMakerSendResult, type SendOutcomeLogContext, type SanitizedSendOutcomeError, createHostSendFailure, toDesktopSessionDispatchOutcome, toCompatibleMakerSendResult, sanitizeSendOutcomeError, assertDesktopSendDispatched } from '@cindy/im-runtime/sendOutcome';
export { HOST_SEND_FAILURE_CODES, type HostSendFailureCode, type HostSendOutcome, type DesktopSessionDispatchSuccess, type DesktopSessionDispatchFailure, type DesktopSessionDispatchOutcome, type DesktopSendOutcome, type DesktopMakerSendResult, type SendOutcomeLogContext, type SanitizedSendOutcomeError, createHostSendFailure, toDesktopSessionDispatchOutcome, toCompatibleMakerSendResult, sanitizeSendOutcomeError, assertDesktopSendDispatched } from '@cindy/im-runtime/sendOutcome';
import type { SessionSendResult } from '@cindy/maker-core';
import {
  assertSendDispatched,
  toSessionDispatchOutcome,
  type SessionDispatchOutcome,
} from '@cindy/maker-core';

import { createLogger } from '../logger.js';

const log = createLogger('maker-send-outcome');

export function observeFireAndForgetSendOutcome(
  promise: Promise<SessionSendResult>,
  meta: SendOutcomeLogContext,
): void {
  promise
    .then((result) => {
      const outcome = toDesktopSessionDispatchOutcome(result, {
        source: 'fire-and-forget',
        context: meta.context,
      });
      if (!outcome.dispatched) {
        log.warn('fire-and-forget send not dispatched', {
          kind: outcome.kind,
          source: outcome.source,
          owner: meta.owner,
          entrypoint: meta.entrypoint,
          sessionId: meta.sessionId,
          agentKind: meta.agentKind,
          action: meta.action,
          reason: outcome.reason,
          context: outcome.context,
        });
      }
    })
    .catch((err) => {
      log.warn('fire-and-forget send failed', {
        kind: 'session-dispatch',
        source: 'fire-and-forget',
        owner: meta.owner,
        entrypoint: meta.entrypoint,
        sessionId: meta.sessionId,
        agentKind: meta.agentKind,
        action: meta.action,
        context: meta.context,
        error: sanitizeSendOutcomeError(err),
      });
    });
}
