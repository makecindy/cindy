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
  type GhostToolDecl,
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
 * 档位解析的纯函数内核:单工具精确配置 > 安全的全局策略 > 默认 needs-approval。
 *
 * 默认必须是 needs-approval:配置缺失/损坏/读不出来都会落到这里,fail closed 到
 * 「照旧走确认」而不是「免审批」。
 */
function resolveModeFromConfig(
  cfg: GhostToolPermissionConfig,
  toolName: string,
): ToolApprovalMode {
  if (cfg.tools && cfg.tools[toolName]) {
    return cfg.tools[toolName];
  }
  // always-allow 必须逐工具显式记录。插件更新新增的工具不在用户当初看到的
  // tools 表中，绝不能因旧的全局选择自动拿到免审批；needs/blocked 则是安全
  // 收紧策略，可以继续覆盖未知工具。
  if (
    cfg.globalPolicy &&
    cfg.globalPolicy !== 'custom' &&
    cfg.globalPolicy !== 'always-allow'
  ) {
    return cfg.globalPolicy;
  }
  return 'needs-approval';
}

/**
 * 解析特定工具在指定插件下的当前授权模式（结合精确配置与全局策略，默认 needs-approval）。
 *
 * 每次都经 readGhostToolPermissions 的 invalidateIfChanged 现读盘:用户在设置里改完
 * 当场生效,不需要重开会话。
 */
export function resolveToolApprovalMode(ghostId: string, toolName: string): ToolApprovalMode {
  return resolveModeFromConfig(readGhostToolPermissions(ghostId), toolName);
}

/**
 * 「已阻止」档位的裁决(命中返回结构化拒绝,未命中返回 null)。
 *
 * 两种调用形态的判据不同:
 * - 普通调用:按被点名的那个工具判。真正的收口在 `pipeDispatcher.callGhostTool`
 *   的资格审(所有调用方共用);`mcp-integrations/ghost.ts` 里另有一处提前短路,
 *   只为避免注定被拒的调用先弹配置卡/OAuth 卡。
 * - `grant_only`:它只过户不派发,永远走不到派发器,`mcp-integrations/ghost.ts`
 *   就是它唯一的收口。协议上 grant_only 忽略 tool 字段,所以判据落在插件层——
 *   工具被用户全禁时不存在任何合法的后续调用,预授权只剩"绕过禁用把文件交出去"
 *   这一个用途;调用方若显式点名了一个已声明且被禁的工具,同样拒(比"忽略"更保守,
 *   不会误伤)。未声明任何工具的插件不适用本判据,交回原有 TOOL_NOT_FOUND 链路。
 *
 * `resolveMode` 可注入,供单测直测判据本身(规则 14)。
 */
export function ghostToolBlockVerdict(
  ghostId: string,
  tool: string,
  declaredTools: readonly GhostToolDecl[] | undefined,
  grantOnly: boolean,
  resolveMode: (ghostId: string, toolName: string) => ToolApprovalMode = resolveToolApprovalMode,
): { ok: false; errorCode: 'PERMISSION_DENIED'; message: string } | null {
  const declared = declaredTools ?? [];
  const named =
    typeof tool === 'string' && declared.some((candidate) => candidate.name === tool) ? tool : null;
  const blocked = !grantOnly
    ? resolveMode(ghostId, tool) === 'blocked'
    : (named !== null && resolveMode(ghostId, named) === 'blocked') ||
      (declared.length > 0 &&
        declared.every((candidate) => resolveMode(ghostId, candidate.name) === 'blocked'));
  if (!blocked) return null;
  const tail =
    '不要重试、也不要换别的形态绕过;如确实需要,请让用户自己到「插件」详情页把它改回' +
    '「每次询问」或「总是允许」。';
  return {
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message:
      grantOnly && named === null
        ? `用户已在插件设置里禁用 ${ghostId} 的全部工具,预授权没有意义;${tail}`
        : `用户已在插件设置里禁用 ${ghostId} 的工具 ${named ?? tool};${tail}`,
  };
}

/**
 * 纯函数直测出口(规则 14)。读写真身经 createOverrideSettingsFile 落 userData、
 * 依赖 electron,单测不碰真实文件——落盘链路由 IPC 层与派发器测试覆盖,这里只
 * 锁清洗与档位解析(与 errandPrefsStore 同口径)。
 */
export const __testing = { normalizeConfig, normalize, resolveModeFromConfig };
