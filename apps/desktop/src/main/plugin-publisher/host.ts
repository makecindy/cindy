/**
 * Desktop host wiring for member plugin publishing.
 *
 * Identity is the current org membership. Audience is Host-minted
 * `<orgSlug>:cindy-publisher` and never goes through the plugin resolver.
 */
import { app, type WebContents } from 'electron';

import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { getAuthState, onAuthStateChange, refresh } from '../authManager.js';
import {
  getConnectionTokenProvider,
  getGhostManager,
  sendToTrustedAppWindows,
} from '../cindy-brain/index.js';
import { isReservedConnectionPluginSlug } from '../cindy-brain/connectionAudienceResolver.js';
import { createLogger } from '../logger.js';
import { onQuit } from '../lifecycle.js';
import { PluginMarketApi } from '../plugin-market/api.js';
import { createPluginAuthorApi } from '../plugin-author/host.js';
import type { PublisherAudienceHint } from '../../shared/pluginPublisher.js';
import { PluginPublisherApi } from './api.js';
import { loadPublisherAudienceContext } from './audienceContext.js';
import type { ContributionInstallationBinding } from '../../shared/pluginContributions.js';
import {
  getPreparedContribution,
  prepareInstalledContribution,
  readContributionInstallation,
  releasePreparedContribution,
} from '../plugin-contributions/prepared.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { PluginPublisherConfirmBridge } from './confirmBridge.js';
import {
  createPluginPublisherOrchestrator,
  PluginPublisherOrchestrator,
  type PluginPublisherSourceBinding,
} from './orchestrator.js';
import { PLUGIN_MEMBER_PUBLISHER_GHOST_ID, type PluginPublisherIdentity, type PluginPublisherProgress } from './types.js';

const log = createLogger('plugin-publisher');
const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PLUGIN_PUBLISHER_PROGRESS_CHANNEL = 'plugin-publisher:progress';
export const PLUGIN_PUBLISHER_CONFIRM_CHANNEL = 'plugin-publisher:confirm';

const confirmBridge = new PluginPublisherConfirmBridge();
const trackedConfirmRequesters = new WeakSet<WebContents>();
let orchestratorSingleton: PluginPublisherOrchestrator | null = null;
let quitHooked = false;
let authHooked = false;
let resolvedMarketIdentity: { contextKey: string; orgSlug: string } | null = null;

export function getPluginPublisherConfirmBridge(): PluginPublisherConfirmBridge {
  return confirmBridge;
}

function publisherIdentityContextKey(): string | null {
  const state = getAuthState();
  const user = state.isAuthenticated ? state.user : null;
  if (!user || user.membershipKind !== 'org' || !user.orgId) return null;
  const owner = getActiveDataOwnerPushStamp();
  return JSON.stringify([user.id, user.orgId, owner.dataOwnerId, owner.ownerGeneration]);
}

export function currentPublisherIdentity(): PluginPublisherIdentity | null {
  const state = getAuthState();
  const user = state.isAuthenticated ? state.user : null;
  if (!user || user.membershipKind !== 'org') return null;
  if (user.orgSlug != null && !ORG_SLUG_RE.test(user.orgSlug)) return null;
  const contextKey = publisherIdentityContextKey();
  const marketOrgSlug = contextKey !== null && resolvedMarketIdentity?.contextKey === contextKey
    ? resolvedMarketIdentity.orgSlug : null;
  return {
    membershipId: user.id,
    orgSlug: user.orgSlug ?? marketOrgSlug,
    orgName: user.orgName,
  };
}

