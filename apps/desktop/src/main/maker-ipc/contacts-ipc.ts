/**
 * contacts-ipc —— 智能通讯录的 IPC 层(设置页管理 UI 的数据通道)。
 *
 * 结构(规则 14: handler 业务体可注入可测):
 *  - createContactsIpcHandlers(deps): channel → 纯 async handler 的映射,
 *    依赖(manager / settings store)全部注入, 测试用内存 harness 直接 invoke。
 *  - registerContactsIpc(): 组装 desktop 默认 deps + ipcMain.handle 接线,
 *    bootstrap-electron 启动期调一次。
 *
 * 语义:
 *  - 设置开关只 gate agent 侧(cindy_contacts MCP), 数据 CRUD 通道不受 gate —
 *    用户关着开关也能在设置页浏览/清理数据。
 *  - ContactsError → throwIpcError 映射(identity-conflict → IDENTITY_CONFLICT,
 *    message 已含占用者 contact id)。
 *  - 变更后向所有窗口广播 changed 事件(设置页多窗口/实时刷新用)。
 */

import { BrowserWindow, ipcMain } from 'electron';

import { createLogger } from '../logger.js';

import {
  ContactsError,
  importContacts,
  parseVCards,
  type ImportContactRecord,
  type MakerContactsManager,
} from '@cindy/maker-core';

import { MAKER_INVOKE } from './channels.js';
import { throwIpcError, requireObject, requireString } from '../utils/ipcValidate.js';
import { getDesktopContactsManager } from '../maker-host/maker-contacts-host.js';
import { readSystemContacts } from '../maker-host/system-contacts.js';
import {
  readContactsSettingsState,
  writeContactsEnabled,
} from '../maker-host/contacts-settings-store.js';
import { isIpcError, type IpcErrorCode } from '../../shared/ipc-errors.js';

export const CONTACTS_CHANGED_CHANNEL = 'maker:contacts:changed';

const log = createLogger('contactsIpc');

export interface ContactsIpcDeps {
  getManager: () => MakerContactsManager;
  readSettingsState: () => { value: { enabled: boolean }; isCustomized: boolean };
  writeEnabled: (enabled: boolean) => void;
  broadcastChanged: () => void;
  /**
   * 开关值变化后失效 Codex 本地 app-server(可选, 生产注入; 测试可省略)。
   *
   * Claude 每个会话按 provider isEnabled 现读, 开关下次 session 即生效; 但 Codex 的
   * mcp_servers flags 冻在 codexEnvironment 的模块级 cached spawn 配置里, 且 app-server
   * 进程跨会话长活复用 —— 不失效则开了开关的用户后续 codex 会话仍拿不到 cindy_contacts
   * (关闭方向同理: 工具残留), 直到重启 app。生产实现与自定义 MCP CRUD 的
   * invalidateCodex 同款: 先 dispose app-server(含 busy 检查), 成功后再清 bridge/cache。
   *
   * 契约: 失效失败必须 reject(不得内部吞掉) — handler 据此把 codexMcpRefreshed:false
   * 返回给 renderer 提示"对 Codex 延迟生效", 静默成功会掩盖开关与 Codex 实际状态失同步。
   */
  invalidateCodexMcp?: () => Promise<void>;
}

/**
 * ContactsError code → IpcErrorCode; 已是 [CODE] 协议的错误原样上抛;
 * 其余(TypeError/SqliteError 等)兜底包成 INTERNAL — 保证 renderer 端
 * extractIpcError 永远能解出 code, 不出现裸错误破协议。
 */
function rethrowAsIpcError(err: unknown): never {
  if (err instanceof ContactsError) {
    const map: Record<string, IpcErrorCode> = {
      'invalid-params': 'INVALID_PARAMS',
      'not-found': 'NOT_FOUND',
      'already-exists': 'ALREADY_EXISTS',
      'identity-conflict': 'IDENTITY_CONFLICT',
      'io-error': 'INTERNAL',
    };
    throwIpcError(map[err.code] ?? 'INTERNAL', err.message);
  }
  if (isIpcError(err)) throw err;
  throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
}

type Handler = (...args: unknown[]) => Promise<unknown>;

