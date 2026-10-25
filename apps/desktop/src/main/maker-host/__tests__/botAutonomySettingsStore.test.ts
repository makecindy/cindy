/*
 * 测试价值
 * - 生产入口与可观察结果：bot-autonomy-settings-store 的读 / 写 / 恢复默认，结合 resolveSchedulerBotId 得到
 *   主人看到的「自动跟进所有任务」归属：未自定义保持关闭；显式关掉要落盘并跨读保持；
 *   恢复默认删除 override。
 * - Bug／规则依据：docs/dev-rules/configuration-and-overrides.md（只存 override，恢复默认 = 删除）；
 *   cindy-bots-runtime.md §6.3「总调度唯一，默认关闭」。
 * - 现有覆盖缺口：overrideSettingsFile.test 只测通用文件层，不测 null 作为有意义的 override（关掉总调度）
 *   与「未自定义」的区分。
 * - 最小失败输入：写 null 后若不落盘（preserveDefaults 缺失），重新读会再次展示邀请；override 文件损坏时
 *   必须保持关闭且不重复邀请。
 * - tier：unit（临时目录真实文件，无计时器）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SCHEDULER_BOT_ID } from '../../../shared/botAutonomy.js';
import { resolveSchedulerBotId } from '../../bot-autonomy/follower.js';

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'cloud:owner-a',
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'owner-a' }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(os.tmpdir(), 'unused', ...parts),
}));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

const {
  readBotAutonomySettingsOverride,
  resetBotAutonomySettings,
  writeBotAutonomySchedulerBotId,
} = await import('../bot-autonomy-settings-store.js');

const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-autonomy-settings-test-'));
afterAll(() => fs.rmSync(rootPath, { recursive: true, force: true }));

const bots = new Map([
  [DEFAULT_SCHEDULER_BOT_ID, { status: 'active', allowSchedulerFollow: false }],
  ['helper', { status: 'active', allowSchedulerFollow: false }],
]);
const effective = () => resolveSchedulerBotId(readBotAutonomySettingsOverride({ rootPath }), bots);

describe('bot autonomy scheduler setting', () => {
  it('derives the default, persists an explicit off, and restores the default by deleting the override', async () => {
    const file = path.join(rootPath, 'bot-autonomy-settings.json');
    expect(readBotAutonomySettingsOverride({ rootPath })).toEqual({ customized: false, schedulerBotId: null });
    expect(effective()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);

    await writeBotAutonomySchedulerBotId('helper', { rootPath });
    expect(effective()).toBe('helper');

    await writeBotAutonomySchedulerBotId(null, { rootPath });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ schedulerBotId: null });
    expect(readBotAutonomySettingsOverride({ rootPath })).toEqual({ customized: true, schedulerBotId: null });
    expect(effective()).toBeNull();

    await expect(writeBotAutonomySchedulerBotId('', { rootPath })).rejects.toThrow('Invalid teammate id');

    await resetBotAutonomySettings({ rootPath });
    expect(readBotAutonomySettingsOverride({ rootPath }).customized).toBe(false);
    expect(effective()).toBeNull();
  });

  it('fails closed when the override file exists but cannot be read, and reset recovers the default', async () => {
    const file = path.join(rootPath, 'bot-autonomy-settings.json');
    fs.writeFileSync(file, '{"schedulerBotId": nul');
    expect(readBotAutonomySettingsOverride({ rootPath })).toEqual({ customized: true, schedulerBotId: null });
    expect(effective()).toBeNull();
    // 坏文件保留给主人检查；恢复默认删掉它，重新跟随默认。
    expect(fs.readFileSync(file, 'utf8')).toBe('{"schedulerBotId": nul');
    await resetBotAutonomySettings({ rootPath });
    expect(fs.existsSync(file)).toBe(false);
    expect(effective()).toBeNull();
  });
});
