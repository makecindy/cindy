/**
 * Cindy 记忆(普通任务用的那一套)「查看记忆」页的读写服务与 IPC 入口。
 *
 * - 记忆分范围存放: 账号级一份(关于用户本人, 每个项目都生效), 每个项目一份。范围列表
 *   只来自 `MakerMemoryManager.listScopes()`; renderer 带回的 scopeKey 每次都对照这份
 *   列表校验, 不在列表里就拒绝 —— 不为任意传入的路径打开存储。
 * - 总开关关闭时已存的记忆仍可查看、修改、删除(与伙伴记忆页一致), 所以打开存储时
 *   跳过开关检查。
 * - 列表 / 搜索 / 读取 / 保存 / 删除的规则与伙伴记忆页共用, 见 memoryEntries.ts。
 * - 运行中的任务在启动时冻结了记忆目录: 这里改完不通知它们, 新任务才读到新内容。
 * - 只在本机可信窗口里可用, 不登记到设备互联的远程通道。
 */

import path from 'node:path';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  type MakerMemoryManager,
  type MakerMemoryStore,
} from '@cindy/maker-core';

import type { BotMemoryDetail, BotMemorySummary } from '../../shared/botMemory.js';
import type {
  MakerMemoryScopesResult,
  MakerMemoryScopeSummary,
} from '../../shared/makerMemoryEntries.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import {
  createMemoryEntryAccess,
  parseMemoryEntryDelete,
  parseMemoryEntryUpdate,
  readMemoryFilename,
  translateMemoryStoreError,
  type MemoryEntryTarget,
} from './memoryEntries.js';

/** `buildMemoryScopeKey` 给 SSH 项目的键: `ssh:<encodeURIComponent(hostId)>:<远程路径>`。 */
const SSH_SCOPE_KEY_RE = /^ssh:([^:]*):(.*)$/s;
const SCOPE_KEY_MAX = 4096;

export interface MakerMemoryEntriesDeps {
  /** 当前账号的 Cindy 记忆管理器; 还没就绪时抛 MAKER_MEMORY_NOT_READY。 */
  getManager(): Pick<MakerMemoryManager, 'listScopes'> & {
    getStore(scopeKey: string, opts?: { skipDisabledCheck?: boolean }): Promise<MakerMemoryStore>;
  };
  /**
   * 一个任务的项目记忆是哪一份(按工作目录归到仓库根; 一次性对话没有项目记忆, 返回 null)。
   * 结果只用来在已列出的范围里挑一个, 不用来打开存储。
   */
  resolveTaskScopeKey(workingDir: string, remoteHostId: string | null): Promise<string | null>;
  /** 把一次操作绑定到发起它的账号; 账号已切换时 assertCurrent 抛错。 */
  captureOwner(): { assertCurrent(): void };
}

/** 范围在界面上怎么称呼: 项目显示文件夹名与路径, SSH 项目另带主机; 账号级由界面给名字。 */
function describeScope(scope: {
  scopeKey: string;
  kind: 'user' | 'project';
  count: number;
}): MakerMemoryScopeSummary {
  if (scope.kind === 'user') return { ...scope };
  const ssh = SSH_SCOPE_KEY_RE.exec(scope.scopeKey);
  if (ssh) {
    let host = ssh[1]!;
    try {
      host = decodeURIComponent(host);
    } catch {
      // 保留编码形态: 只影响显示。
    }
    const remotePath = ssh[2]!;
    // 远程路径恒为 POSIX 形态, 不跟随本机分隔符。
    return { ...scope, name: path.posix.basename(remotePath) || remotePath, path: remotePath, host };
  }
  return { ...scope, name: path.basename(scope.scopeKey) || scope.scopeKey, path: scope.scopeKey };
}

/** 任务位置是 renderer 给的路径: 只接受有界的绝对路径字符串。 */
function readTaskLocation(raw: unknown): { workingDir: string; remoteHostId: string | null } | null {
  if (raw === undefined || raw === null) return null;
  const body = requireObject(raw);
  const { workingDir, remoteHostId } = body;
  if (
    typeof workingDir !== 'string' ||
    !workingDir ||
    workingDir.length > SCOPE_KEY_MAX ||
    workingDir.includes('\0') ||
    // 远程任务的工作目录是远程主机上的 POSIX 路径。
    !(path.isAbsolute(workingDir) || path.posix.isAbsolute(workingDir))
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid working directory');
  }
  if (remoteHostId !== undefined && remoteHostId !== null && (typeof remoteHostId !== 'string' || !remoteHostId || remoteHostId.length > 256)) {
    throwIpcError('INVALID_PARAMS', 'Invalid remote host');
  }
  return { workingDir, remoteHostId: remoteHostId ?? null };
}

