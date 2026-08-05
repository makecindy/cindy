/**
 * apps/desktop/src/main/maker-ipc/binary-version.ts
 *
 * maker:agent:binary-version IPC handler —— spawn 当前应用使用的 agent 二进制 `--version`,
 * 把首行输出回给 renderer 的 About 面板。
 *
 * 设计:
 *   - 路径来源: getReadyBinaryPath() (prepare 成功后写入), 拿不到再退到 getCachedBinaryStatus()。
 *   - 进程内按 binaryPath 缓存结果, 同一 binary 只 spawn 一次。
 *   - 5s 超时, 失败时返回 { error }。
 */

import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';

import { createLogger } from '../logger.js';
import {
  getReadyBinaryPath,
  getCachedBinaryStatus,
  isVettedAgentBinaryPath,
  type AgentBinaryKind,
} from '../agent-binaries/index.js';
import { throwIpcError } from '../utils/ipcValidate.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc:binary-version');

export interface AgentBinaryVersionResult {
  kind: AgentBinaryKind;
  binaryPath: string | null;
  version: string | null;
  error?: string;
}

const versionCache = new Map<string, string>();

function isAgentBinaryKind(value: unknown): value is AgentBinaryKind {
  return value === 'claude-code' || value === 'codex';
}

function resolveBinaryPath(kind: AgentBinaryKind): string | null {
  const ready = getReadyBinaryPath(kind);
  if (ready) return ready;
  const cached = getCachedBinaryStatus(kind);
  return cached.binaryReady && cached.binaryPath ? cached.binaryPath : null;
}

function spawnVersion(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ['--version'],
      { timeout: 5000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        const out = (stdout || stderr || '').toString().trim();
        const firstLine = out.split(/\r?\n/)[0]?.trim() ?? '';
        if (!firstLine) {
          reject(new Error('empty --version output'));
          return;
        }
        resolve(firstLine);
      },
    );
  });
}

export function registerMakerBinaryVersionIpc(): void {
  log.info('registering maker:agent:binary-version IPC handler');

  ipcMain.handle(
    MAKER_INVOKE.AGENT_BINARY_VERSION,
    async (_e, agentKind: unknown): Promise<AgentBinaryVersionResult> => {
      if (!isAgentBinaryKind(agentKind)) {
        throwIpcError('INVALID_PARAMS', 'agentKind required (claude-code | codex)');
      }

      const binaryPath = resolveBinaryPath(agentKind);
      // 执行前复核路径确为受管二进制(CodeQL js/command-line-injection 防御纵深)
      if (!binaryPath || !isVettedAgentBinaryPath(agentKind, binaryPath)) {
        return { kind: agentKind, binaryPath: null, version: null, error: 'binary_not_ready' };
      }

      const cached = versionCache.get(binaryPath);
      if (cached) {
        return { kind: agentKind, binaryPath, version: cached };
      }

      try {
        const version = await spawnVersion(binaryPath);
        versionCache.set(binaryPath, version);
        return { kind: agentKind, binaryPath, version };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`${agentKind} --version failed: ${message}`);
        return { kind: agentKind, binaryPath, version: null, error: message };
      }
    },
  );

  log.info('maker:agent:binary-version registered');
}
