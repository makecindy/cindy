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

  it('只有 contentByLocale 的多语言 payload 可加载并继续按 version 缓存', async () => {
    const request = new MockRequest();
    const response = new MockResponse();
    requestMock.mockReturnValueOnce(request);

    const { fetchReleaseNotes } = await import('../releaseNotesService');
    const first = fetchReleaseNotes('0.1.23');
    request.emit('response', response);
    response.emit('data', Buffer.from(JSON.stringify({
      version: '0.1.23',
      date: '2026-08-06',
      githash: '0123456789abcdef0123456789abcdef01234567',
      contentByLocale: {
        en: {
          topics: [{ id: 'voice-input', title: 'Voice input', text: 'More reliable.' }],
        },
      },
    }), 'utf8'));
    response.emit('end');

    const notes = await first;
    expect(notes?.contentByLocale?.en?.topics?.[0]?.id).toBe('voice-input');
    expect(await fetchReleaseNotes('0.1.23')).toBe(notes);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('同一 version 的并发请求复用同一个在途 CDN 请求', async () => {
    const request = new MockRequest();
    const response = new MockResponse();
    requestMock.mockReturnValueOnce(request);

    const { fetchReleaseNotes } = await import('../releaseNotesService');
    const first = fetchReleaseNotes('0.1.25');
    const second = fetchReleaseNotes('0.1.25');

    expect(requestMock).toHaveBeenCalledTimes(1);
    request.emit('response', response);
    response.emit('data', Buffer.from(JSON.stringify({
      version: '0.1.25',
      date: '2026-08-06',
      topics: [{ title: '并发缓存', text: '只请求一次。' }],
    }), 'utf8'));
    response.emit('end');

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('localized 内容全部为空或畸形时按失败处理且不缓存', async () => {
    const { fetchReleaseNotes } = await import('../releaseNotesService');
    const payload = JSON.stringify({
      version: '0.1.24',
      date: '2026-08-06',
      contentByLocale: {
        'zh-CN': { topics: [{ title: '   ', text: '' }] },
        en: { topics: [] },
      },
    });

    const fetchOnce = async () => {
      const request = new MockRequest();
      const response = new MockResponse();
      requestMock.mockReturnValueOnce(request);
      const promise = fetchReleaseNotes('0.1.24');
      request.emit('response', response);
      response.emit('data', Buffer.from(payload, 'utf8'));
      response.emit('end');
      return promise;
    };

    expect(await fetchOnce()).toBeNull();
    expect(await fetchOnce()).toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  describe('重试逻辑', () => {
    it('网络错误后重试成功', async () => {
      vi.useFakeTimers();
      const { fetchReleaseNotes } = await import('../releaseNotesService');

      const req1 = new MockRequest();
      const req2 = new MockRequest();
      const resp2 = new MockResponse();
      requestMock.mockReturnValueOnce(req1).mockReturnValueOnce(req2);

      const promise = fetchReleaseNotes('0.2.1');
      // 第一次：网络错误（retryable）
      req1.emit('error', new Error('ECONNRESET'));

      // 推进重试延迟 1s + 让微任务执行
      await vi.advanceTimersByTimeAsync(1_000);
      // 再多推进一帧确保 fetchCdnJsonOnce 的 Promise 链已执行到 requestMock()
      await vi.advanceTimersByTimeAsync(0);

      // 第二次：成功
      req2.emit('response', resp2);
      resp2.emit('data', Buffer.from(JSON.stringify({
        version: '0.2.1',
        date: '2026-08-10',
        topics: [{ title: '重试成功', text: '第二次请求返回了数据。' }],
      }), 'utf8'));
      resp2.emit('end');

      const notes = await promise;
      expect(notes).not.toBeNull();
      expect(notes?.version).toBe('0.2.1');
      expect(requestMock).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('HTTP 404 不重试，直接返回 null', async () => {
      const { fetchReleaseNotes } = await import('../releaseNotesService');

      const req = new MockRequest();
      const resp = new MockResponse();
      resp.statusCode = 404;
      requestMock.mockReturnValueOnce(req);

      const promise = fetchReleaseNotes('0.2.2');
      req.emit('response', resp);

      const notes = await promise;
      expect(notes).toBeNull();
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('全部重试耗尽后返回 null', async () => {
      vi.useFakeTimers();
      const { fetchReleaseNotes } = await import('../releaseNotesService');

      // 4 次全部网络错误（首次 + 3 次重试 = 4 次）
      const reqs = Array.from({ length: 4 }, () => new MockRequest());
      reqs.forEach((r) => requestMock.mockReturnValueOnce(r));

      const promise = fetchReleaseNotes('0.2.3');

      for (let i = 0; i < 4; i++) {
        reqs[i].emit('error', new Error('ETIMEDOUT'));
        // 推进重试延迟（最后一次不需要，但无害）
        if (i < 3) {
          // 指数退避：1s, 2s, 4s
          const delay = 1000 * 2 ** i;
          await vi.advanceTimersByTimeAsync(delay);
          await vi.advanceTimersByTimeAsync(0);
        }
      }

      const notes = await promise;
      expect(notes).toBeNull();
      expect(requestMock).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    it('超时视为可重试，第二次成功', async () => {
      vi.useFakeTimers();
      const { fetchReleaseNotes } = await import('../releaseNotesService');

      const req1 = new MockRequest();
      const req2 = new MockRequest();
      const resp2 = new MockResponse();
      requestMock.mockReturnValueOnce(req1).mockReturnValueOnce(req2);

      const promise = fetchReleaseNotes('0.2.4');

      // 快进到 15s 超时
      await vi.advanceTimersByTimeAsync(15_000);
      // 推进重试延迟 1s
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);

      // 第二次成功
      req2.emit('response', resp2);
      resp2.emit('data', Buffer.from(JSON.stringify({
        version: '0.2.4',
        date: '2026-08-10',
        topics: [{ title: '超时重试', text: '第二次成功。' }],
      }), 'utf8'));
      resp2.emit('end');

      const notes = await promise;
      expect(notes).not.toBeNull();
      expect(notes?.version).toBe('0.2.4');
      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(req1.abort).toHaveBeenCalled();

      vi.useRealTimers();
    });
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
