/**
 * Desktop host wiring for member plugin publishing.
 *
 * Identity is the current org membership. Audience is Host-minted
 * `<orgSlug>:cindy-publisher` and never goes through the plugin resolver.
 */
import type { WebContents } from 'electron';

import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { getAuthState, onAuthStateChange } from '../authManager.js';
import {
  getConnectionTokenProvider,
  getGhostManager,
  sendToTrustedAppWindows,
} from '../cindy-brain/index.js';
import { isReservedConnectionPluginSlug } from '../cindy-brain/connectionAudienceResolver.js';
import { createLogger } from '../logger.js';
import { onQuit } from '../lifecycle.js';
import { PluginPublisherApi } from './api.js';
import { PluginPublisherConfirmBridge } from './confirmBridge.js';
import {
  createPluginPublisherOrchestrator,
  PluginPublisherOrchestrator,
  type PluginPublisherSourceBinding,
} from './orchestrator.js';
import { PLUGIN_MEMBER_PUBLISHER_GHOST_ID, type PluginPublisherProgress } from './types.js';

const log = createLogger('plugin-publisher');
const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PLUGIN_PUBLISHER_PROGRESS_CHANNEL = 'plugin-publisher:progress';
export const PLUGIN_PUBLISHER_CONFIRM_CHANNEL = 'plugin-publisher:confirm';

const confirmBridge = new PluginPublisherConfirmBridge();
const trackedConfirmRequesters = new WeakSet<WebContents>();
let orchestratorSingleton: PluginPublisherOrchestrator | null = null;
let quitHooked = false;
let authHooked = false;

export function getPluginPublisherConfirmBridge(): PluginPublisherConfirmBridge {
  return confirmBridge;
}

export function currentPublisherIdentity(): {
  membershipId: string;
  orgSlug: string;
  orgName: string | null;
} | null {
  const state = getAuthState();
  const user = state.isAuthenticated ? state.user : null;
  if (!user || user.membershipKind !== 'org') return null;
  if (!user.orgSlug || !ORG_SLUG_RE.test(user.orgSlug)) return null;
  return {
    membershipId: user.id,
    orgSlug: user.orgSlug,
    orgName: user.orgName,
  };
}

export function publisherAudience(orgSlug: string): string {
  return `${orgSlug}:${PLUGIN_MEMBER_PUBLISHER_GHOST_ID}`;
}

function createApi(): PluginPublisherApi {
  return new PluginPublisherApi({
    async getToken() {
      const identity = currentPublisherIdentity();
      if (!identity) throw new Error('需要组织身份才能发布插件');
      return getConnectionTokenProvider().getToken({
        membershipId: identity.membershipId,
        audience: publisherAudience(identity.orgSlug),
      });
    },
    invalidateToken() {
      const identity = currentPublisherIdentity();
      if (!identity) return;
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
      api: createApi(),
      identity: currentPublisherIdentity,
      async inspectPackage(filePath) {
        const inspected = await getGhostManager().inspect(filePath);
        if ('rejection' in inspected) {
          log.warn('plugin publish inspect rejected', { code: inspected.rejection.code });
          throw new Error('插件包无法发布');
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
      confirm(facts, signal) {
        const ownerStamp = getActiveDataOwnerPushStamp();
        return confirmBridge.request(
          0,
          facts,
          ownerStamp,
          (request) => {
            return sendToTrustedAppWindows(PLUGIN_PUBLISHER_CONFIRM_CHANNEL, request) > 0;
          },
          signal,
        );
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
      let lastKey = publisherIdentityKey();
      onAuthStateChange(() => {
        const nextKey = publisherIdentityKey();
        if (nextKey === lastKey) return;
        lastKey = nextKey;
        orchestratorSingleton?.abortAll();
        confirmBridge.cancelAll();
      });
    }
  }
  return orchestratorSingleton;
}

function publisherIdentityKey(): string {
  const identity = currentPublisherIdentity();
  return identity ? `${identity.membershipId}:${identity.orgSlug}` : '';
}

export function startPluginPublish(
  filePath: string,
  requester: WebContents | null = null,
  sourceBinding?: PluginPublisherSourceBinding,
) {
  const identity = currentPublisherIdentity();
  if (!identity) {
    throw new Error('需要组织身份才能发布插件');
  }
  log.info('plugin publish started');
  return getPluginPublisherOrchestrator().start(filePath, {
    ...(sourceBinding ? { sourceBinding } : {}),
    confirm: (facts, signal) => {
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
      );
    },
  });
}
