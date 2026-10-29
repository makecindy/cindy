import {
  REMOTE_DESKTOP_ICE_CONFIG_PATH,
  REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
  resolveDesktopIceServers,
} from '@cindy/device-link';
import { deviceLinkApiFetch } from '../device-link/deviceLinkApi.js';

export function loadDesktopIceServers() {
  return resolveDesktopIceServers(() =>
    // 自建中转不提供 TURN(返回 404),按既有逻辑退回公共 STUN。
    deviceLinkApiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
      timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
      cache: 'no-store',
      redactErrorDetails: true,
    }),
  );
}
