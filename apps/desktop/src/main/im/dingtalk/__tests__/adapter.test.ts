import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DingTalkIM, IMMessageEvent } from '@cindy/im';

const holder = vi.hoisted(() => ({ drizzle: null as unknown }));

vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: holder.drizzle }),
  tryGetDbClient: () => ({ drizzle: holder.drizzle }),
}));

import {
  buildDingTalkAdapter,
  dingtalkManagedWorkingDirName,
  dingtalkSessionIdFor,
} from '../adapter';
import { DINGTALK_PERSONAL_GROUP_WINDOW } from '../../shared/channelGroupWindow';

const CONFIG = {
  agentKind: 'claude-code' as const,
  defaultModel: 'claude-opus-4-7',
  defaultPermissionMode: 'auto' as const,
  effortOverrides: { 'claude-opus-4-7': 'xhigh' as const },
};

describe('dingtalk managed working directory identity', () => {
  it('keeps normal app keys readable and backward compatible', () => {
    expect(dingtalkManagedWorkingDirName('ding_app-123')).toBe('dingtalk-ding_app-123');
  });

  it('hashes unsafe app keys instead of collapsing replacement collisions', () => {
    const slashKey = dingtalkManagedWorkingDirName('ding/app');
    const dashKey = dingtalkManagedWorkingDirName('ding-app');

    expect(slashKey).toMatch(/^dingtalk-external-[a-f0-9]{24}$/);
    expect(slashKey).not.toBe(dashKey);
  });

  it('hashes long app keys instead of collapsing suffix truncation collisions', () => {
    const sharedSuffix = 'x'.repeat(128);
    const first = dingtalkManagedWorkingDirName(`first-${sharedSuffix}`);
    const second = dingtalkManagedWorkingDirName(`second-${sharedSuffix}`);

    expect(first).toMatch(/^dingtalk-external-[a-f0-9]{24}$/);
    expect(first).not.toBe(second);
    expect(dingtalkManagedWorkingDirName(`first-${sharedSuffix}`)).toBe(first);
  });
});

describe('dingtalk session identity', () => {
  it('keeps distinct lane ids distinct after encoding', () => {
    const percentEncodedLane = dingtalkSessionIdFor('ding-app', 'g/a%2Fb');
    const dashLane = dingtalkSessionIdFor('ding-app', 'g/a-2Fb');

    expect(percentEncodedLane).not.toBe(dashLane);
  });

  it('is stable, reversible, and session-id safe', () => {
    const appKey = 'ding_app/中国';
    const userId = 'g/conversation_with_underscore/话题';
    const sessionId = dingtalkSessionIdFor(appKey, userId);
    const encodedIdentity = sessionId.slice('dingtalk_'.length);

    expect(sessionId).toMatch(/^dingtalk_[a-zA-Z0-9_-]+$/);
    expect(dingtalkSessionIdFor(appKey, userId)).toBe(sessionId);
    expect(JSON.parse(Buffer.from(encodedIdentity, 'base64url').toString('utf8'))).toEqual([
      appKey,
      userId,
    ]);
  });
});

describe('dingtalk turn permission boundary', () => {
  const adapter = buildDingTalkAdapter({} as DingTalkIM, CONFIG);
  const baseEvent = {
    channelName: 'dingtalk',
    senderId: 'owner-user',
    chatId: 'conversation-1',
    contextId: 'ding-app',
    messageId: 'message-1',
    text: 'run task',
    attachments: [],
    unsupported: [],
  } satisfies IMMessageEvent;

  it('主人私聊遵循 session permissionMode，不叠加与完全访问互斥的逐轮策略', () => {
    expect(adapter.turnPermissionPolicyFor?.(baseEvent)).toBeUndefined();
  });

  it('群聊保留逐轮危险操作强确认', () => {
    const policy = adapter.turnPermissionPolicyFor?.({
      ...baseEvent,
      senderId: 'g/conversation-1',
      speaker: {
        id: 'member-1',
        name: '成员',
        isOwner: false,
      },
    });

    expect(policy?.origin).toEqual({
      kind: 'im',
      channel: 'dingtalk',
      taskId: 'message-1',
    });
    expect(policy?.forceConfirmToolCall('file_change', {})).toBe(true);
  });
});

