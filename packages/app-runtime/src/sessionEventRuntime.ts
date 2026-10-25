import { createSessionEventPreparation, type SessionEventPreparationHost } from './sessionEventPreparation.js';
import { createSessionStreamPersistence, type SessionStreamHost } from './sessionEventStream.js';
import { createSessionEventDelivery, type SessionEventDeliveryHost } from './sessionEventDelivery.js';
import { createSessionEventTerminal, type SessionEventTerminalHost } from './sessionEventTerminal.js';
import { createSessionEventSnapshots, type SessionEventSnapshotsHost } from './sessionEventSnapshots.js';
import { createSessionClaudeTurnUsage } from './sessionClaudeTurnUsage.js';
import { createSessionCodexTurnUsage } from './sessionCodexTurnUsage.js';
import { createSessionPiTurnUsage } from './sessionPiTurnUsage.js';
import { createTurnUsageContext, type TurnUsageContextHost } from './turnUsageContext.js';
import { createBotLearningTracker } from './botLearningTracker.js';
import { createBotLearningFeedback, type BotLearningFeedbackHost } from './botLearningFeedback.js';
import { createSessionEventPipeline } from './sessionEventPipeline.js';
import type { SessionTurnUsageHost } from './sessionTurnUsageHost.js';
import type { createScheduledOutputProjection } from './silent-output.js';

export type SessionEventRuntimeHost =
  Omit<SessionEventPreparationHost, 'captureTurnUsageContext' | 'isQuietScheduledOutput'> &
  SessionEventDeliveryHost &
  Omit<SessionEventTerminalHost, 'botLearningTracker' | 'learningTurnIdentity'> &
  SessionEventSnapshotsHost & TurnUsageContextHost &
  Omit<SessionTurnUsageHost, 'captureTurnUsageContext'> &
  Omit<BotLearningFeedbackHost, 'botLearningTracker'> & {
    stream: SessionStreamHost;
    scheduledOutput: ReturnType<typeof createScheduledOutputProjection>;
  };

/** One application owner, one original event pipeline for local and remote inputs. */
export function createSessionEventRuntime(host: SessionEventRuntimeHost) {
  const context = createTurnUsageContext(host);
  const botLearningTracker = createBotLearningTracker();
  const learning = createBotLearningFeedback({ ...host, botLearningTracker });
  const preparation = createSessionEventPreparation({ ...host, ...context,
    isQuietScheduledOutput: host.scheduledOutput.isQuietScheduledOutput });
  const stream = createSessionStreamPersistence(host.stream);
  const delivery = createSessionEventDelivery(host);
  const terminal = createSessionEventTerminal({ ...host, botLearningTracker, ...learning });
  const snapshots = createSessionEventSnapshots(host);
  // Preserve the live region binding, as with Desktop's module binding.
  const usageHost = { ...host, ...context, get CURRENT_CINDY_REGION() { return host.CURRENT_CINDY_REGION; } };
  const claude = createSessionClaudeTurnUsage(usageHost);
  const codex = createSessionCodexTurnUsage(usageHost);
  const pi = createSessionPiTurnUsage(usageHost);
  const pipeline = createSessionEventPipeline({ ...preparation, ...stream, ...delivery,
    ...terminal, ...snapshots, ...claude, ...codex, ...pi, ...learning,
    projectQuietScheduledOutput: host.scheduledOutput.projectQuietScheduledOutput });
  return { ...pipeline, botLearningTracker, context };
}
