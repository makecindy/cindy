import { withSendToSessionLock, advanceSessionRewindGeneration } from './sendToSessionLock.js';

/**
 * registerMakerRewindIpc — maker:rewind:preview / maker:rewind:commit
 *
 * Stage 2 C2: 把老 cc-agent:rewind:* 两个 handler 搬到 maker.* 命名空间。
 * 业务函数 (apps/desktop/src/main/maker-orchestration/rewind.ts) 不变, 只是 IPC 入口换源。
 *
 * 错误码透传: SESSION_NOT_FOUND / MESSAGE_NOT_FOUND / NOT_USER_MESSAGE /
 *           NO_PRIOR_ASSISTANT / SESSION_RUNNING / NO_LIVE_QUERY
 */

import { ipcMain } from 'electron';


import { createLogger } from '../logger.js';

import { previewRewindAtMessage, commitRewindAtMessage } from '../maker-orchestration/rewind.js';

import { drainPersistQueue } from '../messagePersistBroadcaster.js';

import { getGoalController } from '../goal-host/index.js';

import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';

import { broadcastSubagentRunsInvalidated } from '../localDb/ipc/subagentRuns.js';

import {
  listVisibleSubagentObservationIdentities,
  type VisibleSubagentObservationIdentity,
} from '../localDb/subagentRuns.js';

import {
  beginSubagentRewindFence,
  finishSubagentRewindFence,
  primeSubagentRewindFence,
  type SubagentRewindFence,
} from '../subagentObservationRewindFence.js';

import { withSessionInputStoppedForRewind } from './register.js';

import { agentHandoffPending } from './agentHandoffPendingSingleton.js';

import { ownerScopedUserDataPath } from '../appSessionState.js';

import { pruneWithdrawnWorkingMemoryForSession } from './botWorkingMemory.js';
import {createSessionRewindIpc} from '@cindy/app-runtime/sessionRewindIpc';
export const {registerMakerRewindIpc}=createSessionRewindIpc<Electron.IpcMainInvokeEvent>({withSendToSessionLock,advanceSessionRewindGeneration,ipcMain,createLogger,previewRewindAtMessage,commitRewindAtMessage,drainPersistQueue,getGoalController,captureDataOwnerBroadcastScope,broadcastSubagentRunsInvalidated,listVisibleSubagentObservationIdentities,beginSubagentRewindFence,finishSubagentRewindFence,primeSubagentRewindFence,withSessionInputStoppedForRewind,agentHandoffPending,ownerScopedUserDataPath,pruneWithdrawnWorkingMemoryForSession});