async function resolvePublisherIdentity(): Promise<PluginPublisherIdentity | null> {
  const identity = currentPublisherIdentity();
  if (!identity || identity.orgSlug !== null) return identity;
  const contextKey = publisherIdentityContextKey();
  const organizationId = getAuthState().user?.orgId;
  if (contextKey === null || !organizationId) return identity;
  await refresh();
  if (publisherIdentityContextKey() !== contextKey) return null;
  const refreshed = currentPublisherIdentity();
  if (!refreshed || refreshed.membershipId !== identity.membershipId) return null;
  if (refreshed.orgSlug !== null) return refreshed;
  try {
    const { currentOrganization } = await new PluginMarketApi(undefined, () => app.getVersion()).catalog({ scope: 'public', limit: 1, counts: false });
    if (publisherIdentityContextKey() !== contextKey) return null;
    const current = currentPublisherIdentity();
    if (!current || current.membershipId !== identity.membershipId) return null;
    if (current.orgSlug !== null) return current;
    if (currentOrganization?.organizationId !== organizationId ||
        !currentOrganization.orgSlug || !ORG_SLUG_RE.test(currentOrganization.orgSlug)) return current;
    resolvedMarketIdentity = { contextKey, orgSlug: currentOrganization.orgSlug };
    return { ...current, orgSlug: currentOrganization.orgSlug };
  } catch {
    return publisherIdentityContextKey() === contextKey ? currentPublisherIdentity() : null;
  }
}

export function publisherAudience(orgSlug: string | null): string {
  if (!orgSlug || !ORG_SLUG_RE.test(orgSlug)) throw new Error('无法确认发布组织 namespace，请刷新登录后重试');
  return `${orgSlug}:${PLUGIN_MEMBER_PUBLISHER_GHOST_ID}`;
}

export function createPluginPublisherApi(): PluginPublisherApi {
  return new PluginPublisherApi({
    getClientVersion: () => app.getVersion(),
    async getToken() {
      const identity = await resolvePublisherIdentity();
      if (!identity?.orgSlug) throw new Error('无法确认发布组织身份，请刷新登录后重试');
      return getConnectionTokenProvider().getToken({
        membershipId: identity.membershipId,
        audience: publisherAudience(identity.orgSlug),
      });
    },
    invalidateToken() {
      const identity = currentPublisherIdentity();
      if (!identity?.orgSlug) return;
      getConnectionTokenProvider().invalidate({
        membershipId: identity.membershipId,
        audience: publisherAudience(identity.orgSlug),
      });
    },
  });
}

export function trackPublisherConfirmRequester(contents: WebContents): void {
  if (trackedConfirmRequesters.has(contents)) return;
  trackedConfirmRequesters.add(contents);
  const requesterId = contents.id;
  const cancelPending = (): void => confirmBridge.cancelRequester(requesterId);
  contents.once('destroyed', cancelPending);
  contents.on('render-process-gone', cancelPending);
  contents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) cancelPending();
  });
}

export function getPluginPublisherOrchestrator(): PluginPublisherOrchestrator {
  if (!orchestratorSingleton) {
    orchestratorSingleton = createPluginPublisherOrchestrator({
      api: createPluginPublisherApi(),
      identity: resolvePublisherIdentity,
      async inspectPackage(filePath) {
        const inspected = await getGhostManager().inspect(filePath);
        if ('rejection' in inspected) {
          log.warn('plugin publish inspect rejected', { code: inspected.rejection.code });
          throw new Error(`插件包无法发布：${inspected.rejection.reason}`);
        }
        if (isReservedConnectionPluginSlug(inspected.canonicalManifest.id)) {
          throw new Error('该插件 id 不可发布');
        }
        return {
          ghostId: inspected.canonicalManifest.id,
          name: inspected.canonicalManifest.name,
          version: inspected.canonicalManifest.version,
        };
      },
      confirm(facts, signal, audience) {
        const ownerStamp = getActiveDataOwnerPushStamp();
        return confirmBridge.request(
          0,
          facts,
          ownerStamp,
          (request) => {
            return sendToTrustedAppWindows(PLUGIN_PUBLISHER_CONFIRM_CHANNEL, request) > 0;
          },
          signal,
          audience,
        );
      },
      audienceContext(input, signal) {
        return loadPublisherAudienceContext({
          api: createPluginAuthorApi(),
          async existsInOrganization(ghostId, orgSlug) {
            const response = await new PluginMarketApi(undefined, () => app.getVersion())
              .resolve([{ key: 'publish-target', ghostId, namespace: orgSlug }]);
            return response.results.some((result) => result.status === 'available');
          },
        }, input, signal);
      },
      onProgress(progress: PluginPublisherProgress) {
        sendToTrustedAppWindows(PLUGIN_PUBLISHER_PROGRESS_CHANNEL, progress);
      },
    });
    if (!quitHooked) {
      quitHooked = true;
      onQuit(
        'plugin-publisher',
        () => {
          orchestratorSingleton?.abortAll();
          confirmBridge.cancelAll();
        },
        'sync',
      );
    }
    if (!authHooked) {
      authHooked = true;
      let lastIdentity = currentPublisherIdentity();
      let lastContextKey = publisherIdentityContextKey();
      onAuthStateChange(() => {
        const nextIdentity = currentPublisherIdentity();
        const nextContextKey = publisherIdentityContextKey();
        const contextChanged = nextContextKey !== lastContextKey;
        if (!contextChanged && publisherIdentityKey(nextIdentity) === publisherIdentityKey(lastIdentity)) return;
        const namespaceEnriched = !contextChanged && lastIdentity?.orgSlug === null &&
          nextIdentity?.orgSlug != null && nextIdentity.membershipId === lastIdentity.membershipId;
        lastIdentity = nextIdentity;
        lastContextKey = nextContextKey;
        if (namespaceEnriched) return;
        resolvedMarketIdentity = null;
        orchestratorSingleton?.abortAll();
        confirmBridge.cancelAll();
      });
    }
  }
  return orchestratorSingleton;
}