/** channel → handler 映射. deps 注入, 无 Electron 依赖(测试可直接 invoke) */
export function createContactsIpcHandlers(deps: ContactsIpcDeps): Record<string, Handler> {
  /** 包一层: store 操作 + 错误翻译 + 变更广播 */
  const mutate = async <T>(fn: () => T): Promise<T> => {
    try {
      const result = fn();
      deps.broadcastChanged();
      return result;
    } catch (err) {
      rethrowAsIpcError(err);
    }
  };
  const query = async <T>(fn: () => T): Promise<T> => {
    try {
      return fn();
    } catch (err) {
      rethrowAsIpcError(err);
    }
  };
  const store = () => deps.getManager().getStore();

  return {
    [MAKER_INVOKE.CONTACTS_SETTINGS_GET]: async () => {
      const state = deps.readSettingsState();
      return { enabled: state.value.enabled, isCustomized: state.isCustomized };
    },
    [MAKER_INVOKE.CONTACTS_SETTINGS_SET]: async (enabled) => {
      if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled required (boolean)');
      const changed = deps.readSettingsState().value.enabled !== enabled;
      // Claude 侧生效点在下次 session start(mcp provider isEnabled 现读); Codex 的
      // MCP flags 冻在 codexEnvironment 的 cached spawn 配置里, 值真变化时还要失效
      // Codex app-server。失效失败(典型: 本地 codex 会话正忙, 软重启 fail-closed)
      // 不回滚开关(Claude 侧已即时生效), 但必须把 deferred 状态浮给 renderer —
      // 静默报成功会让用户以为 Codex 也已生效, 实际旧注册要等重启才消失。
      try {
        deps.writeEnabled(enabled);
      } catch (err) {
        // 落盘失败(userData 只读/磁盘满)按规则 13 走 [CODE] 协议 — 裸 Error 会让
        // renderer 的 extractIpcError 解不出码, 只能给 generic 文案
        rethrowAsIpcError(err);
      }
      let codexMcpRefreshed = true;
      if (changed) {
        try {
          await deps.invalidateCodexMcp?.();
        } catch {
          codexMcpRefreshed = false;
        }
      }
      return { enabled, codexMcpRefreshed };
    },

    [MAKER_INVOKE.CONTACTS_LIST]: async (opts) =>
      query(() => store().listContacts((opts ?? {}) as Parameters<ReturnType<typeof store>['listContacts']>[0])),
    [MAKER_INVOKE.CONTACTS_GET]: async (id) => query(() => store().getContact(requireString(id, 'id'))),
    [MAKER_INVOKE.CONTACTS_CREATE]: async (input) =>
      mutate(() =>
        store().createContact(
          requireObject(input, 'input') as unknown as Parameters<ReturnType<typeof store>['createContact']>[0],
        ),
      ),
    [MAKER_INVOKE.CONTACTS_UPDATE]: async (id, patch) =>
      mutate(() =>
        store().updateContact(
          requireString(id, 'id'),
          requireObject(patch, 'patch') as unknown as Parameters<ReturnType<typeof store>['updateContact']>[1],
        ),
      ),
    [MAKER_INVOKE.CONTACTS_DELETE]: async (id) =>
      mutate(() => {
        store().deleteContact(requireString(id, 'id'));
        return { deleted: true };
      }),
    [MAKER_INVOKE.CONTACTS_MERGE]: async (targetId, sourceId) =>
      mutate(() => store().merge(requireString(targetId, 'targetId'), requireString(sourceId, 'sourceId'))),
    [MAKER_INVOKE.CONTACTS_RESOLVE]: async (value, opts) =>
      query(() =>
        store().resolve(
          requireString(value, 'value'),
          (opts ?? {}) as Parameters<ReturnType<typeof store>['resolve']>[1],
        ),
      ),
    [MAKER_INVOKE.CONTACTS_SEARCH]: async (queryText, opts) =>
      query(() =>
        store().search(
          requireString(queryText, 'query'),
          (opts ?? {}) as Parameters<ReturnType<typeof store>['search']>[1],
        ),
      ),
    [MAKER_INVOKE.CONTACTS_STATS]: async () => query(() => store().stats()),

    [MAKER_INVOKE.CONTACTS_ADD_IDENTITY]: async (contactId, input) =>
      mutate(() =>
        store().addIdentity(
          requireString(contactId, 'contactId'),
          requireObject(input, 'input') as unknown as Parameters<ReturnType<typeof store>['addIdentity']>[1],
        ),
      ),
    [MAKER_INVOKE.CONTACTS_REMOVE_IDENTITY]: async (identityId) =>
      mutate(() => {
        store().removeIdentity(requireString(identityId, 'identityId'));
        return { removed: true };
      }),
    [MAKER_INVOKE.CONTACTS_APPEND_EVENT]: async (contactId, input) =>
      mutate(() =>
        store().appendEvent(
          requireString(contactId, 'contactId'),
          requireObject(input, 'input') as unknown as Parameters<ReturnType<typeof store>['appendEvent']>[1],
        ),
      ),
    [MAKER_INVOKE.CONTACTS_ADD_RELATION]: async (fromId, input) =>
      mutate(() =>
        store().addRelation(
          requireString(fromId, 'fromId'),
          requireObject(input, 'input') as unknown as Parameters<ReturnType<typeof store>['addRelation']>[1],
        ),
      ),
    [MAKER_INVOKE.CONTACTS_REMOVE_RELATION]: async (relationId) =>
      mutate(() => {
        store().removeRelation(requireString(relationId, 'relationId'));
        return { removed: true };
      }),
    [MAKER_INVOKE.CONTACTS_DELETE_EVENT]: async (eventId) =>
      mutate(() => {
        store().deleteEvent(requireString(eventId, 'eventId'));
        return { deleted: true };
      }),

    [MAKER_INVOKE.CONTACTS_GROUPS_LIST]: async () => query(() => store().listGroups()),
    [MAKER_INVOKE.CONTACTS_GROUPS_CREATE]: async (name, description) =>
      mutate(() =>
        store().createGroup(
          requireString(name, 'name'),
          typeof description === 'string' ? description : '',
        ),
      ),
    [MAKER_INVOKE.CONTACTS_GROUPS_UPDATE]: async (groupId, patch) =>
      mutate(() =>
        store().updateGroup(
          requireString(groupId, 'groupId'),
          requireObject(patch, 'patch') as { name?: string; description?: string },
        ),
      ),
    [MAKER_INVOKE.CONTACTS_GROUPS_DELETE]: async (groupId) =>
      mutate(() => {
        store().deleteGroup(requireString(groupId, 'groupId'));
        return { deleted: true };
      }),
    [MAKER_INVOKE.CONTACTS_GROUPS_SET_MEMBERS]: async (groupId, payload) =>
      mutate(() => {
        const gid = requireString(groupId, 'groupId');
        const p = requireObject(payload, 'payload') as { add?: unknown; remove?: unknown };
        const add = Array.isArray(p.add) ? p.add.filter((x): x is string => typeof x === 'string') : [];
        const remove = Array.isArray(p.remove) ? p.remove.filter((x): x is string => typeof x === 'string') : [];
        if (add.length > 0) store().addToGroup(gid, add);
        if (remove.length > 0) store().removeFromGroup(gid, remove);
        return { added: add.length, removed: remove.length };
      }),

    [MAKER_INVOKE.CONTACTS_RESET_ALL]: async () => mutate(() => store().resetAll()),

    [MAKER_INVOKE.CONTACTS_PARSE_VCF]: async (text) => {
      if (typeof text !== 'string') throwIpcError('INVALID_PARAMS', 'vcf text required (string)');
      if (text.length > 32 * 1024 * 1024) throwIpcError('INVALID_PARAMS', 'vcf too large (> 32MB)');
      return parseVCards(text);
    },
    // 静态 import — 动态 import() 会被 vite 切成共享 chunk, 连带其它模块的
    // 顶层 IPC 注册副作用被二次求值(register second handler 崩)
    [MAKER_INVOKE.CONTACTS_SYSTEM_READ]: async () => readSystemContacts(),
    [MAKER_INVOKE.CONTACTS_IMPORT]: async (records, opts) =>
      mutate(() => {
        if (!Array.isArray(records)) throwIpcError('INVALID_PARAMS', 'records must be an array');
        const o = (opts ?? {}) as { groupId?: unknown };
        return importContacts(store(), records as ImportContactRecord[], {
          ...(typeof o.groupId === 'string' && o.groupId ? { groupId: o.groupId } : {}),
        });
      }),
  };
}

