import {
  REMOTE_DESKTOP_ICE_CONFIG_PATH,
  REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
  resolveDesktopIceServers,
} from '@cindy/device-link';
import { deviceLinkApiFetch } from '../device-link/deviceLinkApi.desktop.js';

export function loadDesktopIceServers() {
  return resolveDesktopIceServers(() =>
    // 未启用媒体中继的旧部署返回 404，由共享解析器保留原有 STUN。
    deviceLinkApiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
      timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
      cache: 'no-store',
      redactErrorDetails: true,
    }),
  );
}
