import { net } from 'electron';
import * as authManager from '../authManager.js';
import { isAppSessionBoundaryPending, peekCommittedAppSession } from '../appSessionState.js';
import { getClientEndpointForRealm } from '../clientEndpointsService.js';
import { getInstanceConfig } from '../instance-runtime/config.js';
import { readHostSettings, onHostSettingsChanged } from './index.js';
import { projectSettingsSnapshot } from './snapshotProjection.js';
import { readSettingsSnapshotV2 } from './readSnapshot.js';
import { getSettingsPublicIdentifiers } from './publicIdentifiers.js';
import { createSettingsSnapshotPublisher, settingsSnapshotPublishUrl, type SnapshotPublishContext } from './snapshotPublisher.js';

/** 只读取已提交身份和现成 AT；未就绪、旧协议或未配置端点时不上报。 */
export function getCloudSettingsSnapshotContext(): SnapshotPublishContext | null {
  const instance = getInstanceConfig();
  if (!instance || instance.authProtocol !== 'resource-v1' || isAppSessionBoundaryPending()) return null;
  const owner = peekCommittedAppSession();
  if (!owner || owner.mode !== 'cloud' || owner.dataOwnerId !== instance.membershipId
    || authManager.getCurrentUserId() !== instance.membershipId
    || authManager.getDeviceId() !== instance.deviceId) return null;
  const token = authManager.getAccessToken();
  if (!token) return null;
  const realm = authManager.getActiveAuthRealm();
  let baseUrl: string;
  try { baseUrl = getClientEndpointForRealm(realm, 'cloudInstanceApiBaseUrl'); }
  catch { return null; }
  if (!settingsSnapshotPublishUrl(baseUrl)) return null;
  return {
    scopeKey: JSON.stringify([owner.dataOwnerId, owner.generation, realm, instance.deviceId]),
    baseUrl, accessToken: token,
  };
}

export function startCloudSettingsSnapshotPublisher(): () => void {
  // 普通桌面和旧实例没有后台采样、计时器或订阅；不会尝试推导 CIS 地址。
  if (getInstanceConfig()?.authProtocol !== 'resource-v1') return () => {};
  const publisher = createSettingsSnapshotPublisher({
    getContext: getCloudSettingsSnapshotContext,
    readDomains() {
      const owner = peekCommittedAppSession();
      const snapshot = readHostSettings();
      if (!owner || !snapshot.ownerStamp || isAppSessionBoundaryPending()
        || snapshot.ownerStamp.dataOwnerId !== owner.dataOwnerId
        || snapshot.ownerStamp.ownerGeneration !== owner.generation) {
        throw new Error('SETTINGS_OWNER_CHANGED');
      }
      return projectSettingsSnapshot(snapshot, getSettingsPublicIdentifiers());
    },
    readV2: readSettingsSnapshotV2,
    fetch: (url, init) => net.fetch(url, init),
  });
  const stopAuth = authManager.onAuthStateChange(() => publisher.requestPublish());
  const stopSettings = onHostSettingsChanged(() => publisher.requestPublish());
  publisher.start();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    publisher.stop();
    stopAuth();
    stopSettings();
  };
}
