import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { listMessagesForAgentHandoff } from '../localDb/ipc/messages.js';
import { getMaker, withRehydrateCloseSuppressed } from '../maker-host/index.js';
import { resolveDesktopHandoffWindow } from '../maker-host/model-context-settings.js';
import { setLastAssistantTranscriptUuid } from '../messagePersistBroadcaster.desktop.js';
import { createRewindOrchestrator, type RewindCommitOptions, type RewindErrorCode } from './rewindCore.js';

export type { RewindCommitOptions, RewindErrorCode };

const desktopRewind = createRewindOrchestrator({
  getMaker: () => getMaker(),
  withRehydrateCloseSuppressed: (sessionId, fn) => withRehydrateCloseSuppressed(sessionId, fn),
  resolveHandoffWindow: (sessionId, route) => resolveDesktopHandoffWindow(sessionId, route),
  listMessagesForAgentHandoff: (...args) => listMessagesForAgentHandoff(...args),
  setLastAssistantTranscriptUuid: (sessionId, uuid) => setLastAssistantTranscriptUuid(sessionId, uuid),
  broadcastMessagesDeleted: (payload, ownerScope) =>
    tapWindowBroadcast('local-db:messages:deleted', payload, ownerScope.ownerStamp),
});

export const previewRewindAtMessage = desktopRewind.previewRewindAtMessage;
export const commitRewindAtMessage = desktopRewind.commitRewindAtMessage;
