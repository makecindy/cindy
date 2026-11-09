// Subagent 模型执行策略的**用户侧设置**(owner 隔离,见 SECURITY_DESIGN.md):
//
//   - mode:子代理模型执行模式。默认 `development`(P1-D)—— local 照常,
//     allow-list 免费模型照常,未单独授权的收费模型一律拒绝(即使列在
//     model chain 中)。`approved-paid` 保留,但只能经用户显式启用。
//   - privateData:声明为「涉及私人数据」的 session / project。命中时**强制**
//     local-only,无论用户在设置里把 mode 调成什么。
//
// 写入口只属于用户设置面(Host 侧写文件);Agent 无权调用。

import { app } from 'electron';
import path from 'node:path';
import { activeOwnerScopeKey, getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
} from './override-settings-file.js';
import type { ModelExecutionMode } from '@cindy/maker-core';

const log = desktopMakerLogger.child('subagent-model-execution-settings-store');

export type { ModelExecutionMode };

/**
 * 默认模式(P1-D):开发模式 —— local 照常;allow-list 中的免费模型照常;
 * 任何未单独授权的收费模型一律拒绝(即使列在 model chain 中)。
 * `approved-paid` 保留,但只能经用户显式启用(设置入口,不经 Agent)。
 */
export const DEFAULT_EXECUTION_MODE: ModelExecutionMode = 'development';

export interface ExecutionSettings {
  mode: ModelExecutionMode;
  privateData: {
    sessionIds: string[];
    projectRoots: string[];
  };
}

const DEFAULTS: ExecutionSettings = {
  mode: DEFAULT_EXECUTION_MODE,
  privateData: { sessionIds: [], projectRoots: [] },
};

function cleanStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed && out.length < limit) out.push(trimmed);
  }
  return out;
}

function normalize(raw: unknown): ExecutionSettings {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const mode = record.mode;
  const privateData = record.privateData && typeof record.privateData === 'object' && !Array.isArray(record.privateData)
    ? (record.privateData as Record<string, unknown>)
    : {};
  return {
    mode: mode === 'local-only' || mode === 'development' || mode === 'approved-paid' ? mode : DEFAULT_EXECUTION_MODE,
    privateData: {
      sessionIds: cleanStringList(privateData.sessionIds, 512),
      projectRoots: cleanStringList(privateData.projectRoots, 512),
    },
  };
}

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? app.getPath('userData'), 'subagent-model-execution-settings.json');
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<ExecutionSettings>>>();

function currentStore(rootPath?: string) {
  const ownerRoot = rootPath
    ?? (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null);
  const key = ownerRoot ?? '<global>';
  let current = stores.get(key);
  if (!current) {
    current = createOverrideSettingsFile<ExecutionSettings>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: DEFAULTS,
      normalize,
      log,
      label: 'subagent-model-execution-settings',
      scopeKey: rootPath ? () => `root:${rootPath}` : activeOwnerScopeKey,
    });
    stores.set(key, current);
  }
  return current;
}

export async function readSubagentModelExecutionSettings(
  options?: { rootPath?: string },
): Promise<ExecutionSettings> {
  return currentStore(options?.rootPath).read();
}

/** 是否应在本会话强制 local-only:session 在 privateData 或项目根落在私有目录树内。 */
export function isSessionForcedLocalOnly(
  settings: ExecutionSettings,
  context: { sessionId: string; projectRoot?: string },
): boolean {
  if (settings.privateData.sessionIds.includes(context.sessionId)) return true;
  if (context.projectRoot) {
    const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const root = normalizePath(context.projectRoot);
    if (settings.privateData.projectRoots.some((candidate) => {
      const expected = normalizePath(candidate);
      return expected !== '' && (root === expected || root.startsWith(expected + '/'));
    })) {
      return true;
    }
  }
  return false;
}