function publisherIdentityKey(identity: PluginPublisherIdentity | null): string {
  return identity ? `${identity.membershipId}:${identity.orgSlug}` : '';
}

export function startPluginPublish(
  filePath: string,
  requester: WebContents | null = null,
  sourceBinding?: PluginPublisherSourceBinding,
  audienceHint?: PublisherAudienceHint,
) {
  const identity = currentPublisherIdentity();
  if (!identity) {
    throw new Error('需要组织身份才能发布插件');
  }
  log.info('plugin publish started');
  return getPluginPublisherOrchestrator().start(filePath, {
    ...(sourceBinding ? { sourceBinding } : {}),
    ...(audienceHint ? { audienceHint } : {}),
    confirm: (facts, signal, audience) => {
      const ownerStamp = getActiveDataOwnerPushStamp();
      const requesterId = requester && !requester.isDestroyed() ? requester.id : 0;
      if (requester && !requester.isDestroyed()) trackPublisherConfirmRequester(requester);
      return confirmBridge.request(
        requesterId,
        facts,
        ownerStamp,
        (request) => {
          if (requester && !requester.isDestroyed()) {
            requester.send(PLUGIN_PUBLISHER_CONFIRM_CHANNEL, request);
            return true;
          }
          return sendToTrustedAppWindows(PLUGIN_PUBLISHER_CONFIRM_CHANNEL, request) > 0;
        },
        signal,
        audience,
      );
    },
  });
}

/**
 * UI publishing to the organization from an installed local plugin (#1541). The renderer names
 * an installation; Main resolves and snapshots the exact approved installation itself (the same
 * primitive as public contributions) and never accepts a file path from the renderer.
 */
export async function startInstalledPluginPublish(
  instanceId: string,
  expected: ContributionInstallationBinding | undefined,
  requester: WebContents,
) {
  if (!currentPublisherIdentity()) throwIpcError('PERMISSION_DENIED', '需要组织身份才能发布到团队共享');
  const { source } = readContributionInstallation(instanceId, expected);
  if (source.kind !== 'local') {
    throwIpcError('PERMISSION_DENIED', 'Only local plugin installations can be published to the organization');
  }
  const prepared = await prepareInstalledContribution(instanceId, 'manual', expected);
  const entry = getPreparedContribution(prepared.preparedId);
  // The transfer owns these bytes until it terminates.
  entry.pinned = true;
  try {
    return startPluginPublish(entry.filePath, requester, {
      manifestId: prepared.ghostId,
      packageSha256: prepared.sha256,
      onTerminal: () => releasePreparedContribution(prepared.preparedId),
    });
  } catch (error) {
    await releasePreparedContribution(prepared.preparedId);
    throw error;
  }
}