/** 向所有窗口广播通讯录变更(IPC mutate 与 MCP 写类工具共用 — agent 直写 store 不经 IPC 层) */
export function broadcastContactsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CONTACTS_CHANGED_CHANNEL);
  }
}

/** bootstrap-electron 启动期调一次: 组装 desktop deps + ipcMain.handle 接线 */
export function registerContactsIpc(): void {
  const handlers = createContactsIpcHandlers({
    getManager: getDesktopContactsManager,
    readSettingsState: readContactsSettingsState,
    writeEnabled: writeContactsEnabled,
    broadcastChanged: broadcastContactsChanged,
    // 与 register.ts 自定义 MCP CRUD 的 invalidateCodex 同款语义与顺序: 先 dispose
    // app-server(含 busy 检查), 成功后再关 bridge/清 cache —— 若先关 bridge 而 dispose
    // 失败(busy), running 会话的 mcp_servers URL 会指向已停的 bridge。
    // 动态 import 破环: contacts-ipc 被 mcp-providers 静态引用, 而 maker-host/index
    // 又引 mcp-providers, 这里静态 import maker-host/index 会成环(同 mcp-providers
    // 内 remote-ssh 的先例)。
    // 契约: 任一步失败都 rethrow(见 ContactsIpcDeps.invalidateCodexMcp 注释),
    // handler 把失败折成 codexMcpRefreshed:false 由 renderer 提示延迟生效。
    invalidateCodexMcp: async () => {
      try {
        const { restartCodexAfterAuthModeChange } = await import('../maker-host/index.js');
        await restartCodexAfterAuthModeChange();
      } catch (err) {
        log.warn('restartCodexAfterAuthModeChange on contacts toggle failed — codex keeps stale MCP config until app restart or re-toggle', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      try {
        const { shutdownCodexEnvironment } = await import('../mcp-integrations/codexEnvironment.js');
        await shutdownCodexEnvironment();
      } catch (err) {
        log.warn('shutdownCodexEnvironment on contacts toggle failed — cached spawn config still stale', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, ...args) => handler(...args));
  }
}
