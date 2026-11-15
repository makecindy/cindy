/**
 * 测试价值
 * - 生产入口与可观察结果：createDesktopMakerMemoryManager（Agent 记忆注入、cindy_memory MCP、伙伴记忆页、
 *   远程设置与夜间整理共用的唯一 store 解析点）按记忆范围打开 store 后，记录实际落盘的文件夹。
 * - 规则依据：cindy-bots-runtime.md「V2 伙伴记忆」：伙伴项目的记忆在项目里的 `.cindy/memory/`，随项目 Git
 *   记版本，按伙伴自己的记忆开关；普通项目的记忆仍在项目外 `<owner>/maker-memory/`，不进用户仓库。
 * - 现有覆盖缺口：此前没有任何用例经桌面装配覆盖记忆文件夹的选择；伙伴项目记忆与普通项目同处项目外。
 * - 最小失败输入：同一 owner 下一个伙伴项目与一个普通项目各写一条记忆；全局记忆关闭时再打开两者；
 *   `.cindy/memory` 被换成指向别处的链接。
 * - tier：unit（真 better-sqlite3 + 临时目录；Electron、登录态与设置只替换为固定值）。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ userData: '', maker: true }));
vi.mock('electron', () => ({ app: { getPath: () => h.userData } }));
vi.mock('../logger-adapter.js', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { desktopMakerLogger: logger };
});
vi.mock('../model-route-guard-live.js', () => ({ isAgentOneShotRouteDisabled: async () => false }));
vi.mock('../memory-settings-store.js', () => ({ readMemorySettings: () => ({ maker: h.maker }) }));
vi.mock('../../localDb/betterSqliteFactory.js', () => ({ createBetterSqliteDatabase: (file: string) => new Database(file) }));
vi.mock('../../appSessionState.js', () => ({
  dataOwnerStorageKey: () => 'owner-a',
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'user-1', generation: 1 }),
  isAppSessionBoundaryPending: () => false,
}));

import type { MakerMemoryManager } from '@cindy/maker-core';
import { createDesktopMakerMemoryManager } from '../maker-memory-host.js';
import { teammateWorkspaceDir } from '../../maker-ipc/botProjectMemory.js';

let manager: MakerMemoryManager | null = null;
beforeEach(async () => {
  h.userData = await mkdtemp(path.join(os.tmpdir(), 'teammate-memory-host-'));
  h.maker = true;
});
afterEach(async () => {
  manager?.dispose();
  manager = null;
  await rm(h.userData, { recursive: true, force: true });
});

const record = { type: 'user' as const, name: 'tea', title: 'Tea', description: 'Likes green tea', body: 'Green tea, no sugar.' };

it('keeps a teammate project\'s memory inside the project, an ordinary project\'s outside, on the teammate\'s own switch', async () => {
  const ownerRoot = path.join(h.userData, 'owners', 'owner-a');
  const teammate = teammateWorkspaceDir(ownerRoot, 'bot_mia');
  const ordinary = path.join(h.userData, 'code', 'app');
  await mkdir(teammate, { recursive: true });
  await mkdir(ordinary, { recursive: true });
  manager = createDesktopMakerMemoryManager();

  await (await manager.getStore(teammate)).write(record);
  await (await manager.getStore(ordinary)).write(record);
  expect(await readdir(path.join(teammate, '.cindy', 'memory'))).toContain('user_tea.md');
  const external = await readdir(path.join(ownerRoot, 'maker-memory'));
  expect(external).toHaveLength(1);
  expect(await readdir(path.join(ownerRoot, 'maker-memory', external[0]!))).toContain('user_tea.md');
  expect(existsSync(path.join(ordinary, '.cindy'))).toBe(false);

  // Cindy's global memory switch off: the teammate's project memory stays usable, ordinary ones do not.
  manager.dispose();
  h.maker = false;
  manager = createDesktopMakerMemoryManager();
  expect((await (await manager.getStore(teammate)).list()).map(item => item.filename)).toEqual(['user_tea.md']);
  await expect(manager.getStore(ordinary)).rejects.toThrow(/disabled/);
});

it('refuses a teammate memory folder that is a link', async () => {
  const ownerRoot = path.join(h.userData, 'owners', 'owner-a');
  const teammate = teammateWorkspaceDir(ownerRoot, 'bot_mia');
  const elsewhere = path.join(h.userData, 'elsewhere');
  await mkdir(path.join(teammate, '.cindy'), { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
  await symlink(elsewhere, path.join(teammate, '.cindy', 'memory'), 'junction');
  manager = createDesktopMakerMemoryManager();

  await expect(manager.getStore(teammate)).rejects.toThrow(/link/);
  expect(await readdir(elsewhere)).toEqual([]);
});
