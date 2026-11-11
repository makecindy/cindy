/** Unit: FeishuIM.readHistoryImages must return the requested screenshot, never another
 * chat/topic or a late download after account change. Existing inbound tests do not invoke
 * on-demand history; minimal regression is one om_* image outside the initial context window. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ epoch: 1, get: vi.fn(), download: vi.fn() }));
vi.mock('../outbound.js', () => ({
  getAccountEpoch: () => f.epoch,
  getMessage: f.get,
}));
import { FeishuIM } from '../index.js';

function read() {
  return FeishuIM.prototype.readHistoryImages.call(
    { downloadMessageAttachments: f.download } as unknown as FeishuIM,
    'om_image',
    'oc_chat',
    'omt_topic',
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  f.epoch = 1;
  f.get.mockResolvedValue({
    chat_id: 'oc_chat',
    thread_id: 'omt_topic',
    msg_type: 'image',
    body: { content: JSON.stringify({ image_key: 'img_key' }) },
  });
  f.download.mockResolvedValue({
    attachments: [{ url: 'cindy-media://image' }],
  });
});
describe('native message image lookup', () => {
  it('passes the exact resource owner to the existing downloader', async () => {
    expect(await read()).toEqual([{ url: 'cindy-media://image' }]);
    expect(f.download).toHaveBeenCalledWith('om_image', [{ kind: 'image', imageKey: 'img_key' }]);
  });
  it.each([
    { chat_id: 'other', thread_id: 'omt_topic' },
    { chat_id: 'oc_chat', thread_id: '' },
    { chat_id: 'oc_chat', thread_id: 'omt_topic', deleted: true },
  ])('rejects inaccessible source %j before downloading', async (source) => {
    f.get.mockResolvedValue({
      ...source,
      msg_type: 'image',
      body: { content: '{"image_key":"img"}' },
    });
    expect(await read()).toEqual([]);
    expect(f.download).not.toHaveBeenCalled();
  });
  it.each(['metadata', 'download'])('rejects connection replacement during %s', async (phase) => {
    if (phase === 'metadata')
      f.get.mockImplementation(async () => {
        f.epoch++;
        return null;
      });
    else
      f.download.mockImplementation(async () => {
        f.epoch++;
        return { attachments: [] };
      });
    await expect(read()).rejects.toThrow('HISTORY_CONNECTION_CHANGED');
  });
});
