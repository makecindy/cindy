import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { MediaAsyncPollGuide, ResolvedMediaInvocationGuide } from '../../../shared/mediaInvocation.js';
import { createPluginMediaRequester } from '../pluginMediaRequest.js';

const model = 'vendor/media-model';
const key = 'test-only-gateway-key';
const poll: MediaAsyncPollGuide = {
  method: 'GET', path: '/video/tasks/{taskId}', contentPath: '/video/tasks/{taskId}/content',
  statusPath: ['status'], successValues: ['complete'], failureValues: ['failed'],
  recommendedIntervalMs: 1000, timeoutMs: 1000, maxResponseBytes: 4096, media: [],
};

function setup() {
  const operation = {
    request: {
      method: 'POST' as const, path: '/media/{model}', bodyModelPath: ['model'],
      timeoutMs: 1000, maxRequestBytes: 4096, maxResponseBytes: 4096,
    },
    inputSchema: {}, instructions: '', exampleBody: {},
  };
  const getGuide = vi.fn(async (): Promise<ResolvedMediaInvocationGuide> => ({
    modelId: model,
    guide: {
      schemaVersion: 1, guideId: 'test-guide', revision: '1',
      operations: [
        { ...operation, capability: 'image.generate', response: { mode: 'sync', media: [] } },
        { ...operation, capability: 'video.generate', response: { mode: 'async', taskIdPath: ['task', 'id'], poll } },
      ],
    },
  }));
  const send = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const allowsModel = vi.fn(() => true);
  const onUnauthorized = vi.fn();
  const dispatch = createPluginMediaRequester({
    getConnection: () => ({ baseUrl: 'https://gateway.test', apiKey: key, onUnauthorized }),
    getGuide, allowsModel, send,
  });
  const context = {
    owner: 'owner', instance: 'plugin',
    isCurrent: vi.fn(() => true),
    resolveAudio: vi.fn<() => Promise<string | undefined>>(async () => undefined),
  };
  return { context, dispatch, getGuide, send, allowsModel, onUnauthorized };
}

describe('plugin media gateway dispatch', () => {
  it('uses the trusted route and returns HTTP failure without disclosing the gateway key', async () => {
    const { context, dispatch, send, onUnauthorized } = setup();
    send.mockResolvedValue(Response.json({ error: key }, { status: 401 }));
    expect(await dispatch({
      operation: 'image.generate', model, url: 'https://ignored.test', body: { prompt: 'square' },
    }, context)).toEqual({
      ok: true, status: 401, contentType: 'application/json', encoding: 'utf8',
      body: '{"error":"[redacted]"}',
    });
    expect(send).toHaveBeenCalledExactlyOnceWith('https://gateway.test/media/vendor%2Fmedia-model', expect.objectContaining({
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'square', model }),
    }));
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('rejects a wrong model, conflicting request model, or revoked caller before dispatch', async () => {
    const { context, dispatch, send, allowsModel, getGuide } = setup();
    allowsModel.mockReturnValueOnce(false);
    expect(await dispatch({ operation: 'image.generate', model, body: {} }, context)).toMatchObject({
      ok: false, errorCode: 'PERMISSION_DENIED',
    });
    expect(getGuide).not.toHaveBeenCalled();
    expect(await dispatch({ operation: 'image.generate', model, body: { model: 'different' } }, context)).toMatchObject({
      ok: false, errorCode: 'INVALID_INPUT',
    });
    getGuide.mockImplementationOnce(async () => {
      context.isCurrent.mockReturnValue(false);
      throw new Error('guide failed during a switch');
    });
    expect(await dispatch({ operation: 'image.generate', model, body: {} }, context)).toMatchObject({
      ok: false, errorCode: 'PERMISSION_DENIED',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('polls a video on the original trusted route only for the submitting account and plugin', async () => {
    const { context, dispatch, getGuide, send } = setup();
    send.mockResolvedValueOnce(Response.json({ task: { id: 'task-42' } }, { status: 202 }));
    const created = await dispatch({ operation: 'video.generate', model, body: {} }, context);
    expect(created).toMatchObject({ ok: true, status: 202, jobRef: expect.any(String) });
    if (!created.ok) throw new Error('expected a video receipt');
    const query = { operation: 'video.poll', model, jobRef: created.jobRef };
    for (const otherContext of [{ ...context, instance: 'other' }, { ...context, owner: 'other' }]) {
      expect(await dispatch(query, otherContext)).toMatchObject({ ok: false, errorCode: 'JOB_UNAVAILABLE' });
    }
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValueOnce(Response.json({ status: 'complete' }));
    expect(await dispatch(query, context)).toMatchObject({ ok: true, status: 200, body: '{"status":"complete"}' });
    expect(send.mock.calls[1]).toEqual([
      'https://gateway.test/video/tasks/task-42', expect.objectContaining({ method: 'GET' }),
    ]);
    send.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }));
    expect(await dispatch({ ...query, operation: 'video.content' }, context)).toMatchObject({
      ok: true, encoding: 'base64', body: 'AQID',
    });
    expect(send.mock.calls[2]).toEqual([
      'https://gateway.test/video/tasks/task-42/content', expect.objectContaining({ method: 'GET' }),
    ]);
    expect(getGuide).toHaveBeenCalledOnce();
  });

  it('transcribes only a resolved audio file and returns synthesis bytes intact', async () => {
    const { context, dispatch, send, getGuide } = setup();
    const audioHash = 'a'.repeat(64);
    const request = { operation: 'audio.transcribe', model, audioHash, body: { language: 'en' } };
    expect(await dispatch(request, context)).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(send).not.toHaveBeenCalled();

    const folder = await mkdtemp(join(tmpdir(), 'plugin-media-test-'));
    const audio = join(folder, 'audio.mp3');
    await writeFile(audio, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
    context.resolveAudio.mockResolvedValueOnce(audio);
    send.mockResolvedValueOnce(Response.json({ text: 'hello' }));
    expect(await dispatch(request, context)).toMatchObject({ ok: true, status: 200 });
    expect(context.resolveAudio).toHaveBeenCalledWith(audioHash);
    expect(send.mock.calls[0][0]).toBe('https://gateway.test/v1/audio/transcriptions');
    const form = send.mock.calls[0][1].body as FormData;
    expect(form.get('model')).toBe(model);
    expect(form.get('language')).toBe('en');
    expect(form.get('file')).toEqual(expect.objectContaining({ name: 'audio.mp3', type: 'audio/mpeg' }));

    send.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 1]), { headers: { 'content-type': 'audio/mpeg' } }));
    expect(await dispatch({ operation: 'audio.speech', model, body: { input: 'hello' } }, context)).toMatchObject({
      ok: true, encoding: 'base64', body: '/9gB',
    });
    expect(getGuide).not.toHaveBeenCalled();
  });

  it('does not retry after a lost submission response and bounds streamed bodies', async () => {
    const { context, dispatch, send } = setup();
    const request = { operation: 'image.generate', model, body: {} };
    send.mockRejectedValueOnce(new Error('connection lost'));
    expect(await dispatch(request, context)).toMatchObject({ ok: false, errorCode: 'OUTCOME_UNKNOWN' });
    expect(send).toHaveBeenCalledOnce();
    send.mockResolvedValueOnce(new Response(new Uint8Array(4097)));
    expect(await dispatch(request, context)).toMatchObject({ ok: false, errorCode: 'RESPONSE_TOO_LARGE' });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
