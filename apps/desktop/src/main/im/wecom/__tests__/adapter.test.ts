/**
 * 企业微信 adapter 的伙伴连接契约: TOFU 主人私聊进主任务, 群按 chat 一条专线, 其它私聊按访客;
 * 群消息与机器人终稿入 Telegram 同一张本地群窗口表, 并在下次群里 @ 时拼成背景前缀。
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMMessageEvent, WecomIM } from '@cindy/im';
import { encodeWecomGroupLane } from '@cindy/im';

const holder = vi.hoisted(() => ({ drizzle: null as unknown }));

vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: holder.drizzle }),
  tryGetDbClient: () => ({ drizzle: holder.drizzle }),
}));

import { buildWecomAdapter } from '../adapter';
import type { WecomTextInteractions } from '../textInteractions';
import { WECOM_PERSONAL_GROUP_WINDOW } from '../../shared/channelGroupWindow';

const CONFIG = {
  agentKind: 'claude-code' as const,
  defaultModel: 'claude-opus-4-7',
  defaultPermissionMode: 'auto' as const,
  effortOverrides: { 'claude-opus-4-7': 'xhigh' as const },
};
const interactions = {} as unknown as WecomTextInteractions;

describe('wecom teammate-owned connection', () => {
  it('maps the TOFU owner DM, other DMs and group chats to companion lanes', () => {
    const im = { getOwnerUserId: () => 'zhangsan' } as unknown as WecomIM;
    const adapter = buildWecomAdapter(im, interactions, CONFIG, { companionBotId: 'bot-mia' });
    expect(adapter.companionLane?.('zhangsan')).toEqual({ kind: 'owner-dm' });
    expect(adapter.companionLane?.('lisi')).toEqual({ kind: 'guest-dm', userId: 'lisi' });
    expect(adapter.companionLane?.(encodeWecomGroupLane('wrk-chat-1'))).toEqual({
      kind: 'group',
      chatId: 'wrk-chat-1',
      threadId: '',
    });
    // 坏掉的群 lane 不炸, 按访客私聊处理。
    expect(adapter.companionLane?.('group/!!')).toEqual({ kind: 'guest-dm', userId: 'group/!!' });
    const unbound = buildWecomAdapter({ getOwnerUserId: () => '' } as unknown as WecomIM, interactions, CONFIG, {
      companionBotId: 'bot-mia',
    });
    expect(unbound.companionLane?.('zhangsan')).toEqual({ kind: 'guest-dm', userId: 'zhangsan' });
  });
});

describe('wecom group window', () => {
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
    await WECOM_PERSONAL_GROUP_WINDOW.resetCursors();
  });

  afterEach(() => {
    sqlite.close();
  });

  const lane = encodeWecomGroupLane('wrk-chat-1');
  const groupEvent = (messageId: string, text: string): IMMessageEvent => ({
    channelName: 'wecom',
    senderId: lane,
    chatId: 'wrk-chat-1',
    contextId: 'aibot-1',
    messageId,
    text,
    invoked: true,
    speaker: { id: 'zhangsan', name: 'zhangsan', isOwner: true },
    attachments: [],
    unsupported: [],
  });

  it('records group triggers and the bot reply, and feeds them back as the next turn prefix', async () => {
    const commitFinal = vi.fn(async () => undefined);
    const im = {
      getOwnerUserId: () => 'zhangsan',
      getStatus: () => ({ kind: 'connected', appId: 'aibot-1' }),
      commitFinal,
    } as unknown as WecomIM;
    const adapter = buildWecomAdapter(im, interactions, CONFIG);
    if (adapter.output.kind !== 'chunked-text') throw new Error('expected chunked-text output');

    const first = await adapter.prepareAgentTurnText?.(groupEvent('m-1', '昨天的部署怎么样'));
    expect(first?.agentText).toBe('昨天的部署怎么样');
    await first?.commit?.();
    await adapter.output.commitFinal({ userId: lane, text: '部署已回滚', terminal: 'done' });
    expect(commitFinal).toHaveBeenCalledTimes(1);

    const rows = sqlite
      .prepare('SELECT provider, chat_id, author, is_bot, text FROM hook_group_messages ORDER BY id')
      .all();
    expect(rows).toEqual([
      { provider: 'wecom-personal:aibot-1', chat_id: 'wrk-chat-1', author: 'zhangsan', is_bot: 0, text: '昨天的部署怎么样' },
      { provider: 'wecom-personal:aibot-1', chat_id: 'wrk-chat-1', author: 'bot', is_bot: 1, text: '部署已回滚' },
    ]);

    const second = await adapter.prepareAgentTurnText?.(groupEvent('m-2', '那今天再试一次'));
    expect(second?.agentText).toContain('<group_chat_context>');
    expect(second?.agentText).toContain('部署已回滚');
    // 已 commit 的上一条与本条触发消息都不进前缀。
    expect(second?.agentText).not.toContain('昨天的部署怎么样');
    expect(second?.agentText.endsWith('那今天再试一次')).toBe(true);
  });

  it('keeps the quoted-reply block for direct messages without touching the window', async () => {
    const im = { getOwnerUserId: () => 'zhangsan' } as unknown as WecomIM;
    const adapter = buildWecomAdapter(im, interactions, CONFIG);
    const prepared = await adapter.prepareAgentTurnText?.({
      channelName: 'wecom',
      senderId: 'zhangsan',
      chatId: 'zhangsan',
      contextId: 'aibot-1',
      messageId: 'dm-1',
      text: '这个呢',
      replyContext: { author: 'lisi', text: '原消息' },
      attachments: [],
      unsupported: [],
    });
    expect(prepared?.agentText).toContain('<reply_context>');
    expect(prepared?.agentText.endsWith('这个呢')).toBe(true);
    expect(prepared?.replyContext).toEqual({ author: 'lisi', text: '原消息' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM hook_group_messages').get()).toEqual({ n: 0 });
  });
});
