import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock('electron', () => ({
  net: {
    request: requestMock,
  },
}));

vi.mock('../manifestService', () => ({
  getBaseUrl: () => 'https://cdn.example.test/xdt-maker',
  getPlatformKey: () => 'win32-x64',
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

class MockRequest extends EventEmitter {
  abort = vi.fn();
  end = vi.fn();
}

class MockResponse extends EventEmitter {
  statusCode = 200;
}

describe('releaseNotesService', () => {
  beforeEach(() => {
    vi.resetModules();
    requestMock.mockReset();
  });

  it('按 UTF-8 流式解码跨 chunk 的中文字符，避免生成替换字符', async () => {
    const request = new MockRequest();
    const response = new MockResponse();
    requestMock.mockReturnValue(request);

    const { fetchReleaseNotes } = await import('../releaseNotesService');
    const promise = fetchReleaseNotes('0.0.122');

    request.emit('response', response);

    const payload = JSON.stringify({
      version: '0.0.122',
      date: '2026-06-23',
      contributors: ['Carol'],
      sections: [
        {
          title: 'Bug Fixes',
          items: [
            {
              name: 'Carol',
              list: [
                '修复远程会话在网络断断续续时消息可能被错误合并或时间错乱的问题，断线恢复后能正确保留期间收到的新消息',
              ],
            },
          ],
        },
      ],
    });

    const bytes = Buffer.from(payload, 'utf8');
    const splitAt = bytes.indexOf(Buffer.from('线', 'utf8')) + 1;
    response.emit('data', bytes.subarray(0, splitAt));
    response.emit('data', bytes.subarray(splitAt));
    response.emit('end');

    const notes = await promise;
    const item = notes?.sections?.[0]?.items[0]?.list[0];
    expect(item).toContain('断线恢复');
    expect(item).not.toContain('�');
  });

  it('无可渲染内容的 200 payload 按失败处理且不写缓存(重试会重新请求 CDN)', async () => {
    const { fetchReleaseNotes } = await import('../releaseNotesService');

    const emptyPayload = JSON.stringify({
      version: '0.1.20',
      date: '2026-07-30',
      contributors: [],
      topics: [{ title: '   ', text: '' }],
    });

    const fetchOnce = async () => {
      const request = new MockRequest();
      const response = new MockResponse();
      requestMock.mockReturnValueOnce(request);
      const promise = fetchReleaseNotes('0.1.20');
      request.emit('response', response);
      response.emit('data', Buffer.from(emptyPayload, 'utf8'));
      response.emit('end');
      return promise;
    };

    expect(await fetchOnce()).toBeNull();
    expect(await fetchOnce()).toBeNull();
    // 两次都真正发起了请求——坏 payload 没有进程级缓存,CDN 修正后可生效。
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('sections 非空但全部畸形(无任何有效 bullet)同样按失败处理不缓存', async () => {
    const { fetchReleaseNotes } = await import('../releaseNotesService');

    const payload = JSON.stringify({
      version: '0.1.21',
      date: '2026-07-31',
      contributors: ['A'],
      sections: [
        { title: 'Bug Fixes', items: [{ name: 'X' }, { name: 'Y', list: [42] }] },
        { items: [{ name: 'Z', list: ['有内容但缺 title'] }] },
      ],
    });

    const fetchOnce = async () => {
      const request = new MockRequest();
      const response = new MockResponse();
      requestMock.mockReturnValueOnce(request);
      const promise = fetchReleaseNotes('0.1.21');
      request.emit('response', response);
      response.emit('data', Buffer.from(payload, 'utf8'));
      response.emit('end');
      return promise;
    };

    expect(await fetchOnce()).toBeNull();
    expect(await fetchOnce()).toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