describe('dingtalk teammate-owned connection', () => {
  const im = { getOwnerUserId: () => 'owner-1' } as unknown as DingTalkIM;

  it('maps the TOFU owner DM, other DMs and group conversations to companion lanes', () => {
    const adapter = buildDingTalkAdapter(im, CONFIG, { companionBotId: 'bot-mia' });
    expect(adapter.companionLane?.('owner-1')).toEqual({ kind: 'owner-dm' });
    expect(adapter.companionLane?.('stranger')).toEqual({ kind: 'guest-dm', userId: 'stranger' });
    expect(adapter.companionLane?.('g/cid%2F1')).toEqual({ kind: 'group', chatId: 'cid/1', threadId: '' });
    // 还没人私聊过(TOFU 未发生)时谁都不是主人。
    const unbound = buildDingTalkAdapter({ getOwnerUserId: () => '' } as unknown as DingTalkIM, CONFIG, { companionBotId: 'bot-mia' });
    expect(unbound.companionLane?.('owner-1')).toEqual({ kind: 'guest-dm', userId: 'owner-1' });
  });

  it('lets owner-triggered group turns run on the teammate permission tier and keeps the guest policy', () => {
    const adapter = buildDingTalkAdapter(im, CONFIG, { companionBotId: 'bot-mia' });
    const personal = buildDingTalkAdapter(im, CONFIG);
    const ownerEvent = { messageId: 'm1', speaker: { id: 'owner-1', name: 'Owner', isOwner: true } } as unknown as IMMessageEvent;
    const guestEvent = { messageId: 'm2', speaker: { id: 'g', name: 'Guest', isOwner: false } } as unknown as IMMessageEvent;
    expect(adapter.turnPermissionPolicyFor?.(ownerEvent)).toBeUndefined();
    expect(adapter.turnPermissionPolicyFor?.(guestEvent)).toBeDefined();
    expect(personal.turnPermissionPolicyFor?.(ownerEvent)).toBeDefined();
    expect(adapter.turnPermissionPolicyFor?.({ messageId: 'dm' } as IMMessageEvent)).toBeUndefined();
  });
});

describe('dingtalk group window', () => {
  let sqlite: InstanceType<typeof Database>;

  beforeEach(async () => {
    const dir = path.resolve(__dirname, '../../../../../drizzle');
    const sql = ['0083_', '0086_', '0087_', '0088_']
      .map((prefix) => {
        const file = fs.readdirSync(dir).find((name) => name.startsWith(prefix));
        if (!file) throw new Error(`${prefix} migration not found`);
        return fs.readFileSync(path.join(dir, file), 'utf8');
      })
      .join('\n')
      .replaceAll('--> statement-breakpoint', ';');
    sqlite = new Database(':memory:');
    sqlite.exec(sql);
    holder.drizzle = drizzle(sqlite);
    await DINGTALK_PERSONAL_GROUP_WINDOW.resetCursors();
  });

  afterEach(() => {
    sqlite.close();
  });

  const groupEvent = (messageId: string, text: string, name: string, isOwner: boolean): IMMessageEvent => ({
    channelName: 'dingtalk',
    interactionSource: { chatName: '发布群', senderName: name },
    senderId: 'g/conv-1',
    chatId: 'conv-1',
    contextId: 'ding-app',
    messageId,
    text,
    invoked: true,
    speaker: { id: `${name}-id`, name, isOwner },
    attachments: [],
    unsupported: [],
  });

  it('records member mentions and the bot reply, and the owner turn sees them as the group prefix', async () => {
    const im = {
      getStatus: () => ({ kind: 'connected', appId: 'ding-app' }),
      commitFinal: vi.fn(async () => undefined),
    } as unknown as DingTalkIM;
    const adapter = buildDingTalkAdapter(im, CONFIG);
    if (adapter.output.kind !== 'chunked-text') throw new Error('expected chunked-text output');

    // 成员那一轮没被受理(没有 commit), 这条留在窗口里当下次的背景。
    await adapter.prepareAgentTurnText?.(groupEvent('m-1', '服务器又挂了', '李四', false));
    await adapter.output.commitFinal({ userId: 'g/conv-1', text: '我先看下日志', terminal: 'done' });
    // 报错终稿不入窗。
    await adapter.output.commitFinal({ userId: 'g/conv-1', text: '运行出错', terminal: 'error' });

    expect(
      sqlite.prepare('SELECT provider, chat_name, author, is_bot FROM hook_group_messages ORDER BY id').all(),
    ).toEqual([
      { provider: 'dingtalk-personal:ding-app', chat_name: '发布群', author: '李四', is_bot: 0 },
      { provider: 'dingtalk-personal:ding-app', chat_name: null, author: 'bot', is_bot: 1 },
    ]);

    const owner = await adapter.prepareAgentTurnText?.(groupEvent('m-2', '结论呢', '张三', true));
    const text = owner?.agentText ?? '';
    expect(text.indexOf('<group_chat_context>')).toBe(0);
    expect(text).toContain('[李四]');
    expect(text).toContain('我先看下日志');
    expect(text).not.toContain('运行出错');
    expect(text.endsWith('[发言人] 张三 · id:张三-id · 主人\n结论呢')).toBe(true);
    expect(owner?.contextSnapshot?.groupMessageCount).toBe(2);
  });
});
