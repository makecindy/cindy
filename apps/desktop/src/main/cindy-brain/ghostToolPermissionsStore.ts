/**
 * ghostToolPermissionsStore —— 插件/连接器工具粒度授权配置的持久化存储。
 *
 * File: <userData>/ghost-tool-permissions.json
 *
 * 存储形态：
 * {
 *   permissions: {
 *     <ghostId>: {
 *       globalPolicy?: 'always-allow' | 'needs-approval' | 'blocked' | 'custom',
 *       tools?: { [toolName]: 'always-allow' | 'needs-approval' | 'blocked' }
 *     }
 *   }
 * }
 */

import {
  TOOL_APPROVAL_MODES,
  type GhostToolPermissionConfig,
  type GlobalToolPolicy,
  type ToolApprovalMode,
} from '../../shared/ghost.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('ghost-tool-permissions-store');

interface GhostToolPermissionsData {
  permissions: Record<string, GhostToolPermissionConfig>;
}

const DEFAULTS: GhostToolPermissionsData = { permissions: {} };

function isValidMode(val: unknown): val is ToolApprovalMode {
  return typeof val === 'string' && (TOOL_APPROVAL_MODES as readonly string[]).includes(val);
}

function normalizeConfig(raw: unknown): GhostToolPermissionConfig {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const cfg: GhostToolPermissionConfig = {};

  if (isValidMode(r.globalPolicy) || r.globalPolicy === 'custom') {
    cfg.globalPolicy = r.globalPolicy as GlobalToolPolicy;
  }

  if (r.tools && typeof r.tools === 'object' && !Array.isArray(r.tools)) {
    const tools: Record<string, ToolApprovalMode> = {};
    for (const [toolName, mode] of Object.entries(r.tools as Record<string, unknown>)) {
      if (typeof toolName === 'string' && toolName.length > 0 && isValidMode(mode)) {
        tools[toolName] = mode;
      }
    }
    cfg.tools = tools;
  }

  return cfg;
}

function normalize(raw: unknown): GhostToolPermissionsData {
  if (!raw || typeof raw !== 'object') return { permissions: {} };
  const rawPerms = (raw as { permissions?: unknown }).permissions;
  const permissions: Record<string, GhostToolPermissionConfig> = {};
  if (rawPerms && typeof rawPerms === 'object') {
    for (const [ghostId, cfgRaw] of Object.entries(rawPerms as Record<string, unknown>)) {
      const cfg = normalizeConfig(cfgRaw);
      if (cfg.globalPolicy || (cfg.tools && Object.keys(cfg.tools).length > 0)) {
        permissions[ghostId] = cfg;
      }
    }
  }
  return { permissions };
}

const store = createOverrideSettingsFile<GhostToolPermissionsData>({
  filePath: () => ownerScopedUserDataPath('ghost-tool-permissions.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'ghost-tool-permissions',
});

/** 读取指定插件的工具粒度授权配置。 */
export function readGhostToolPermissions(ghostId: string): GhostToolPermissionConfig {
  store.invalidateIfChanged();
  return store.read().permissions[ghostId] ?? {};
}

/** 写入/替换指定插件的工具粒度授权配置。 */
export function writeGhostToolPermissions(
  ghostId: string,
  config: unknown,
): GhostToolPermissionConfig {
  store.invalidateIfChanged();
  const normalized = normalizeConfig(config);
  const permissions = { ...store.read().permissions };
  if (!normalized.globalPolicy && (!normalized.tools || Object.keys(normalized.tools).length === 0)) {
    delete permissions[ghostId];
  } else {
    permissions[ghostId] = normalized;
  }
  store.writePatch({ permissions });
  log.info('ghost tool permissions written', { ghostId, config: normalized });
  return normalized;
}

/**
 * 解析特定工具在指定插件下的当前授权模式（结合精确配置与全局策略，默认 needs-approval）。
 */
export function resolveToolApprovalMode(ghostId: string, toolName: string): ToolApprovalMode {
  const cfg = readGhostToolPermissions(ghostId);
  if (cfg.tools && cfg.tools[toolName]) {
    return cfg.tools[toolName];
  }
  if (cfg.globalPolicy && cfg.globalPolicy !== 'custom') {
    return cfg.globalPolicy;
  }
  return 'needs-approval';
}
