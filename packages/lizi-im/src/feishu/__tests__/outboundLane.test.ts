/**
 * 群 lane 出站路由: open_id / chat_id / reply 三分支与回挂锚点领取语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const larkMocks = vi.hoisted(() => {
  const create = vi.fn(async (payload: { params: unknown; data: { content: string } }) => {
    void payload;
    return { data: { message_id: 'om_created' } };
  });
  // 记录每次调用的 this(各自的 message 命名空间对象, 每个 Client 实例一个)—
  // 用于断言 openThread 的 reply/get/delete 是否 pin 在同一个 client 上。
  const replyOwners: unknown[] = [];
  const getOwners: unknown[] = [];
  const deleteOwners: unknown[] = [];
  const reply = vi.fn(
    function (
      this: unknown,
      payload: {
        path: unknown;
        data: unknown;
      },
    ): Promise<{ data: { message_id: string; thread_id?: string } }> {
      replyOwners.push(this);
      void payload;
      return Promise.resolve({ data: { message_id: 'om_replied', thread_id: 'omt_r1' } });
    },
  );
  const deleteMessage = vi.fn(
    function (this: unknown): Promise<{ code?: number; msg?: string; data?: {} }> {
      deleteOwners.push(this);
      return Promise.resolve({ data: {} });
    },
  );
  const getMessage = vi.fn(
    function (
      this: unknown,
      payload: { path: unknown },
    ): Promise<{ data: { items: Array<{ thread_id?: string }> } }> {
      getOwners.push(this);
      void payload;
      return Promise.resolve({ data: { items: [] } });
    },
  );
  return { create, reply, deleteMessage, getMessage, replyOwners, getOwners, deleteOwners };
});

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    im = {
      v1: {
        message: {
          create: larkMocks.create,
          reply: larkMocks.reply,
          delete: larkMocks.deleteMessage,
          get: larkMocks.getMessage,
        },
        messageReaction: { create: vi.fn(), delete: vi.fn() },
        image: { create: vi.fn() },
      },
      file: { create: vi.fn() },
    };
  },
  Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
}));

vi.mock('../ownerGuard.js', () => ({
  firstAllowed: vi.fn(() => 'ou_owner'),
  check: vi.fn(() => true),
}));

vi.mock('../moduleScope.js', () => ({
  getLog: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import * as outbound from '../outbound.js';

const creds = { appId: 'cli_test', appSecret: 'secret', service: 'feishu' as const };

describe('feishu outbound lane routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outbound.unbindClient(); // clears lane anchors
    outbound.bindClient(creds);
  });

  it('sends p2p messages via open_id unchanged', async () => {
    await outbound.sendText('ou_someone', 'hi');
    expect(larkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'open_id' },
        data: expect.objectContaining({ receive_id: 'ou_someone' }),
      }),
    );
    expect(larkMocks.reply).not.toHaveBeenCalled();
  });

  it('group lane: first send replies to the trigger anchor, later sends go to chat_id', async () => {
    outbound.pushReplyAnchor('g/oc_group1', 'om_trigger1');

    await outbound.sendText('g/oc_group1', 'first');
    expect(larkMocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({ path: { message_id: 'om_trigger1' } }),
    );

    await outbound.sendText('g/oc_group1', 'second');
    expect(larkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'chat_id' },
        data: expect.objectContaining({ receive_id: 'oc_group1' }),
      }),
    );
  });

  it('topic lane: every send goes through the reply anchor', async () => {
    outbound.pushReplyAnchor('g/oc_group1/omt_t1', 'om_topic_trigger');

    await outbound.sendText('g/oc_group1/omt_t1', 'a');
    await outbound.sendText('g/oc_group1/omt_t1', 'b');
    expect(larkMocks.reply).toHaveBeenCalledTimes(2);
    expect(larkMocks.create).not.toHaveBeenCalled();
  });

  it('topic lane without an anchor rejects instead of leaking into the main chat', async () => {
    await expect(outbound.sendText('g/oc_group1/omt_t1', 'x')).rejects.toThrow(/no reply anchor/);
    expect(larkMocks.create).not.toHaveBeenCalled();
  });

  it('sendCardRaw advances to the next queued anchor per round', async () => {
    outbound.pushReplyAnchor('g/oc_g', 'om_q1');
    outbound.pushReplyAnchor('g/oc_g', 'om_q2');

    await outbound.sendCardRaw('g/oc_g', { body: 1 });
    expect(larkMocks.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: { message_id: 'om_q1' } }),
    );

    await outbound.sendCardRaw('g/oc_g', { body: 2 });
    expect(larkMocks.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: { message_id: 'om_q2' } }),
    );
  });

  it('delivers permission cards to the owner DM with the note prefixed', async () => {
    outbound.pushReplyAnchor('g/oc_g', 'om_t');
    await outbound.sendInteractive(
      'g/oc_g',
      { body: '要执行危险操作', buttons: [] },
      { deliverToOwnerDm: true, ownerDmNote: '来自群聊的授权请求' },
    );
    expect(larkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'open_id' },
        data: expect.objectContaining({ receive_id: 'ou_owner' }),
      }),
    );
    const createArg = larkMocks.create.mock.calls[0]?.[0];
    expect(JSON.stringify(JSON.parse(createArg?.data.content ?? '{}'))).toContain(
      '来自群聊的授权请求',
    );
    expect(larkMocks.reply).not.toHaveBeenCalled();
  });

  it('ignores deliverToOwnerDm for non-lane userIds', async () => {
    await outbound.sendInteractive(
      'ou_dm_user',
      { body: 'hi', buttons: [] },
      { deliverToOwnerDm: true },
    );
    expect(larkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ receive_id: 'ou_dm_user' }),
      }),
    );
  });

  it('openThread replies with a patchable card + reply_in_thread + uuid, returns opened', async () => {
    const res = await outbound.openThread('om_root1');
    expect(larkMocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_root1' },
        data: expect.objectContaining({
          msg_type: 'interactive',
          reply_in_thread: true,
          uuid: 'om_root1',
        }),
      }),
    );
    expect(res).toEqual({ kind: 'opened', messageId: 'om_replied', threadId: 'omt_r1' });
  });

  it('openThread is idempotent per trigger message (duplicate delivery opens no second topic)', async () => {
    const first = outbound.openThread('om_root2');
    const second = outbound.openThread('om_root2');
    expect(await first).toEqual({ kind: 'opened', messageId: 'om_replied', threadId: 'omt_r1' });
    expect(await second).toEqual({ kind: 'opened', messageId: 'om_replied', threadId: 'omt_r1' });
    // 并发/重复调用只打一次 API — 飞书重投同一条 @ 事件不会开出多个话题。
    expect(larkMocks.reply).toHaveBeenCalledTimes(1);
  });

  it('openThread recovers the thread_id via message.get when the reply response lacks it', async () => {
    larkMocks.reply.mockResolvedValueOnce({ data: { message_id: 'om_replied' } });
    larkMocks.getMessage.mockResolvedValueOnce({
      data: { items: [{ thread_id: 'omt_recovered' }] },
    });
    const res = await outbound.openThread('om_root3');
    expect(res).toEqual({ kind: 'opened', messageId: 'om_replied', threadId: 'omt_recovered' });
    expect(larkMocks.getMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_replied' },
    });
    expect(larkMocks.deleteMessage).not.toHaveBeenCalled();
  });

  it('openThread recalls the opener and returns degraded when thread_id is unrecoverable', async () => {
    larkMocks.reply.mockResolvedValueOnce({ data: { message_id: 'om_replied' } });
    larkMocks.getMessage.mockResolvedValueOnce({ data: { items: [] } });
    await expect(outbound.openThread('om_root4')).resolves.toEqual({ kind: 'degraded' });
    // 开场白已发出但拿不到话题 id: 撤回它再降级, 不让「回复都在里面」误导。
    expect(larkMocks.deleteMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_replied' },
    });
  });

  it('openThread recalls the opener and returns degraded when message.get itself fails', async () => {
    larkMocks.reply.mockResolvedValueOnce({ data: { message_id: 'om_replied' } });
    larkMocks.getMessage.mockRejectedValueOnce(new Error('get failed'));
    await expect(outbound.openThread('om_root5')).resolves.toEqual({ kind: 'degraded' });
    expect(larkMocks.deleteMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_replied' },
    });
  });

  it('openThread returns orphaned (not degraded) when recall fails too', async () => {
    larkMocks.reply.mockResolvedValueOnce({ data: { message_id: 'om_replied' } });
    larkMocks.getMessage.mockRejectedValueOnce(new Error('get failed'));
    larkMocks.deleteMessage.mockRejectedValueOnce(new Error('delete failed'));
    await expect(outbound.openThread('om_root6')).resolves.toEqual({
      kind: 'orphaned',
      openerMessageId: 'om_replied',
    });
  });

  it('openThread treats a business-error delete response as failed recall (orphaned)', async () => {
    larkMocks.reply.mockResolvedValueOnce({ data: { message_id: 'om_replied' } });
    larkMocks.getMessage.mockRejectedValueOnce(new Error('get failed'));
    // SDK 对业务错误不抛异常 — 2xx 响应带非零 code 时撤回并未成功。
    larkMocks.deleteMessage.mockResolvedValueOnce({ code: 99991672, msg: 'no permission' });
    await expect(outbound.openThread('om_root7')).resolves.toEqual({
      kind: 'orphaned',
      openerMessageId: 'om_replied',
    });
  });

  it('openThread returns degraded instead of throwing when the API fails', async () => {
    larkMocks.reply.mockRejectedValueOnce(new Error('no thread permission'));
    await expect(outbound.openThread('om_root8')).resolves.toEqual({ kind: 'degraded' });
    expect(larkMocks.deleteMessage).not.toHaveBeenCalled();
  });

  it('evictOpenThreadOutcome drops the cached result so the next call retries the API', async () => {
    // 第一次失败(degraded)会被缓存; 放弃路径 evict 后, 重投应重新打 API。
    larkMocks.reply.mockRejectedValueOnce(new Error('old client gone'));
    await expect(outbound.openThread('om_root9')).resolves.toEqual({ kind: 'degraded' });

    outbound.evictOpenThreadOutcome('om_root9');
    const retried = await outbound.openThread('om_root9');
    expect(retried).toEqual({ kind: 'opened', messageId: 'om_replied', threadId: 'omt_r1' });
    expect(larkMocks.reply).toHaveBeenCalledTimes(2);
  });

  it('recallOwnMessage returns true on success and false on business error or throw', async () => {
    await expect(outbound.recallOwnMessage('om_ok')).resolves.toBe(true);
    larkMocks.deleteMessage.mockResolvedValueOnce({ code: 99991672, msg: 'rejected' });
    await expect(outbound.recallOwnMessage('om_rejected')).resolves.toBe(false);
    larkMocks.deleteMessage.mockRejectedValueOnce(new Error('network down'));
    await expect(outbound.recallOwnMessage('om_throw')).resolves.toBe(false);
  });

  it('openThread pins recovery/recall to the client that created the opener', async () => {
    const creds2 = { appId: 'cli_other', appSecret: 'secret2', service: 'feishu' as const };
    const replyBase = larkMocks.replyOwners.length;
    const getBase = larkMocks.getOwners.length;
    const deleteBase = larkMocks.deleteOwners.length;
    larkMocks.reply.mockImplementationOnce(function (this: unknown) {
      larkMocks.replyOwners.push(this);
      return Promise.resolve({ data: { message_id: 'om_replied' } });
    });
    // message.get 执行期间换账号: bindClient(creds2) 后返回空 items —
    // 补查与撤回必须仍走创建开场白的那条连接, 不能打到新账号的 client。
    larkMocks.getMessage.mockImplementationOnce(function (this: unknown, payload: { path: unknown }) {
      larkMocks.getOwners.push(this);
      void payload;
      outbound.bindClient(creds2);
      return Promise.resolve({ data: { items: [] } });
    });
    await expect(outbound.openThread('om_pin1')).resolves.toEqual({ kind: 'degraded' });

    const replyCtx = larkMocks.replyOwners[replyBase];
    const getCtx = larkMocks.getOwners[getBase];
    const delCtx = larkMocks.deleteOwners[deleteBase];
    expect(getCtx).toBe(replyCtx);
    expect(delCtx).toBe(replyCtx);
  });

  it('unbindClient clears held anchors (no cross-generation mismatch)', async () => {
    outbound.pushReplyAnchor('g/oc_g', 'om_old');
    outbound.unbindClient();
    outbound.bindClient(creds);
    await outbound.sendText('g/oc_g', 'later');
    expect(larkMocks.reply).not.toHaveBeenCalled();
    expect(larkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ params: { receive_id_type: 'chat_id' } }),
    );
  });
});

describe('feishu card lane registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outbound.unbindClient(); // clears lane anchors + card registry
    outbound.bindClient(creds);
  });

  it('registers topic-lane cards and resolves them back to the same lane', async () => {
    outbound.pushReplyAnchor('g/oc_group1/omt_t1', 'om_topic_trigger');
    const { messageId } = await outbound.sendInteractive('g/oc_group1/omt_t1', {
      body: 'pick',
      buttons: [{ id: 'control:exit', label: '退出', payload: { botAppId: 'cli_x' } }],
    });
    expect(messageId).toBe('om_replied');
    expect(outbound.resolveCardLane('om_replied', 'oc_group1')).toBe('g/oc_group1/omt_t1');
  });

  it('registers plain group-lane cards (openThread 失败降级路径)', async () => {
    outbound.pushReplyAnchor('g/oc_group1', 'om_trigger1');
    const { messageId } = await outbound.sendInteractive('g/oc_group1', {
      body: 'pick',
      buttons: [{ id: 'control:exit', label: '退出' }],
    });
    expect(outbound.resolveCardLane(messageId, 'oc_group1')).toBe('g/oc_group1');
  });

  it('does not register p2p (DM) cards — callback keeps the open_id', async () => {
    await outbound.sendInteractive('ou_dm_user', {
      body: 'hi',
      buttons: [{ id: 'control:exit', label: '退出' }],
    });
    expect(outbound.resolveCardLane('om_created', 'ou_dm_user')).toBeNull();
  });

  it('does not register deliverToOwnerDm cards (they live in the owner DM)', async () => {
    outbound.pushReplyAnchor('g/oc_g', 'om_t');
    const { messageId } = await outbound.sendInteractive(
      'g/oc_g',
      { body: '要执行危险操作', buttons: [{ id: 'permission:allow:once', label: '允许' }] },
      { deliverToOwnerDm: true },
    );
    expect(larkMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receive_id: 'ou_owner' }) }),
    );
    expect(outbound.resolveCardLane(messageId, 'oc_g')).toBeNull();
  });

  it('rejects a lane lookup whose chatId does not match the callback chat', async () => {
    outbound.pushReplyAnchor('g/oc_group1/omt_t1', 'om_topic_trigger');
    await outbound.sendInteractive('g/oc_group1/omt_t1', {
      body: 'pick',
      buttons: [{ id: 'control:exit', label: '退出' }],
    });
    expect(outbound.resolveCardLane('om_replied', 'oc_another_group')).toBeNull();
  });

  it('unbindClient clears the registry (no cross-generation mismatch)', async () => {
    outbound.pushReplyAnchor('g/oc_group1/omt_t1', 'om_topic_trigger');
    await outbound.sendInteractive('g/oc_group1/omt_t1', {
      body: 'pick',
      buttons: [{ id: 'control:exit', label: '退出' }],
    });
    outbound.unbindClient();
    expect(outbound.resolveCardLane('om_replied', 'oc_group1')).toBeNull();
  });
});
