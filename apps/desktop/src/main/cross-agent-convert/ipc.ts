/**
 * cross-agent-convert / IPC
 *
 * Channels:
 *   maker:cross-agent:detect(workingDir, agentKind) → DetectResult
 *   maker:cross-agent:convert(items)               → ConvertSummary（同时 push 进度事件）
 *   maker:cross-agent:step (push)                  → MigrationStepEvent
 *
 * 不再保留 dismiss/cooldown channel —— "同 session+wd 一次性"由 renderer 自管。
 */

import { ipcMain, BrowserWindow } from 'electron';

import { createLogger } from '../logger.js';
import { detect, type DetectInput } from './detector.js';
import { convertAll } from './converter.js';
import type { AgentKind, DetectResult, MigrationItem, MigrationStepEvent } from './types.js';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

const log = createLogger('cross-agent-convert:ipc');

export const CROSS_AGENT_CHANNELS = {
  DETECT: IPC_CHANNELS.MAKER_EXTRA.CROSS_AGENT_DETECT,
  CONVERT: IPC_CHANNELS.MAKER_EXTRA.CROSS_AGENT_CONVERT,
  STEP: IPC_CHANNELS.MAKER_EXTRA.CROSS_AGENT_STEP,
} as const;

function broadcastStep(ev: MigrationStepEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(CROSS_AGENT_CHANNELS.STEP, ev);
    } catch (e) {
      log.warn(`broadcast step failed: ${String(e)}`);
    }
  }
}

export function registerCrossAgentConvertIpc(): void {
  log.info('registering maker:cross-agent:* IPC handlers');

  ipcMain.handle(
    CROSS_AGENT_CHANNELS.DETECT,
    async (_e, workingDir: unknown, agentKind: unknown): Promise<DetectResult> => {
      if (typeof workingDir !== 'string' || !workingDir) return { items: [] };
      if (agentKind !== 'claude-code' && agentKind !== 'codex') return { items: [] };
      return detect({ workingDir, agentKind: agentKind as AgentKind } satisfies DetectInput);
    },
  );

  ipcMain.handle(
    CROSS_AGENT_CHANNELS.CONVERT,
    async (_e, items: unknown) => {
      if (!Array.isArray(items)) {
        throw new Error('[INVALID_ITEMS]');
      }
      // 信任 renderer 传回来的 items（结构由 detector 产出）。converter 内部仍做安全二次校验。
      return convertAll(items as MigrationItem[], broadcastStep);
    },
  );

  log.info('maker:cross-agent:* IPC handlers registered');
}
