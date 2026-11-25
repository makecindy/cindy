import { describe, expect, it } from 'vitest';

import {
  isBotGroupTerminalSessionId,
  resolveBotGroupTerminalSidebar,
} from '../botGroupTerminalSidebar';

// 依据：#12409 完成条件——群聊终端按账号 + 群在本机分桶、从主目录开始，不建占位任务。
// 缺口：群聊此前不向右栏声明任何上下文。最小失败输入：缺主目录时仍开放右栏。tier: unit。
describe('resolveBotGroupTerminalSidebar', () => {
  it('opens a local bucket per account and group, starting in the home directory', () => {
    const a = resolveBotGroupTerminalSidebar({ groupId: 'g1', dataOwnerId: 'acct-1', homeDir: '/Users/me' });
    const b = resolveBotGroupTerminalSidebar({ groupId: 'g1', dataOwnerId: 'acct-2', homeDir: '/Users/me' });
    const c = resolveBotGroupTerminalSidebar({ groupId: 'g2', dataOwnerId: 'acct-1', homeDir: '/Users/me' });
    expect(a).toMatchObject({ available: true, workdir: '/Users/me' });
    expect(isBotGroupTerminalSessionId(a.sessionId)).toBe(true);
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
  });

  it.each([
    { groupId: '', dataOwnerId: 'acct', homeDir: '/Users/me' },
    { groupId: 'g1', dataOwnerId: null, homeDir: '/Users/me' },
    { groupId: 'g1', dataOwnerId: 'acct', homeDir: null },
  ])('stays closed until account, group and home directory are known (%o)', (input) => {
    expect(resolveBotGroupTerminalSidebar(input)).toEqual({ available: false, sessionId: null, workdir: null });
  });
});
