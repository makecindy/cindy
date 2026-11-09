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
import { t } from '../i18n.js';
import { openGithubSignIn, readGithubConnection } from '../git-context/githubSetupIpc.js';
import { createGhostGateway } from './ghost.js';
export type { GhostGrantLiveSessionState, ToolResultImageDescription, CindyGhostsHostDeps } from './ghost.js';

const gateway = createGhostGateway({
  publishPluginAppResult,
  pluginModelResult,
  community,
  contributionOwnerKey,
  assertContributionOwner,
  getPreparedContribution,
  createPluginMarketAgentTools,
  createTaskInstallConsentPrompt,
  getBotAuthorizationService,
  isBotAuthorizationSession,
  publishImage,
  getSessionFsSnapshot,
  getGhostCardService,
  getGhostManager,
  listInstalledGhostsAsync,
  getGhostPipeDispatcher,
  getGhostSetupAssessment,
  ghostForgeForbiddenRootDirs,
  captureGhostMutationOwnerForMcp,
  acquireGhostMutationLeaseForMcp,
  installOrUpdateLocalGhostPackageFromForge,
  isGhostAvailableForActiveSession,
  getGhostHandoffStore,
  writeForgeScaffoldWithStableParent,
  currentPublisherIdentity,
  getPluginPublisherOrchestrator,
  startPluginPublish,
  blobStore,
  commitMessageMediaRefs: (...args) => commitMessageMediaRefs(...args),
  callCindyMedia,
  resolveGhostAttachmentUrl,
  forkForgeIconConversionHost,
  t,
  openGithubSignIn,
  readGithubConnection
});
export const { authorizeDesktopSessionPath, buildToolResultImageDescriptions, collectCindyMediaUrls, setPageControlGhostProvider, getGhostRosterPrompt, getCindyGhostsMcpDeps } = gateway;
