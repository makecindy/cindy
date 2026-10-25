

import { getDbClient } from '../localDb/client/current';

import { sessionToCamel } from '../localDb/mapper';

import { getMaker } from '../maker-host/index.js';

import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';


import { createLogger } from '../logger';

import { setLastAssistantTranscriptUuid } from '../messagePersistBroadcaster.js';

import { recomputePrRefsForSession } from '../git-context/prRefsStore.js';

import { isCodexNativeThreadStart, resolveCodexForkEventTimestamp, resolveCodexTurnAnchor } from '@cindy/app-runtime/nativeHistoryBoundaries';

import {
  executeCodexFileRewindPlanWithThreadRollback,
} from '../git-snapshot/codexFileRewindExecutor';

import {
  executeCodexFileRestorePlanWithThreadRollback,
} from '../git-snapshot/codexFileRestoreExecutor';

import {
  chunkPathspecArgs,
  getCurrentBranch,
  getHead,
  listShadowSavepoints,
  listSnapshots,
  listUnprotectedPaths,
  writeWorktreeTreeForPaths,
  type SnapshotEntry,
} from '../git-snapshot/gitSnapshotService';

import { detectCwd } from '../worktree/WorktreeManager.js';

import { gitExec } from '../worktree/gitExec';
import {createSessionRewind} from '@cindy/app-runtime/sessionRewind';
export type * from '@cindy/app-runtime/sessionRewind';

export const {previewRewindAtMessage,commitRewindAtMessage}=createSessionRewind({getDbClient,sessionToCamel,getMaker,readGitSafetySettings,createLogger,setLastAssistantTranscriptUuid,recomputePrRefsForSession,isCodexNativeThreadStart,resolveCodexForkEventTimestamp,resolveCodexTurnAnchor,executeCodexFileRewindPlanWithThreadRollback,executeCodexFileRestorePlanWithThreadRollback,chunkPathspecArgs,getCurrentBranch,getHead,listShadowSavepoints,listSnapshots,listUnprotectedPaths,writeWorktreeTreeForPaths,detectCwd,gitExec});
