import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getBotRemoteSettingsSource } from '../localDb/ipc/bots.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { listProjectAliases } from '../localDb/ipc/projectAliases.js';
import { loadSidebarSettingsSnapshot } from '../sidebarSettingsStore.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import { extractDisplayName } from '../../shared/projectDisplayName.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import type { BotLinkedProject, BotProjectOption } from '../../shared/botWorkbench.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { linkedProjectDirectoryKey, readBotLinkedProjects, setBotLinkedProject } from './botWorkbenchService.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import { withBotProfileLocks } from './botProfileLock.js';

import {createBotLinkedProjects} from '@cindy/app-runtime/botLinkedProjects';
export const {botLinkedProjectAccess}=createBotLinkedProjects({activeOwnerScopeKey:(...args)=>activeOwnerScopeKey(...args),isAppSessionBoundaryPending:(...args)=>isAppSessionBoundaryPending(...args),ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),getBotRemoteSettingsSource:(...args)=>getBotRemoteSettingsSource(...args),listRecentWorkdirs:(...args)=>listRecentWorkdirs(...args),listProjectAliases:(...args)=>listProjectAliases(...args),loadSidebarSettingsSnapshot:(...args)=>loadSidebarSettingsSnapshot(...args),linkedProjectDirectoryKey:(...args)=>linkedProjectDirectoryKey(...args),readBotLinkedProjects:(...args)=>readBotLinkedProjects(...args),setBotLinkedProject:(...args)=>setBotLinkedProject(...args),broadcastBotRemoteResourceChanged:(...args)=>broadcastBotRemoteResourceChanged(...args),withBotProfileLocks:(...args)=>withBotProfileLocks(...args)});
