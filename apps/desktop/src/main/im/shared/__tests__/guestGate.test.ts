/**
 * 个人 IM 机器人的「群成员也能提问」门(2026-11-24 主人裁决, 照微信插件)。
 *
 * 生产入口: messageHandler 对群里非主人 / 主人的消息调用 createPersonalGuestGate 的 admit / ownerSpoke;
 * 设置存在真实文件(临时目录)。覆盖缺口: 设置页用例只验证读写, 不验证消息进来时谁能被回答、何时暂停。
 * 最小失败输入: 没勾的群里一条成员 @; 勾了的群里成员连续 11 条; 中途主人说一句。
 * tier: unit。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IMMessageEvent } from '@cindy/im';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ root: '' }));

vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(h.root, 'owners', 'owner-1', ...parts),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// 只测飞书(原本只认主人, 不走升级整理), 不碰任务记录。
vi.mock('../chatSources', () => ({ imChatSource: () => null, locallyUsedImChats: async () => [] }));

const { createPersonalGuestGate, __testing } = await import('../guestGate');
const { readImChatSettings, writeImChatSettings, __testing: storeTesting } = await import('../chatSettingsStore');

function event(speakerIsOwner: boolean, chatId = 'oc_g1'): IMMessageEvent {
  return {
    channelName: 'feishu',
    senderId: `g/${chatId}`,
    chatId,
    contextId: 'cli_bot',
    messageId: `om_${Math.random()}`,
    text: '问一下',
    speaker: { id: speakerIsOwner ? 'ou_owner' : 'ou_guest', name: '', isOwner: speakerIsOwner },
    attachments: [],
    unsupported: [],
  };
}

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-guest-gate-'));
  __testing.reset();
  storeTesting.resetCache();
});

afterEach(async () => {
  await fs.rm(h.root, { recursive: true, force: true });
});

describe('personal guest gate', () => {
  it('没勾「群成员也能提问」的群不回答成员', async () => {
    const gate = createPersonalGuestGate('feishu', () => 'paused');
    expect(await gate.admit(event(false), vi.fn())).toBe(false);
  });

  it('连续 10 次仍回答, 第 10 次暂停并在群里说一次; 主人说话后清零', async () => {
    writeImChatSettings('feishu', 'cli_bot', 'oc_g1', { members: true }, '项目群');
    const gate = createPersonalGuestGate('feishu', () => 'paused-notice');
    const notify = vi.fn(async () => {});

    for (let i = 1; i <= 10; i += 1) expect(await gate.admit(event(false), notify)).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith('paused-notice');
    expect(readImChatSettings('feishu', 'cli_bot', 'oc_g1')?.membersPaused).toBe(true);
    // 暂停存在设置里: 换一个门(重启)也照样不回答。
    expect(await createPersonalGuestGate('feishu', () => 'x').admit(event(false), notify)).toBe(false);
    // 别的群不受影响(没勾的照旧不回答, 计数也不串)。
    expect(await gate.admit(event(false, 'oc_other'), notify)).toBe(false);

    gate.ownerSpoke(event(true));
    expect(readImChatSettings('feishu', 'cli_bot', 'oc_g1')?.membersPaused).toBe(false);
    expect(await gate.admit(event(false), notify)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('主人中途说话会清零连续计数', async () => {
    writeImChatSettings('feishu', 'cli_bot', 'oc_g1', { members: true }, null);
    const gate = createPersonalGuestGate('feishu', () => 'paused');
    const notify = vi.fn(async () => {});
    for (let i = 0; i < 9; i += 1) await gate.admit(event(false), notify);
    gate.ownerSpoke(event(true));
    for (let i = 0; i < 9; i += 1) expect(await gate.admit(event(false), notify)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});
