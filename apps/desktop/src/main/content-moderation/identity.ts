import { app } from 'electron';
import {
  getAccessToken,
  getAuthIdentityEpoch,
  getAuthState,
} from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  resolveModerationIdentity,
  type ModerationIdentity,
} from './eligibility.js';

function commandLineModerationEnabled(): boolean {
  return process.argv.includes('--content-moderation')
    || (!app.isPackaged && process.env.XDT_CONTENT_MODERATION === '1');
}

export function getModerationIdentity(): ModerationIdentity | null {
  try {
    const auth = getAuthState();
    return resolveModerationIdentity({
      isPackaged: app.isPackaged,
      region: CURRENT_CINDY_REGION,
      commandLineEnabled: commandLineModerationEnabled(),
      membershipKind: auth.user?.membershipKind ?? null,
      membershipId: auth.user?.id ?? null,
      accessToken: getAccessToken(),
      identityEpoch: getAuthIdentityEpoch(),
      productionSignBaseUrl: getClientEndpoint('moderationSignApiBaseUrl'),
      testSignBaseUrl: getClientEndpoint('moderationSignTestApiBaseUrl'),
    });
  } catch {
    // 启动早期或测试环境 endpoint 尚未初始化时按无审核资格处理，保持 fail-open。
    return null;
  }
}

export function isModerationIdentityCurrent(identity: ModerationIdentity): boolean {
  const current = getModerationIdentity();
  return Boolean(
    current
    && current.membershipId === identity.membershipId
    && current.identityEpoch === identity.identityEpoch
    && current.environment === identity.environment,
  );
}
