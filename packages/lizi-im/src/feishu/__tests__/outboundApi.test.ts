/**
 * Agent 直通 Open API(cindy_feishu_bot 轮次内工具)的 transport 层: callApi 的路径 / 参数
 * 透传与错误折叠(HTTP 失败、2xx 带非零业务码都成 FeishuApiError), 以及几个薄封装的路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const larkMocks = vi.hoisted(() => ({
  request: vi.fn<(payload: Record<string, unknown>) => Promise<unknown>>(async () => ({ code: 0, msg: 'ok', data: {} })),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    request = larkMocks.request;
    im = { v1: {} };
  },
  Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
}));

vi.mock('../moduleScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../moduleScope.js')>()),
  getLog: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as outbound from '../outbound.js';

describe('feishu outbound callApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    larkMocks.request.mockResolvedValue({ code: 0, msg: 'ok', data: {} });
    outbound.unbindClient();
    outbound.bindClient({ appId: 'cli_test', appSecret: 'secret', service: 'feishu' });
  });

  it('透传 method / 相对路径 / params / data, 返回响应体', async () => {
    larkMocks.request.mockResolvedValueOnce({ code: 0, msg: 'success', data: { name: '产品群' } });
    const res = await outbound.callApi({
      method: 'GET',
      path: '/open-apis/im/v1/chats/oc_1',
      params: { user_id_type: 'open_id' },
    });
    expect(res).toEqual({ code: 0, msg: 'success', data: { name: '产品群' } });
    expect(larkMocks.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'open-apis/im/v1/chats/oc_1',
      params: { user_id_type: 'open_id' },
    });
  });

  it('2xx 带非零业务码 → FeishuApiError(code, httpStatus=200)', async () => {
    larkMocks.request.mockResolvedValueOnce({ code: 230001, msg: 'bot has no permission' });
    await expect(outbound.pinMessage('om_1')).rejects.toMatchObject({
      name: 'FeishuApiError',
      code: 230001,
      httpStatus: 200,
      apiMsg: 'bot has no permission',
    });
    expect(larkMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: 'open-apis/im/v1/pins', data: { message_id: 'om_1' } }),
    );
  });

  it('HTTP 失败(axios 形态)折成 FeishuApiError(code, httpStatus)', async () => {
    larkMocks.request.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 403'), {
        response: { status: 403, data: { code: 99991663, msg: 'permission denied' } },
      }),
    );
    await expect(outbound.getChatInfo('oc_1')).rejects.toMatchObject({
      name: 'FeishuApiError',
      code: 99991663,
      httpStatus: 403,
      apiMsg: 'permission denied',
    });
  });

  it('listChatMembers 整理成员页, getMessage 取 items[0], unpin / recall 走 DELETE', async () => {
    larkMocks.request.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ member_id: 'ou_a', name: 'A' }, { name: 'no-id' }], member_total: 2, has_more: true, page_token: 'pt2' },
    });
    expect(await outbound.listChatMembers('oc_1', { pageToken: 'pt1', pageSize: 500 })).toEqual({
      items: [{ memberId: 'ou_a', name: 'A' }],
      memberTotal: 2,
      nextPageToken: 'pt2',
    });
    expect(larkMocks.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'open-apis/im/v1/chats/oc_1/members',
        params: { member_id_type: 'open_id', page_size: '100', page_token: 'pt1' },
      }),
    );
    larkMocks.request.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_1' }] } });
    expect(await outbound.getMessage('om_1')).toEqual({ message_id: 'om_1', chat_id: 'oc_1' });
    await outbound.unpinMessage('om_1');
    expect(larkMocks.request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'DELETE', url: 'open-apis/im/v1/pins/om_1' }));
    await outbound.recallMessage('om_2');
    expect(larkMocks.request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'DELETE', url: 'open-apis/im/v1/messages/om_2' }));
  });
});
