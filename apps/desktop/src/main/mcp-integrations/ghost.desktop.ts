/** Desktop platform services for the shared plugin gateway. */
import { publishPluginAppResult, pluginModelResult } from '../mcp-apps/pluginCards.js';
import * as community from '../plugin-contributions/host.js';
import { contributionOwnerKey, assertContributionOwner, getPreparedContribution } from '../plugin-contributions/prepared.js';
import { createPluginMarketAgentTools } from '../plugin-market/agentTools.js';
import { createTaskInstallConsentPrompt } from '../cindy-brain/ghostInstallConsentInteraction.js';
import { getBotAuthorizationService } from '../maker-ipc/botAuthorizationService.js';
import { isBotAuthorizationSession } from '../maker-ipc/botAuthorizationHost.js';
import { publishImage } from '../cindy-media/publishImage.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { getGhostCardService, getGhostManager, listInstalledGhostsAsync, getGhostPipeDispatcher, getGhostSetupAssessment, ghostForgeForbiddenRootDirs, captureGhostMutationOwnerForMcp, acquireGhostMutationLeaseForMcp, installOrUpdateLocalGhostPackageFromForge, isGhostAvailableForActiveSession, getGhostHandoffStore } from '../cindy-brain/index.js';
import { writeForgeScaffoldWithStableParent } from '../cindy-brain/forgeScaffoldCapability.js';
import { currentPublisherIdentity, getPluginPublisherOrchestrator, startPluginPublish } from '../plugin-publisher/host.js';
import * as blobStore from '../cindy-media/blobStore.desktop.js';
import { commitMessageMediaRefs } from '../cindy-media/chatAttachments.js';
import { callCindyMedia } from '../cindy-media/invocationService.js';
import { resolveGhostAttachmentUrl } from './ghostAttachmentResolve.js';
import { forkForgeIconConversionHost } from './forgeIconConversionHost.js';
import { t } from '../i18n.desktop.js';
import { openGithubSignIn, readGithubConnection } from '../git-context/githubSetupIpc.js';
import { createGhostGateway } from './ghost.js';
export type { GhostGrantLiveSessionState, ToolResultImageDescription, CindyGhostsHostDeps } from './ghost.js';

const gateway = createGhostGateway({
  publishPluginAppResult: (...args) => publishPluginAppResult(...args),
  pluginModelResult: (...args) => pluginModelResult(...args),
  community,
  contributionOwnerKey: (...args) => contributionOwnerKey(...args),
  assertContributionOwner: (...args) => assertContributionOwner(...args),
  getPreparedContribution: (...args) => getPreparedContribution(...args),
  createPluginMarketAgentTools: (...args) => createPluginMarketAgentTools(...args),
  createTaskInstallConsentPrompt: (...args) => createTaskInstallConsentPrompt(...args),
  getBotAuthorizationService: (...args) => getBotAuthorizationService(...args),
  isBotAuthorizationSession: (...args) => isBotAuthorizationSession(...args),
  publishImage: (...args) => publishImage(...args),
  getSessionFsSnapshot: (...args) => getSessionFsSnapshot(...args),
  getGhostCardService: (...args) => getGhostCardService(...args),
  getGhostManager: (...args) => getGhostManager(...args),
  listInstalledGhostsAsync: (...args) => listInstalledGhostsAsync(...args),
  getGhostPipeDispatcher: (...args) => getGhostPipeDispatcher(...args),
  getGhostSetupAssessment: (...args) => getGhostSetupAssessment(...args),
  ghostForgeForbiddenRootDirs: (...args) => ghostForgeForbiddenRootDirs(...args),
  captureGhostMutationOwnerForMcp: (...args) => captureGhostMutationOwnerForMcp(...args),
  acquireGhostMutationLeaseForMcp: (...args) => acquireGhostMutationLeaseForMcp(...args),
  installOrUpdateLocalGhostPackageFromForge: (...args) => installOrUpdateLocalGhostPackageFromForge(...args),
  isGhostAvailableForActiveSession: (...args) => isGhostAvailableForActiveSession(...args),
  getGhostHandoffStore: (...args) => getGhostHandoffStore(...args),
  writeForgeScaffoldWithStableParent: (...args) => writeForgeScaffoldWithStableParent(...args),
  currentPublisherIdentity: (...args) => currentPublisherIdentity(...args),
  getPluginPublisherOrchestrator: (...args) => getPluginPublisherOrchestrator(...args),
  startPluginPublish: (...args) => startPluginPublish(...args),
  blobStore,
  commitMessageMediaRefs: (...args) => commitMessageMediaRefs(...args),
  callCindyMedia: (...args) => callCindyMedia(...args),
  resolveGhostAttachmentUrl: (...args) => resolveGhostAttachmentUrl(...args),
  forkForgeIconConversionHost: (...args) => forkForgeIconConversionHost(...args),
  t: (...args) => t(...args),
  openGithubSignIn: (...args) => openGithubSignIn(...args),
  readGithubConnection: (...args) => readGithubConnection(...args)
});
export const { authorizeDesktopSessionPath, buildToolResultImageDescriptions, collectCindyMediaUrls, setPageControlGhostProvider, getGhostRosterPrompt, getCindyGhostsMcpDeps } = gateway;
