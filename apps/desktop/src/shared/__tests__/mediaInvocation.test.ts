import { describe, expect, it } from 'vitest';
import { parseMediaInvocationGuide, parsePreparedMediaInvocationGuide } from '../mediaInvocation.js';

const operation = {
  capability: 'video.generate',
  request: {
    method: 'POST', path: '/videos/generations', bodyModelPath: ['model'],
    timeoutMs: 1_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024,
  },
  response: {
    mode: 'sync', media: [{ path: ['url'], encoding: 'url', kind: 'video', allowedUrlHosts: ['example.com'] }],
  },
  instructions: '按协议提交请求', exampleBody: { prompt: 'hello' },
  inputSchema: { type: 'object' }, officialDocs: 'https://example.com/videos',
};
const protocol = { schemaVersion: 1, guideId: 'opaque-server-id', revision: 'server-revision' };

describe('媒体协议说明与本地执行绑定', () => {
  it('接受无连接的 Server Guide，并丢弃旧响应附带的连接信息', () => {
    expect(parseMediaInvocationGuide({ ...protocol, operations: [operation] })).toMatchObject({ ok: true });
    const parsed = parseMediaInvocationGuide({
      ...protocol, connection: { providerId: 'xd' }, operations: [operation],
    });
    expect(parsed.ok && parsed.value).not.toHaveProperty('connection');
  });

  it('单独保存协议版本和本地视频连接摘要', () => {
    const snapshot = {
      ...protocol, modelId: 'private-video', ...operation,
      binding: { providerId: 'relay', executor: 'provider-video', connectionRevision: '1:connection' },
    };
    expect(parsePreparedMediaInvocationGuide(JSON.parse(JSON.stringify(snapshot))))
      .toEqual({ ok: true, value: snapshot });
    expect(parsePreparedMediaInvocationGuide({ ...snapshot, binding: { providerId: 'relay', executor: 'provider-video' } }))
      .toMatchObject({ ok: false });
  });

  it('仅解码旧视频任务时把旧 revision 还原为连接摘要', () => {
    const parsed = parsePreparedMediaInvocationGuide({
      ...protocol, guideId: 'cindy-provider-xai-video-v1', revision: '1:old-connection',
      modelId: 'private-video', connection: { providerId: 'relay' }, ...operation,
    });
    expect(parsed).toMatchObject({ ok: true, value: {
      binding: { providerId: 'relay', executor: 'provider-video', connectionRevision: '1:old-connection' },
    } });
    expect(parsed.ok && parsed.value).not.toHaveProperty('connection');
  });
});
