/**
 * 群 lane 出站路由: open_id / chat_id / reply 三分支与回挂锚点领取语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const larkMocks = vi.hoisted(() => {
  const create = vi.fn(async (payload: { params: unknown; data: { content: string } }) => {
    void payload;
    return { data: { message_id: 'om_created' } };
  });
  const reply = vi.fn(async (payload: { path: unknown; data: unknown }) => {
    void payload;
    return { data: { message_id: 'om_replied' } };
  });
  return { create, reply };
});

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    im = {
      v1: {
        message: { create: larkMocks.create, reply: larkMocks.reply },
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
