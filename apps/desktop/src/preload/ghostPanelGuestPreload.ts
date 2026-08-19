import { contextBridge, ipcRenderer } from 'electron';

import {
  GHOST_PANEL_AGENT_SEND_CHANNEL,
  GHOST_PANEL_AGENT_TARGET_CHANNEL,
  type GhostPanelAgentSendRequest,
  type GhostPanelAgentSendResult,
  type GhostPanelAgentTargetResult,
} from '../shared/ghostPanelAgent.js';

/**
 * 插件面板 Guest 的最小桥。
 *
 * 与逻辑页的完整 `ghostPreload` 分离：面板只可查询当前是否有发送目标，并在
 * 一次真实、短暂、尚未消费的用户操作中请求 Host 确认发送普通用户消息。
 */
const ACTIVATION_TTL_MS = 1_000;
let activationExpiresAt = 0;

function armUserActivation(event: Event): void {
  if (!event.isTrusted || navigator.userActivation?.isActive !== true) return;
  activationExpiresAt = performance.now() + ACTIVATION_TTL_MS;
}

function consumeUserActivation(): boolean {
  const active =
    activationExpiresAt > 0 &&
    performance.now() <= activationExpiresAt &&
    navigator.userActivation?.isActive === true;
  activationExpiresAt = 0;
  return active;
}

window.addEventListener('pointerup', armUserActivation, { capture: true });
window.addEventListener('keydown', armUserActivation, { capture: true });

contextBridge.exposeInMainWorld('cindyPanel', {
  agent: {
    getTarget: (): Promise<GhostPanelAgentTargetResult> =>
      ipcRenderer.invoke(GHOST_PANEL_AGENT_TARGET_CHANNEL),
    send: (request: GhostPanelAgentSendRequest): Promise<GhostPanelAgentSendResult> => {
      if (!consumeUserActivation()) {
        return Promise.resolve({
          ok: false,
          errorCode: 'USER_ACTION_REQUIRED',
          message: '请由用户点击或按键后请求发送',
        });
      }
      return ipcRenderer.invoke(GHOST_PANEL_AGENT_SEND_CHANNEL, request);
    },
  },
});
