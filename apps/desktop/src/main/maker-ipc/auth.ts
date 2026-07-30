/**
 * apps/desktop/src/main/maker-ipc/auth.ts
 *
 * maker:auth:* IPC 的 Electron adapter —— 取代老 codex:auth:* 链路。
 *
 * handler body 在 authHandlers.ts，便于不启动 Electron 直接测试。
 * renderer 调 `electronAPI.maker.auth.*(agentKind)` → IPC → Maker → BaseAgent.deps.auth。
 * 不再需要 vendor 名出现在 IPC 路径上, agentKind 是参数。
 */


import type { Maker } from '@cindy/maker-core';
import { BrowserWindow } from 'electron';
import { createLogger } from '../logger.js';

import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { clearChatgptBridgeCredentialCache } from '../maker-host/anthropic-responses-bridge-host.js';
import { refreshDiscoveredCodexModels } from '../maker-host/createDesktopProviderService.js';
import { requestCodexModelBackfill } from '../maker-host/index.js';
import { registerMakerAuthHandlers } from './authHandlers.js';
import { createElectronIpcHandlerRegistry } from './electronIpcRegistry.js';

const log = createLogger('maker-ipc:auth');

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn(`broadcast to window failed: ${String(e)}`);
    }
  }
}

export function registerMakerAuthIpc(maker: Maker): void {
  log.info('registering maker:auth:* IPC handlers');

  registerMakerAuthHandlers(
    createElectronIpcHandlerRegistry(),
    maker,
    broadcast,
    readClaudeApiKey,
    // codex 登录/登出完成 → 清 bridge 凭证缓存 + 重读 models_cache 刷新 chatgpt/ 发现清单;
    // handler 在 AUTH_STATE_CHANGED 广播前 await,renderer refetch 即见最新目录(设置页
    // triggerLogin 路径不经 finalizeCodexAfterAuthModeChange,必须在这里同样收口)。
    async (authenticated, liveModelsApplied, isCurrent) => {
      if (!isCurrent()) return;
      clearChatgptBridgeCredentialCache();
      // live `model/list` 成功时 active-catalog 已由 CodexAgent callback 原子更新，不能再用
      // 尚未落盘的 models_cache.json 覆盖成空。失败/登出才走磁盘边界收口；cache miss
      // 会明确清空旧账号模型，避免串号。
      if (!authenticated || !liveModelsApplied) {
        if (authenticated) {
          log.warn('Codex live model refresh was not applied; falling back to models_cache');
        }
        await refreshDiscoveredCodexModels(authenticated, isCurrent);
      }
      // 走到这里若仍是「已登录 + 零模型」（live 没 applied 且 models_cache 也 miss，全新机器
      // 首次登录的常态：codex CLI 只在跑过会话后才写 cache），补一次 live 拉取。必须放在上面
      // 的 cache 回退**之后**：那次回退会以空快照收口，先补拉就会被它覆盖掉。
      if (authenticated && isCurrent()) await requestCodexModelBackfill();
    },
  );

  log.info('maker:auth:* IPC handlers registered');
}