export function createMakerMemoryEntriesService(deps: MakerMemoryEntriesDeps) {
  const access = createMemoryEntryAccess();

  /** 校验 renderer 带回的范围: 必须在当前账号的范围列表里。 */
  async function listed(rawScopeKey: unknown) {
    if (typeof rawScopeKey !== 'string' || !rawScopeKey || rawScopeKey.length > SCOPE_KEY_MAX) {
      throwIpcError('INVALID_PARAMS', 'Invalid memory scope');
    }
    const owner = deps.captureOwner();
    const manager = deps.getManager();
    const scopes = await manager.listScopes().catch(translateMemoryStoreError);
    owner.assertCurrent();
    if (!scopes.some((scope) => scope.scopeKey === rawScopeKey)) {
      throwIpcError('NOT_FOUND', 'Memory scope not found');
    }
    return { scopeKey: rawScopeKey, manager, owner };
  }

  /** 校验范围并打开那一份记忆。 */
  async function open(rawScopeKey: unknown): Promise<MemoryEntryTarget> {
    const { scopeKey, manager, owner } = await listed(rawScopeKey);
    const store = await manager
      .getStore(scopeKey, { skipDisabledCheck: true })
      .catch(translateMemoryStoreError);
    owner.assertCurrent();
    return { store, lockKey: scopeKey };
  }

  /** 结果返回前再核对一次账号: 期间切换了就不把上一个账号的内容交出去。 */
  async function bound<T>(run: () => Promise<T>): Promise<T> {
    const owner = deps.captureOwner();
    const result = await run();
    owner.assertCurrent();
    return result;
  }

  return {
    /** 范围列表; 传了任务位置时一并指出那个任务的项目是其中哪一份(保存回执点开时用)。 */
    async scopes(rawTask?: unknown): Promise<MakerMemoryScopesResult> {
      const task = readTaskLocation(rawTask);
      return bound(async () => {
        const manager = deps.getManager();
        const scopes = (await manager.listScopes().catch(translateMemoryStoreError)).map(describeScope);
        // 解析不出来(目录已不在、git 探测失败)不算错: 页面落在「关于你」。
        const resolved = task
          ? await deps.resolveTaskScopeKey(task.workingDir, task.remoteHostId).catch(() => null)
          : null;
        const match = scopes.find((scope) => scope.kind === 'project' && scope.scopeKey === resolved);
        return { scopes, taskScopeKey: match?.scopeKey ?? null };
      });
    },

    async list(rawScopeKey: unknown, rawQuery?: unknown): Promise<BotMemorySummary[]> {
      if (rawQuery !== undefined && rawQuery !== null && (typeof rawQuery !== 'string' || rawQuery.length > 200)) {
        throwIpcError('INVALID_PARAMS', 'Invalid query');
      }
      return bound(async () => access.list((await open(rawScopeKey)).store, rawQuery));
    },

    async read(rawScopeKey: unknown, rawFilename: unknown): Promise<BotMemoryDetail> {
      const filename = readMemoryFilename(rawFilename);
      return bound(async () => access.read((await open(rawScopeKey)).store, filename));
    },

    async update(raw: unknown): Promise<BotMemoryDetail> {
      const body = requireObject(raw);
      const update = parseMemoryEntryUpdate({
        filename: body.filename,
        title: body.title,
        body: body.body,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });
      return bound(async () => access.update(await open(body.scopeKey), update));
    },

    async delete(raw: unknown): Promise<void> {
      const body = requireObject(raw);
      const target = parseMemoryEntryDelete({
        filename: body.filename,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });
      return bound(async () => access.delete(await open(body.scopeKey), target));
    },
  };
}

export type MakerMemoryEntriesService = ReturnType<typeof createMakerMemoryEntriesService>;

/** 本机可信窗口的 IPC 适配: 先校验来源, 业务体在上面的服务里。 */
export function registerMakerMemoryEntriesIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: {
    service: MakerMemoryEntriesService;
    assertTrustedSender(event: IpcMainInvokeEvent): void;
  },
): void {
  const { service, assertTrustedSender } = deps;
  ipc.handle(MAKER_INVOKE.MEMORY_ENTRIES_SCOPES, async (event, task: unknown) => {
    assertTrustedSender(event);
    return service.scopes(task);
  });
  ipc.handle(MAKER_INVOKE.MEMORY_ENTRIES_LIST, async (event, scopeKey: unknown, query: unknown) => {
    assertTrustedSender(event);
    return service.list(scopeKey, query);
  });
  ipc.handle(MAKER_INVOKE.MEMORY_ENTRIES_READ, async (event, scopeKey: unknown, filename: unknown) => {
    assertTrustedSender(event);
    return service.read(scopeKey, filename);
  });
  ipc.handle(MAKER_INVOKE.MEMORY_ENTRIES_UPDATE, async (event, body: unknown) => {
    assertTrustedSender(event);
    return service.update(body);
  });
  ipc.handle(MAKER_INVOKE.MEMORY_ENTRIES_DELETE, async (event, body: unknown) => {
    assertTrustedSender(event);
    await service.delete(body);
  });
}
