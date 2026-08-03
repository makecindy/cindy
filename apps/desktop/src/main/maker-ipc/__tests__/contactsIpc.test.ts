/**
 * contacts-ipc handler 单测 — 注入内存 deps 直接 invoke handler body
 * (不起 Electron): 设置开关读写 / CRUD 主路径 / IDENTITY_CONFLICT 错误码映射 /
 * 参数校验错误路径 / 变更广播时机。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { MakerContactsManager } from '@cindy/maker-core';

// contacts-ipc 传递性 import electron(BrowserWindow/ipcMain + settings store);
// handler 工厂本身不用它们, mock 空壳即可。
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/unused', on: () => undefined },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../contacts-sync/driver.js', () => ({
  broadcastContactsNow: vi.fn(),
  getContactsDeviceSyncStatus: vi.fn(),
  onContactsDeviceSyncStatusChanged: vi.fn(),
  setContactsDeviceSyncEnabled: vi.fn(),
}));

import { createContactsIpcHandlers } from '../contacts-ipc.js';
import { MAKER_INVOKE } from '../channels.js';

function noopLogger() {
  const noop = () => {};
  const l = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => l,
  };
  return l;
}

describe('contacts-ipc handlers', () => {
  let tmpDir: string;
  let manager: MakerContactsManager;
  let handlers: ReturnType<typeof createContactsIpcHandlers>;
  let enabled: boolean;
  let broadcasts: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-ipc-test-'));
    manager = new MakerContactsManager({
      basePath: tmpDir,
      sqliteFactory: (p) => new DatabaseCtor(p),
      logger: noopLogger(),
    });
    enabled = false;
    broadcasts = 0;
    handlers = createContactsIpcHandlers({
      getManager: () => manager,
      readSettingsState: () => ({ value: { enabled }, isCustomized: enabled }),
      writeEnabled: (v) => {
        enabled = v;
      },
      broadcastChanged: () => {
        broadcasts += 1;
      },
    });
  });

  afterEach(() => {
    manager.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('设置开关: get 反映 store, set 落盘', async () => {
    expect(await handlers[MAKER_INVOKE.CONTACTS_SETTINGS_GET]!()).toEqual({
      enabled: false,
      isCustomized: false,
    });
    await handlers[MAKER_INVOKE.CONTACTS_SETTINGS_SET]!(true);
    expect(enabled).toBe(true);
    await expect(handlers[MAKER_INVOKE.CONTACTS_SETTINGS_SET]!('yes')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });

  it('开关落盘失败按 [CODE] 协议上抛, 不漏裸 Error(规则 13)', async () => {
    handlers = createContactsIpcHandlers({
      getManager: () => manager,
      readSettingsState: () => ({ value: { enabled: false }, isCustomized: false }),
      writeEnabled: () => {
        throw new Error('EACCES: permission denied');
      },
      broadcastChanged: () => {},
    });
    await expect(handlers[MAKER_INVOKE.CONTACTS_SETTINGS_SET]!(true)).rejects.toThrow(
      /\[INTERNAL\]/,
    );
  });

  it('设备同步状态、开关和立即同步走独立程序通道', async () => {
    let syncEnabled = false;
    const setDeviceSyncEnabled = vi.fn(async (value: boolean) => {
      syncEnabled = value;
    });
    const syncNow = vi.fn(async () => {});
    const status = () => ({
      enabled: syncEnabled,
      phase: syncEnabled ? 'waiting' : 'off',
      onlineDeviceCount: 0,
    });
    handlers = createContactsIpcHandlers({
      getManager: () => manager,
      readSettingsState: () => ({ value: { enabled }, isCustomized: enabled }),
      writeEnabled: (value) => {
        enabled = value;
      },
      broadcastChanged: () => {},
      readDeviceSyncStatus: status,
      setDeviceSyncEnabled,
      syncNow,
    });

    expect(await handlers[MAKER_INVOKE.CONTACTS_SYNC_STATUS_GET]!()).toMatchObject({
      enabled: false,
      phase: 'off',
    });
    expect(await handlers[MAKER_INVOKE.CONTACTS_SYNC_ENABLED_SET]!(true)).toMatchObject({
      enabled: true,
      phase: 'waiting',
    });
    await handlers[MAKER_INVOKE.CONTACTS_SYNC_NOW]!();
    expect(setDeviceSyncEnabled).toHaveBeenCalledWith(true);
    expect(syncNow).toHaveBeenCalledTimes(1);
    await expect(handlers[MAKER_INVOKE.CONTACTS_SYNC_ENABLED_SET]!('yes')).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });

  it('设备同步状态依赖缺失时 fail closed，不向 renderer 返回 undefined', async () => {
    await expect(handlers[MAKER_INVOKE.CONTACTS_SYNC_ENABLED_SET]!(true)).rejects.toThrow(
      /\[INTERNAL\]/,
    );
    await expect(handlers[MAKER_INVOKE.CONTACTS_SYNC_NOW]!()).rejects.toThrow(/\[INTERNAL\]/);
  });

  it('开关值变化时失效 Codex MCP, 同值重写不失效, 失效失败不影响落盘', async () => {
    // 回归: Codex spawn 配置冻在 codexEnvironment cached 里, 开关变化必须触发失效,
    // 否则后续 codex 会话直到重启 app 都拿不到(或残留) cindy_contacts。
    const invalidateCodexMcp = vi.fn(async () => {});
    handlers = createContactsIpcHandlers({
      getManager: () => manager,
      readSettingsState: () => ({ value: { enabled }, isCustomized: enabled }),
      writeEnabled: (v) => {
        enabled = v;
      },
      broadcastChanged: () => {},
      invalidateCodexMcp,
    });

    await expect(handlers[MAKER_INVOKE.CONTACTS_SETTINGS_SET]!(true)).resolves.toEqual({
      enabled: true,
      codexMcpRefreshed: true,
    });
    expect(invalidateCodexMcp).toHaveBeenCalledTimes(1);

    // 同值重写: 不再失效(避免无谓的 codex app-server 重启)
    await expect(handlers[MAKER_INVOKE.CONTACTS_SETTINGS_SET]!(true)).resolves.toEqual({
      enabled: true,
      codexMcpRefreshed: true,
    });
    expect(invalidateCodexMcp).toHaveBeenCalledTimes(1);

    // 关闭方向同样失效(工具残留的镜像问题)
    await handlers[MAKER_INVOKE.CONTACTS_SETTINGS_SET]!(false);
    expect(invalidateCodexMcp).toHaveBeenCalledTimes(2);

    // 失效抛错(典型: codex 会话正忙) → 开关仍已落盘, handler 不抛, 但把
    // deferred 状态浮给 renderer 提示"对 Codex 延迟生效", 不静默报成功
    invalidateCodexMcp.mockRejectedValueOnce(new Error('codex busy'));
    await expect(handlers[MAKER_INVOKE.CONTACTS_SETTINGS_SET]!(true)).resolves.toEqual({
      enabled: true,
      codexMcpRefreshed: false,
    });
    expect(enabled).toBe(true);
    expect(invalidateCodexMcp).toHaveBeenCalledTimes(3);
  });

  it('CRUD 主路径 + 变更广播(开关关闭时数据通道仍可用)', async () => {
    const created = (await handlers[MAKER_INVOKE.CONTACTS_CREATE]!({
      kind: 'person',
      displayName: '张三',
      identities: [{ platform: 'email', value: 'zhang@example.com' }],
    })) as { id: string };
    expect(broadcasts).toBe(1);

    const resolved = (await handlers[MAKER_INVOKE.CONTACTS_RESOLVE]!(
      'zhang@example.com',
      undefined,
    )) as Array<{
      profile: { id: string };
    }>;
    expect(resolved[0]!.profile.id).toBe(created.id);
    expect(broadcasts).toBe(1); // 查询不广播

    await handlers[MAKER_INVOKE.CONTACTS_APPEND_EVENT]!(created.id, {
      date: '2026-07-07',
      text: '入职',
    });
    const got = (await handlers[MAKER_INVOKE.CONTACTS_GET]!(created.id)) as { events: unknown[] };
    expect(got.events).toHaveLength(1);
    expect(broadcasts).toBe(2);

    const stats = (await handlers[MAKER_INVOKE.CONTACTS_STATS]!()) as { people: number };
    expect(stats.people).toBe(1);
  });

  it('IDENTITY_CONFLICT 映射成 IPC 错误码', async () => {
    await handlers[MAKER_INVOKE.CONTACTS_CREATE]!({
      kind: 'person',
      displayName: 'A',
      identities: [{ platform: 'email', value: 'a@example.com' }],
    });
    await expect(
      handlers[MAKER_INVOKE.CONTACTS_CREATE]!({
        kind: 'person',
        displayName: 'B',
        identities: [{ platform: 'email', value: 'a@example.com' }],
      }),
    ).rejects.toThrow(/\[IDENTITY_CONFLICT\]/);
  });

  it('NOT_FOUND / INVALID_PARAMS 错误路径', async () => {
    await expect(handlers[MAKER_INVOKE.CONTACTS_GET]!('nope')).rejects.toThrow(/\[NOT_FOUND\]/);
    await expect(handlers[MAKER_INVOKE.CONTACTS_GET]!(42)).rejects.toThrow(/\[INVALID_PARAMS\]/);
    await expect(
      handlers[MAKER_INVOKE.CONTACTS_CREATE]!({ kind: 'person', displayName: '  ' }),
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
  });

  it('分组: create/set-members/list/delete', async () => {
    const c = (await handlers[MAKER_INVOKE.CONTACTS_CREATE]!({
      kind: 'person',
      displayName: 'A',
    })) as {
      id: string;
    };
    const g = (await handlers[MAKER_INVOKE.CONTACTS_GROUPS_CREATE]!('核心', undefined)) as {
      id: string;
    };
    await handlers[MAKER_INVOKE.CONTACTS_GROUPS_SET_MEMBERS]!(g.id, { add: [c.id] });
    const groups = (await handlers[MAKER_INVOKE.CONTACTS_GROUPS_LIST]!()) as Array<{
      memberCount: number;
    }>;
    expect(groups[0]!.memberCount).toBe(1);
    await handlers[MAKER_INVOKE.CONTACTS_GROUPS_DELETE]!(g.id);
    expect(await handlers[MAKER_INVOKE.CONTACTS_GROUPS_LIST]!()).toEqual([]);
  });

  it('关系边: add/remove relation', async () => {
    const p1 = (await handlers[MAKER_INVOKE.CONTACTS_CREATE]!({
      kind: 'person',
      displayName: 'A',
    })) as {
      id: string;
    };
    const o1 = (await handlers[MAKER_INVOKE.CONTACTS_CREATE]!({
      kind: 'org',
      displayName: 'O',
    })) as {
      id: string;
    };
    const rel = (await handlers[MAKER_INVOKE.CONTACTS_ADD_RELATION]!(p1.id, {
      toId: o1.id,
      relation: '任职',
    })) as { id: string };
    const got = (await handlers[MAKER_INVOKE.CONTACTS_GET]!(p1.id)) as {
      relations: Array<{ displayName: string }>;
    };
    expect(got.relations[0]!.displayName).toBe('O');
    await handlers[MAKER_INVOKE.CONTACTS_REMOVE_RELATION]!(rel.id);
    expect(
      ((await handlers[MAKER_INVOKE.CONTACTS_GET]!(p1.id)) as { relations: unknown[] }).relations,
    ).toEqual([]);
  });

  it('reset-all 清库', async () => {
    await handlers[MAKER_INVOKE.CONTACTS_CREATE]!({ kind: 'person', displayName: 'A' });
    const res = (await handlers[MAKER_INVOKE.CONTACTS_RESET_ALL]!()) as { removedCount: number };
    expect(res.removedCount).toBe(1);
    expect(await handlers[MAKER_INVOKE.CONTACTS_LIST]!(undefined)).toEqual([]);
  });
});
