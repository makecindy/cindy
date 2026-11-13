/**
 * settings-store 多实例语义测试:缓存按文件 mtime 失效——另一实例(此处用直接写盘
 * 模拟)改写共享 device-link-settings.json 后,本实例下一次 read 能看到新值;
 * 且本实例后续 write 以盘上最新内容为基线合并,不丢外部改动。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }));
// Keep policy locking and settings I/O real, but scope all files to this fake owner.
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'settings-test-owner',
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(userDataDir, ...parts),
}));
vi.mock('../providerShareAvailabilityTransport.js', () => ({ disableShareAvailability: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  readDeviceLinkSettings,
  updateDeviceLinkSetting,
  writeDeviceLinkSetting,
} from '../settings-store.desktop';

const FILE = 'device-link-settings.json';

/** 模拟另一实例写盘:直接覆盖文件并强制 mtime 前进(规避文件系统 mtime 粒度)。 */
function externalWrite(content: Record<string, unknown>, mtimeOffsetMs: number): void {
  const file = path.join(userDataDir, FILE);
  fs.writeFileSync(file, JSON.stringify(content), 'utf-8');
  const t = new Date(Date.now() + mtimeOffsetMs);
  fs.utimesSync(file, t, t);
}

beforeAll(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-settings-test-'));
});

afterAll(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('settings-store 多实例 mtime 失效', () => {
  it('无文件时返回默认值', () => {
    // agent-net 产品规则：新安装不自动启用实验连接或限制旧版连接。
    expect(readDeviceLinkSettings()).toMatchObject({
      remoteControlEnabled: false,
      agentNetEnabled: false,
      agentNetOnlyEncrypted: false,
    });
  });

  it('本实例写入后读到新值(常规缓存路径)', async () => {
    await writeDeviceLinkSetting('remoteControlEnabled', true);
    expect(readDeviceLinkSettings().remoteControlEnabled).toBe(true);
  });

  it('外部实例改写文件 → mtime 变化 → 本实例 read 重载新值', () => {
    externalWrite({ remoteControlEnabled: false, revokedControllers: ['dev-x'] }, 2_000);
    const s = readDeviceLinkSettings();
    expect(s.remoteControlEnabled).toBe(false);
    expect(s.revokedControllers).toEqual(['dev-x']);
    // 升级前的文件缺少 Agent-Net 字段时，同样保留 V1 默认路径。
    expect(s.agentNetEnabled).toBe(false);
    expect(s.agentNetOnlyEncrypted).toBe(false);
  });

  it('升级读取保留用户显式启用的 Agent-Net 设置', () => {
    externalWrite({ agentNetEnabled: true, agentNetOnlyEncrypted: true }, 3_000);
    expect(readDeviceLinkSettings()).toMatchObject({ agentNetEnabled: true, agentNetOnlyEncrypted: true });
  });

  // #10095 discussion_r4546229095：恢复中的记录需经过真实设置存储保留，否则重启后会接受已取消的确认。
  // 原测试没有待确认记录的写盘/重载；最小输入为 restoring:true 的 pending。tier:unit，复用现有临时目录。
  it('保留远程切换恢复中的标记，写盘和外部重载都不丢失', async () => {
    const pending = { switchId: 'switch-recover', controllerId: 'controller', previous: false,
      deadlineAt: Date.now() + 60_000, pid: 123, restoring: true };
    await writeDeviceLinkSetting('agentNetPendingSwitch', pending);
    expect(readDeviceLinkSettings().agentNetPendingSwitch).toEqual(pending);
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, FILE), 'utf8')) as Record<string, unknown>;
    externalWrite(saved, 3_500);
    expect(readDeviceLinkSettings().agentNetPendingSwitch).toEqual(pending);
  });

  it('外部改动后本实例写入:以盘上最新内容为基线合并,不丢外部字段', async () => {
    externalWrite({ remoteControlEnabled: true, revokedControllers: ['dev-y'] }, 4_000);
    await writeDeviceLinkSetting('disabledControlDeviceIds', ['dev-z']);
    const s = readDeviceLinkSettings();
    expect(s.remoteControlEnabled).toBe(true);
    expect(s.revokedControllers).toEqual(['dev-y']);
    expect(s.disabledControlDeviceIds).toEqual(['dev-z']);
  });

  it('写入后缓存失效:外部替换即使 mtime 与本实例写入一致(极端 TOCTOU)也可见', async () => {
    await writeDeviceLinkSetting('remoteControlEnabled', false);
    const file = path.join(userDataDir, FILE);
    const { mtime } = fs.statSync(file);
    // 模拟另一实例在本进程 rename 与 stat 之间替换文件且 mtime 恰好相同
    fs.writeFileSync(
      file,
      JSON.stringify({ remoteControlEnabled: true, revokedControllers: ['dev-t'] }),
      'utf-8',
    );
    fs.utimesSync(file, mtime, mtime);
    const s = readDeviceLinkSettings();
    expect(s.remoteControlEnabled).toBe(true);
    expect(s.revokedControllers).toEqual(['dev-t']);
  });

  it('写入值经读取端归一化(去重 / trim)后仍判定写入成功', async () => {
    await writeDeviceLinkSetting('disabledControlDeviceIds', ['dev-a', 'dev-a', ' dev-b ']);
    expect(readDeviceLinkSettings().disabledControlDeviceIds).toEqual(['dev-a', 'dev-b']);
  });

  it('updateDeviceLinkSetting:updater 基于盘上最新值合并,不覆盖外部实例刚写入的元素', async () => {
    // 外部实例先撤销了 dev-first(模拟"调用方在锁外基于旧读预计算整数组"要防的场景)
    externalWrite({ remoteControlEnabled: true, revokedControllers: ['dev-first'] }, 6_000);
    const result = await updateDeviceLinkSetting('revokedControllers', (latest) =>
      latest.includes('dev-second') ? latest : [...latest, 'dev-second'],
    );
    expect(result).toEqual(['dev-first', 'dev-second']);
    expect(readDeviceLinkSettings().revokedControllers).toEqual(['dev-first', 'dev-second']);
  });

  it('陈旧写锁(持有者崩溃遗留)被回收,写入正常完成且锁文件被清理', async () => {
    const lock = path.join(userDataDir, `${FILE}.lock`);
    fs.writeFileSync(lock, '99999', 'utf-8');
    const old = new Date(Date.now() - 30_000); // 远超 10s 陈旧阈值
    fs.utimesSync(lock, old, old);
    await writeDeviceLinkSetting('remoteControlEnabled', true);
    expect(readDeviceLinkSettings().remoteControlEnabled).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('新鲜外部锁占用时异步等待,越过陈旧阈值后回收并完成写入(不做无锁写)', async () => {
    const lock = path.join(userDataDir, `${FILE}.lock`);
    // mtime 已接近陈旧阈值:等待 ~剩余时间后被回收,写入在锁内完成
    fs.writeFileSync(lock, '99999', 'utf-8');
    const nearStale = new Date(Date.now() - 9_900);
    fs.utimesSync(lock, nearStale, nearStale);
    await writeDeviceLinkSetting('remoteControlEnabled', false);
    expect(readDeviceLinkSettings().remoteControlEnabled).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('mtime 未变化时命中缓存(同一对象引用)', () => {
    const a = readDeviceLinkSettings();
    const b = readDeviceLinkSettings();
    expect(b).toBe(a);
  });
});
