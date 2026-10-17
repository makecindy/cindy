/**
 * 「消息平台」页的隐藏任务小节(botImLaneRuntime):
 *   - 列表只含这条连接的落点(伙伴主任务 + 本连接 route key 前缀下的专线), 同一伙伴的
 *     其它连接、同渠道另一个机器人的专线都不混进来;
 *   - 「重新开始」只接受这条连接自己的任务, 渲染端传来的其它任务 id 不会被重启。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotImConnectionRecord } from '../../../../shared/botImConnection';

const h = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
}));

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../localDb/client/current', () => ({ getDbClient: vi.fn() }));
vi.mock('../../../localDb/schema', () => ({ botSessionLinks: {}, messages: {}, sessions: {} }));
vi.mock('../botImConnectionStore', () => ({
  readBotImConnection: (id: string) => h.records.get(id) ?? null,
}));

import {
  __testing,
  configureBotImLaneRuntime,
  listBotImConnectionLanes,
  resetBotImConnectionLane,
  type BotImLaneActivity,
  type BotImLaneLink,
} from '../botImLaneRuntime';

const TELEGRAM: BotImConnectionRecord = {
  id: 'conn-tg',
  botId: 'bot-a',
  channel: 'telegram',
  botContextId: '777',
  createdAt: 1,
};

const LINKS: BotImLaneLink[] = [
  { sessionId: 's-main', role: 'canonical', routeKey: null },
  { sessionId: 's-group', role: 'channel', routeKey: 'im:telegram:777:g:-1001' },
  { sessionId: 's-topic', role: 'channel', routeKey: 'im:telegram:777:g:-1001:t:42' },
  { sessionId: 's-guest', role: 'channel', routeKey: 'im:telegram:777:dm:555' },
  // 同一伙伴的飞书连接 / 同渠道另一个机器人: 不属于这条连接。
  { sessionId: 's-feishu', role: 'channel', routeKey: 'im:feishu:cli_x:g:oc_1' },
  { sessionId: 's-other-bot', role: 'channel', routeKey: 'im:telegram:7770:g:-1001' },
];

function activity(over: Partial<BotImLaneActivity> = {}): BotImLaneActivity {
  return {
    lastActivityAt: 1_000,
    lastTurnFailed: false,
    contextMessageCount: 0,
    origin: { chatName: null, senderName: null },
    ...over,
  };
}

const ACTIVITY: Record<string, BotImLaneActivity> = {
  's-main': activity({ lastActivityAt: 100, contextMessageCount: 3 }),
  's-group': activity({ lastActivityAt: 5_000, origin: { chatName: 'Stale name', senderName: 'Ann' } }),
  's-topic': activity({ lastActivityAt: 9_000, lastTurnFailed: true, origin: { chatName: 'Release room', senderName: 'Bo' } }),
  's-guest': activity({ lastActivityAt: 2_000, contextMessageCount: 7, origin: { chatName: null, senderName: 'Cleo' } }),
};

const listLinks = vi.fn(async (botId: string) => (botId === TELEGRAM.botId ? LINKS : []));
const readActivity = vi.fn(async (sessionId: string) => ACTIVITY[sessionId] ?? activity());
const restartSession = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
const knownGroups = vi.fn(async () => [{ chatId: '-1001', chatName: 'Launch crew' }]);

beforeEach(() => {
  vi.clearAllMocks();
  h.records.clear();
  h.records.set(TELEGRAM.id, TELEGRAM);
  __testing.setStore({ listLinks, readActivity });
  configureBotImLaneRuntime({ isTurnRunning: (id) => id === 's-guest', restartSession });
});

describe('botImLaneRuntime', () => {
  it('lists only the lanes of this connection, with names, state and order from existing data', async () => {
    const payload = await listBotImConnectionLanes(TELEGRAM.id, { knownGroups });

    expect(listLinks).toHaveBeenCalledWith('bot-a');
    expect(readActivity).not.toHaveBeenCalledWith('s-feishu');
    expect(readActivity).not.toHaveBeenCalledWith('s-other-bot');
    expect(payload.lanes.map((lane) => [lane.sessionId, lane.kind, lane.name, lane.state])).toEqual([
      ['s-main', 'owner-dm', null, 'idle'],
      ['s-topic', 'topic', 'Launch crew', 'failed'],
      ['s-group', 'group', 'Launch crew', 'idle'],
      ['s-guest', 'guest-dm', 'Cleo', 'running'],
    ]);
    expect(payload.lanes.find((lane) => lane.sessionId === 's-topic')).toMatchObject({ chatId: '-1001', threadId: '42' });
    expect(payload.lanes.find((lane) => lane.sessionId === 's-guest')).toMatchObject({ chatId: '555', contextMessageCount: 7 });
  });

  it('a connection that never came online has no lanes yet', async () => {
    h.records.set(TELEGRAM.id, { ...TELEGRAM, botContextId: null });
    await expect(listBotImConnectionLanes(TELEGRAM.id)).resolves.toEqual({ connectionId: TELEGRAM.id, lanes: [] });
    expect(listLinks).not.toHaveBeenCalled();
  });

  it('restarts only a task that belongs to this connection', async () => {
    await expect(resetBotImConnectionLane(TELEGRAM.id, 's-feishu')).rejects.toThrow(/LANE_NOT_FOUND/);
    await expect(resetBotImConnectionLane(TELEGRAM.id, 's-other-bot')).rejects.toThrow(/LANE_NOT_FOUND/);
    await expect(resetBotImConnectionLane('conn-missing', 's-group')).rejects.toThrow(/CONNECTION_NOT_FOUND/);
    expect(restartSession).not.toHaveBeenCalled();

    const payload = await resetBotImConnectionLane(TELEGRAM.id, 's-group');
    expect(restartSession).toHaveBeenCalledExactlyOnceWith('s-group');
    expect(payload.lanes).toHaveLength(4);
  });

  it('reports a failed restart instead of a refreshed list', async () => {
    restartSession.mockRejectedValueOnce(new Error('Bot restart timed out'));
    await expect(resetBotImConnectionLane(TELEGRAM.id, 's-main')).rejects.toThrow(/LANE_RESET_FAILED/);
    expect(restartSession).toHaveBeenCalledWith('s-main');
  });
});
