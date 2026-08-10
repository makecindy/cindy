/**
 * device-link 被控端 dispatch 单测:runInvoke 的双层校验(被控开关 + allowlist)
 * 与 invoke-registry 的 dispatchLocalInvoke。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let remoteControlEnabled = true;
let revokedControllers: string[] = [];
vi.mock('../device-link/settings-store', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled, revokedControllers }),
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getVersion: () => '1.0.0' },
}));
// media:fetch 拦截走 mediaFetch.fetchLocalMediaToOss;mock 掉避免拉起 OSS/cache-store 真实依赖。
const fetchLocalMediaToOssMock = vi.hoisted(() => vi.fn());
vi.mock('../device-link/mediaFetch', () => ({ fetchLocalMediaToOss: fetchLocalMediaToOssMock }));
const transcribeRemoteVoiceInputMock = vi.hoisted(() => vi.fn());
vi.mock('../device-link/voiceTranscribe', () => ({ transcribeRemoteVoiceInput: transcribeRemoteVoiceInputMock }));
const adviseAndRecordVoiceInputDictionaryLearningMock = vi.hoisted(() => vi.fn());
vi.mock('../voice-input/index.js', () => ({
  adviseAndRecordVoiceInputDictionaryLearning: adviseAndRecordVoiceInputDictionaryLearningMock,
}));

import {
  markRemoteSettingPersistedInsideHandler,
  runInvoke,
  setRemoteReviewInputGuard,
  setRemoteWorkingDirGuard,
  setRemoteSettingsPersist,
  handleControllerOffline,
  __testing as dispatchTesting,
  type ActiveController,
} from '../device-link/dispatch';
import { __testing as registry, dispatchLocalInvoke } from '../device-link/invoke-registry';
import {
  deviceLinkInvokeControllerSupports,
  getDeviceLinkInvokeContext,
  isDeviceLinkInvoke,
} from '../device-link/invoke-context';
import * as subscriptions from '../device-link/subscriptions';

beforeEach(() => {
  remoteControlEnabled = true;
  revokedControllers = [];
  registry.reset();
  dispatchTesting.reset(); // 清订阅 registry / tap / onControllersChanged / activeClient
  setRemoteWorkingDirGuard(null); // 默认不注入,行为同生产未就绪态(放行)
  setRemoteReviewInputGuard(null);
  setRemoteSettingsPersist(null);
  fetchLocalMediaToOssMock.mockReset();
  transcribeRemoteVoiceInputMock.mockReset();
  adviseAndRecordVoiceInputDictionaryLearningMock.mockReset();
});

describe('runInvoke 双层校验', () => {
  it('开关关闭 → REMOTE_DISABLED', async () => {
    remoteControlEnabled = false;
    const r = await runInvoke('ctrl', { channel: 'maker:list-active', args: [] });
    expect(r).toMatchObject({ ok: false, error: { code: 'REMOTE_DISABLED' } });
  });

  it('非 allowlist channel → CHANNEL_NOT_ALLOWED', async () => {
    const r = await runInvoke('ctrl', { channel: 'shell:open-path', args: [] });
    expect(r).toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
  });

  it('已撤销访问权限的控制端 → ACCESS_REVOKED(早于 allowlist 判定)', async () => {
    revokedControllers = ['ctrl'];
    registry.register('maker:list-active', () => ['s']); // 即便 channel 合法也被挡
    const r = await runInvoke('ctrl', { channel: 'maker:list-active', args: [] });
    expect(r).toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
  });

  it('黑名单只挡命中的控制端,其它控制端不受影响', async () => {
    revokedControllers = ['other-ctrl'];
    registry.register('maker:list-active', () => ['s']);
    const r = await runInvoke('ctrl', { channel: 'maker:list-active', args: [] });
    expect(r).toEqual({ ok: true, result: ['s'] });
  });

  it('allowlist channel:dispatch 到本机 handler 并回传 result', async () => {
    registry.register('maker:list-active', () => ['session-x']);
    const r = await runInvoke('ctrl', { channel: 'maker:list-active', args: [] });
    expect(r).toEqual({ ok: true, result: ['session-x'] });
  });

  it('Review 外部输入在 device-link handler 前整族拒绝', async () => {
    const handler = vi.fn(() => ({ accepted: true }));
    const channels = [
      'maker:send',
      'maker:steer',
      'maker:input:enqueue',
      'maker:input:steer',
      'maker:input:resume',
      'maker:input:update-content',
      'maker:input:clear-session',
    ];
    for (const channel of channels) registry.register(channel, handler);
    setRemoteReviewInputGuard((sessionId) => {
      if (sessionId === 'review-1') {
        throw new Error(
          '[UNSUPPORTED_CAPABILITY] Review tasks only accept the host-owned initial review prompt',
        );
      }
    });

    for (const channel of channels) {
      await expect(runInvoke('ctrl', { channel, args: ['review-1'] })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message: expect.stringContaining('[UNSUPPORTED_CAPABILITY]'),
        },
      });
    }
    expect(handler).not.toHaveBeenCalled();

    await expect(
      runInvoke('ctrl', { channel: 'maker:send', args: ['desktop-1', 'hello'] }),
    ).resolves.toEqual({ ok: true, result: { accepted: true } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('远程 invoke 期间给本机 handler 暴露 device-link 上下文,结束后不泄漏', async () => {
    registry.register('maker:list-active', () => ({
      active: isDeviceLinkInvoke(),
      context: getDeviceLinkInvokeContext(),
    }));

    const r = await runInvoke('ctrl-a', { channel: 'maker:list-active', args: [] });

    expect(r).toEqual({
      ok: true,
      result: {
        active: true,
        context: { controllerDeviceId: 'ctrl-a', channel: 'maker:list-active' },
      },
    });
    expect(isDeviceLinkInvoke()).toBe(false);
  });

  it('能力查询只信任当前 device-link controller context,未知控制端 fail closed', async () => {
    subscriptions.subscribe(
      'ctrl-cap',
      ['sessions'],
      'Desktop',
      [CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1],
    );
    subscriptions.subscribe('ctrl-legacy', ['sessions'], 'Legacy');
    registry.register('maker:list-active', () => ({
      explicitProviderNull: deviceLinkInvokeControllerSupports(
        CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1,
      ),
    }));

    await expect(runInvoke('ctrl-cap', { channel: 'maker:list-active', args: [] })).resolves.toEqual({
      ok: true,
      result: { explicitProviderNull: true },
    });
    await expect(runInvoke('ctrl-legacy', { channel: 'maker:list-active', args: [] })).resolves.toEqual({
      ok: true,
      result: { explicitProviderNull: false },
    });
  });

  it('本机 handler 抛 throwIpcError → IPC_ERROR 透传 [CODE] message', async () => {
    registry.register('maker:send', () => {
      const e = new Error('[SESSION_RUNNING] busy');
      throw e;
    });
    const r = await runInvoke('ctrl', { channel: 'maker:send', args: [] });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'IPC_ERROR', message: '[SESSION_RUNNING] busy' },
    });
  });

  it('handler 不存在(未注册)→ IPC_ERROR NOT_FOUND', async () => {
    const r = await runInvoke('ctrl', { channel: 'maker:create-session', args: [] });
    expect(r).toMatchObject({ ok: false, error: { code: 'IPC_ERROR' } });
    expect((r as { error: { message: string } }).error.message).toMatch(/NOT_FOUND/);
  });

  it('malformed payload → INTERNAL', async () => {
    const r = await runInvoke('ctrl', undefined);
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });

  it('create-session 的 workingDir 不在被控端已知集合 → CHANNEL_NOT_ALLOWED,不落到 handler', async () => {
    const handler = vi.fn(() => ({ session: { id: 's1' } }));
    registry.register('maker:create-session', handler as never);
    setRemoteWorkingDirGuard((dir) => dir === '/allowed/proj');

    const denied = await runInvoke('ctrl', {
      channel: 'maker:create-session',
      args: [{ workingDir: '/etc' }],
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } });
    expect(handler).not.toHaveBeenCalled();

    const allowed = await runInvoke('ctrl', {
      channel: 'maker:create-session',
      args: [{ workingDir: '/allowed/proj' }],
    });
    expect(allowed).toMatchObject({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('create-session 的网络目录探测超时 → 明确 IPC 错误,不落到 handler', async () => {
    const handler = vi.fn(() => ({ session: { id: 's-timeout' } }));
    registry.register('maker:create-session', handler as never);
    setRemoteWorkingDirGuard(async () => ({ allowed: false, reason: 'timeout' }));

    const result = await runInvoke('ctrl', {
      channel: 'maker:create-session',
      args: [{ workingDir: 'Z:\\offline-project' }],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'IPC_ERROR',
        message: expect.stringContaining('[REMOTE_WORKDIR_UNAVAILABLE]'),
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('未注入 workingDir guard 时不阻断 create-session(生产未就绪态放行)', async () => {
    registry.register('maker:create-session', () => ({ session: { id: 's2' } }));
    const r = await runInvoke('ctrl', {
      channel: 'maker:create-session',
      args: [{ workingDir: '/whatever' }],
    });
    expect(r).toMatchObject({ ok: true });
  });
});

describe('runInvoke media:fetch 拦截(入方向媒体)', () => {
  it('device-link:media:fetch → 调 fetchLocalMediaToOss 并回 { ok, result },不落 ipcMain', async () => {
    fetchLocalMediaToOssMock.mockResolvedValue({ ossKey: 'k', mimeType: 'image/png', size: 10 });
    const r = await runInvoke('ctrl', {
      channel: 'device-link:media:fetch',
      args: [{ url: 'xdt-image://s/x.png' }],
    });
    expect(fetchLocalMediaToOssMock).toHaveBeenCalledWith({ url: 'xdt-image://s/x.png' });
    expect(r).toEqual({ ok: true, result: { ossKey: 'k', mimeType: 'image/png', size: 10 } });
  });

  it('解析/上传失败 → MEDIA_FETCH_FAILED', async () => {
    fetchLocalMediaToOssMock.mockRejectedValue(new Error('boom'));
    const r = await runInvoke('ctrl', { channel: 'device-link:media:fetch', args: [{ url: 'bad' }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'MEDIA_FETCH_FAILED', message: 'boom' } });
  });

  it('已撤销控制端 media:fetch → ACCESS_REVOKED,不触发解析', async () => {
    revokedControllers = ['ctrl'];
    const r = await runInvoke('ctrl', { channel: 'device-link:media:fetch', args: [{ url: 'x' }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
    expect(fetchLocalMediaToOssMock).not.toHaveBeenCalled();
  });

  it('开关关闭 → REMOTE_DISABLED,不触发解析', async () => {
    remoteControlEnabled = false;
    const r = await runInvoke('ctrl', { channel: 'device-link:media:fetch', args: [{ url: 'x' }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'REMOTE_DISABLED' } });
    expect(fetchLocalMediaToOssMock).not.toHaveBeenCalled();
  });
});

describe('runInvoke voice:transcribe 拦截(手机语音输入)', () => {
  it('device-link:voice:transcribe → 调 transcribeRemoteVoiceInput 并回文本,不落 ipcMain', async () => {
    transcribeRemoteVoiceInputMock.mockResolvedValue({
      text: '移动端语音文本',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
      audioBytes: 1024,
    });
    const req = { ossKey: 'cindy/device-link/u/voice.m4a', mimeType: 'audio/mp4' };
    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:transcribe',
      args: [req],
    });
    expect(transcribeRemoteVoiceInputMock).toHaveBeenCalledWith(req);
    expect(r).toEqual({
      ok: true,
      result: {
        text: '移动端语音文本',
        provider: 'litellm-batch',
        model: 'elevenlabs/scribe_v2',
        audioBytes: 1024,
      },
    });
  });

  it('转写失败 → VOICE_TRANSCRIBE_FAILED', async () => {
    transcribeRemoteVoiceInputMock.mockRejectedValue(new Error('asr down'));
    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:transcribe',
      args: [{ ossKey: 'k' }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'VOICE_TRANSCRIBE_FAILED', message: 'asr down' } });
  });

  it('已撤销控制端 voice:transcribe → ACCESS_REVOKED,不触发转写', async () => {
    revokedControllers = ['ctrl'];
    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:transcribe',
      args: [{ ossKey: 'k' }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
    expect(transcribeRemoteVoiceInputMock).not.toHaveBeenCalled();
  });
});

describe('runInvoke voice:credential-sync 拦截(能力已下线,保留可读拒绝)', () => {
  it('device-link:voice:credential-sync → VOICE_CREDENTIAL_SYNC_REMOVED(不再穿透桌面 key)', async () => {
    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:credential-sync',
      args: [],
    });
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: 'VOICE_CREDENTIAL_SYNC_REMOVED',
        message: '手机语音输入已改用 Cindy 官方语音服务,请升级手机版。',
      },
    });
  });

  it('已撤销控制端 voice:credential-sync → ACCESS_REVOKED(早于能力下线拒绝)', async () => {
    revokedControllers = ['ctrl'];
    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:credential-sync',
      args: [],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
  });
});

describe('runInvoke voice:dictionary-learning 拦截(手机语音词典学习回写)', () => {
  it('device-link:voice:dictionary-learning → 调桌面词典学习 advisor 并回写桌面词典', async () => {
    adviseAndRecordVoiceInputDictionaryLearningMock.mockResolvedValue({
      ok: true,
      actions: [{
        action: 'add_entry',
        term: 'XDMaker',
        aliases: ['xd maker'],
        type: 'product_name',
        confidence: 'high',
      }],
      elapsedMs: 42,
    });
    const req = {
      source: 'mobile',
      rawTranscriptText: 'xd maker',
      beforeText: 'XDMaker',
      afterText: 'XDMaker',
      context: {
        uiLanguage: 'zh-CN',
        sourceLanguage: 'zh-CN',
        selectionBefore: '配置',
        selectionAfter: '远程控制',
      },
    };

    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:dictionary-learning',
      args: [req],
    });

    expect(adviseAndRecordVoiceInputDictionaryLearningMock).toHaveBeenCalledWith(
      {
        source: 'in_app',
        rawTranscriptText: 'xd maker',
        beforeText: 'XDMaker',
        afterText: 'XDMaker',
        context: req.context,
      },
      {
        senderId: 'ctrl',
        sourceLabel: 'mobile',
      },
    );
    expect(r).toEqual({
      ok: true,
      result: {
        ok: true,
        actions: [{
          action: 'add_entry',
          term: 'XDMaker',
          aliases: ['xd maker'],
          type: 'product_name',
          confidence: 'high',
        }],
        elapsedMs: 42,
      },
    });
  });

  it('词典学习失败 → VOICE_DICTIONARY_LEARNING_FAILED', async () => {
    adviseAndRecordVoiceInputDictionaryLearningMock.mockRejectedValue(new Error('advisor down'));
    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:dictionary-learning',
      args: [{ source: 'mobile', beforeText: 'a', afterText: 'b' }],
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'VOICE_DICTIONARY_LEARNING_FAILED', message: 'advisor down' },
    });
  });

  it('已撤销控制端 voice:dictionary-learning → ACCESS_REVOKED,不触发词典学习', async () => {
    revokedControllers = ['ctrl'];
    const r = await runInvoke('ctrl', {
      channel: 'device-link:voice:dictionary-learning',
      args: [{ source: 'mobile', beforeText: 'a', afterText: 'b' }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
    expect(adviseAndRecordVoiceInputDictionaryLearningMock).not.toHaveBeenCalled();
  });
});

describe('dispatchLocalInvoke', () => {
  it('转发 args 给 handler 并 await 异步结果', async () => {
    const handler = vi.fn(async (_e: unknown, a: number, b: number) => a + b);
    registry.register('maker:set-model', handler as never);
    const result = await dispatchLocalInvoke('maker:set-model', [2, 3]);
    expect(result).toBe(5);
    // 合成 event 作为首参
    expect(handler).toHaveBeenCalledWith(expect.anything(), 2, 3);
  });

  it('未注册 channel 抛 [NOT_FOUND]', async () => {
    await expect(dispatchLocalInvoke('nope:channel', [])).rejects.toThrowError(/\[NOT_FOUND\]/);
  });
});

// ─── 被控端控制链路生命周期(M5)──────────────────────────────────────────────

import {
  wireInboundDispatch,
  setControllersChangedListener,
  setRemoteInvokeBusyChangedListener,
  setSessionsSubscribedListener,
  getActiveControllers,
  getUpdateRelaunchControllers,
  hasInFlightRemoteInvokes,
  dropAllControllers,
  pushSessionActivityToController,
} from '../device-link/dispatch';
import { hasBroadcastTapListener, tapWindowBroadcast } from '../device-link/broadcast-tap';
import {
  CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1,
  DeviceLinkError,
  SESSION_ACTIVITY_CHANNEL,
  type Envelope,
} from '@cindy/device-link';
import { DEVICE_LINK_RECONCILIATION_PROBE_MARKER } from '@cindy/maker-shared/device-link-contract';
import { MAKER_PUSH } from '../maker-ipc/channels';

/** 最小 fake client:捕获 onFrame handler,记录出站调用 */
function makeFakeClient(initialStatus: 'stopped' | 'connecting' | 'online' = 'online') {
  let frameHandler: ((env: Envelope) => unknown | Promise<unknown>) | null = null;
  let status = initialStatus;
  let reliableSendQueueDepth = 0;
  let nextPushError: Error | null = null;
  const calls = {
    linkAccept: [] as Array<{ dst: string; requestId: string }>,
    closed: [] as Array<{ dst: string; reason: string }>,
    push: [] as Array<{ dst: string; channel: string; payload: unknown }>,
    invokeResult: [] as Array<{ dst: string; requestId: string; payload: unknown }>,
  };
  const client = {
    getStatus: () => status,
    onFrame: (cb: (env: Envelope) => unknown | Promise<unknown>) => {
      frameHandler = cb;
      return () => {};
    },
    sendLinkAccept: (dst: string, requestId: string) => calls.linkAccept.push({ dst, requestId }),
    closeLink: (dst: string, reason: string) => calls.closed.push({ dst, reason }),
    sendPush: (dst: string, channel: string, payload: unknown) => {
      if (nextPushError) {
        const err = nextPushError;
        nextPushError = null;
        throw err;
      }
      calls.push.push({ dst, channel, payload });
    },
    sendInvokeResult: (dst: string, requestId: string, payload: unknown) =>
      calls.invokeResult.push({ dst, requestId, payload }),
    getReliableSendQueueDepth: () => reliableSendQueueDepth,
  };
  return {
    client: client as never,
    calls,
    setStatus: (nextStatus: 'stopped' | 'connecting' | 'online') => {
      status = nextStatus;
    },
    setReliableSendQueueDepth: (depth: number) => {
      reliableSendQueueDepth = depth;
    },
    failNextPush: (err: Error) => {
      nextPushError = err;
    },
    feed: (env: Envelope) => frameHandler?.(env),
  };
}

describe('被控端控制链路生命周期', () => {
  beforeEach(() => {
    setControllersChangedListener(null);
    // 清掉可能残留的 controllers:dropAll 需要 client,改用重置 listener 后逐个 close
  });

  it('link-open(开关开)→ 回 link-accept + 记录控制端名 + 激活 broadcast-tap', () => {
    remoteControlEnabled = true;
    const changes: number[] = [];
    setControllersChangedListener((cs) => changes.push(cs.length));
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed({ v: 1, kind: 'link-open', id: 'r1', src: 'ctrl-a', payload: { controllerName: 'MacBook', protocolVersion: 1, appVersion: '1.0.0' } });

    expect(calls.linkAccept).toHaveLength(1);
    const ctrls = getActiveControllers();
    expect(ctrls).toEqual([{ deviceId: 'ctrl-a', name: 'MacBook' }]);
    expect(hasBroadcastTapListener()).toBe(true);
    expect(changes.at(-1)).toBe(1);

    dropAllControllers(client, 'user');
    expect(calls.closed).toEqual([{ dst: 'ctrl-a', reason: 'user' }]);
    expect(getActiveControllers()).toHaveLength(0);
    expect(hasBroadcastTapListener()).toBe(false);
  });

  it('link-open(开关关)→ 不 accept、不记录', () => {
    remoteControlEnabled = false;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed({ v: 1, kind: 'link-open', id: 'r2', src: 'ctrl-b', payload: { controllerName: 'X', protocolVersion: 1, appVersion: '1' } });
    expect(calls.linkAccept).toHaveLength(0);
    expect(getActiveControllers()).toHaveLength(0);
  });

  it('link-accept 发送失败时不提交幽灵控制端订阅', async () => {
    remoteControlEnabled = true;
    const { client, feed } = makeFakeClient();
    const mutableClient = client as unknown as {
      sendLinkAccept: (dst: string, requestId: string) => void;
    };
    mutableClient.sendLinkAccept = () => {
      throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
    };
    wireInboundDispatch(client);

    feed({
      v: 1,
      kind: 'link-open',
      id: 'r-accept-backpressure',
      src: 'ctrl-accept-backpressure',
      payload: {
        controllerName: 'Blocked',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(getActiveControllers()).toEqual([]);
    expect(hasBroadcastTapListener()).toBe(false);
  });

  it('弱网下 link-close 写 socket 失败也会完成本地 dropAll 清理', () => {
    remoteControlEnabled = true;
    const { client, feed } = makeFakeClient();
    const mutableClient = client as unknown as {
      closeLink: (dst: string, reason: string) => void;
    };
    wireInboundDispatch(client);
    feed({
      v: 1,
      kind: 'link-open',
      id: 'r-drop-backpressure',
      src: 'ctrl-drop',
      payload: {
        controllerName: 'Drop',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });
    mutableClient.closeLink = () => {
      throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
    };

    expect(() => dropAllControllers(client, 'user')).not.toThrow();
    expect(getActiveControllers()).toEqual([]);
    expect(hasBroadcastTapListener()).toBe(false);
  });

  it('显式 dropAll 清理断线期间已排队的 push', () => {
    remoteControlEnabled = true;
    const { client, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-drop-queue', SUB, ['session:s1']));
    handleControllerOffline('ctrl-drop-queue');
    tapWindowBroadcast('local-db:messages:created', {
      sessionId: 's1',
      id: 'm-stale',
    });
    expect(dispatchTesting.queuedPushesFor('ctrl-drop-queue')).toHaveLength(1);

    dropAllControllers(client, 'toggle-off');

    expect(dispatchTesting.queuedPushesFor('ctrl-drop-queue')).toEqual([]);
    expect(hasBroadcastTapListener()).toBe(false);
  });

  it('link-open capability controls whether provider projection includes new logo kinds', async () => {
    const { client, feed } = makeFakeClient();
    wireInboundDispatch(client);
    registry.register('maker:provider:list', () => ({
      providers: [{
        id: 'renamed-vercel',
        name: 'Team gateway',
        routing: { codex: { upstream: 'https://ai-gateway.vercel.sh/v1' } },
      }],
    }));

    feed({
      v: 1,
      kind: 'link-open',
      id: 'r-cap',
      src: 'ctrl-cap',
      payload: {
        controllerName: 'Current mobile',
        protocolVersion: 1,
        appVersion: '2.0.0',
        capabilities: ['provider-logo-kinds-v2'],
      },
    });
    feed({
      v: 1,
      kind: 'link-open',
      id: 'r-legacy',
      src: 'ctrl-legacy',
      payload: {
        controllerName: 'Legacy mobile',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });

    const current = await runInvoke('ctrl-cap', { channel: 'maker:provider:list', args: [] });
    const legacy = await runInvoke('ctrl-legacy', { channel: 'maker:provider:list', args: [] });
    expect(current).toMatchObject({
      ok: true,
      result: { providers: [{ logoKind: 'vercel', routing: { codex: {} } }] },
    });
    expect(legacy).toMatchObject({
      ok: true,
      result: { providers: [{ routing: { codex: {} } }] },
    });
    expect((legacy as { result: { providers: Record<string, unknown>[] } }).result.providers[0])
      .not.toHaveProperty('logoKind');
  });

  it('listing-only invoke can negotiate new logo kinds without link-open', async () => {
    registry.register('maker:provider:list', () => ({
      providers: [{
        id: 'renamed-vercel',
        name: 'Team gateway',
        routing: { codex: { upstream: 'https://ai-gateway.vercel.sh/v1' } },
      }],
    }));

    const current = await runInvoke('ctrl-list-only', {
      channel: 'maker:provider:list',
      args: [{ capabilities: ['provider-logo-kinds-v2'] }],
    });
    expect(current).toMatchObject({
      ok: true,
      result: { providers: [{ logoKind: 'vercel', routing: { codex: {} } }] },
    });
  });

  it('malformed link-open capabilities fail closed without blocking link acceptance', async () => {
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed({
      v: 1,
      kind: 'link-open',
      id: 'r-malformed-cap',
      src: 'ctrl-malformed-cap',
      payload: {
        controllerName: 'Mixed client',
        protocolVersion: 1,
        appVersion: '1.0.0',
        capabilities: { invalid: true } as never,
      },
    });

    expect(calls.linkAccept).toContainEqual({
      dst: 'ctrl-malformed-cap',
      requestId: 'r-malformed-cap',
    });
    expect(dispatchTesting.controllerSupports(
      'ctrl-malformed-cap',
      'provider-logo-kinds-v2',
    )).toBe(false);
  });

  it('link-close clears remembered routing and queued pushes', () => {
    remoteControlEnabled = true;
    const { client, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-c', SUB, ['session:s1'], 'C'));
    handleControllerOffline('ctrl-c');
    tapWindowBroadcast('local-db:messages:created', {
      sessionId: 's1',
      id: 'm-before-close',
    });
    expect(dispatchTesting.queuedPushesFor('ctrl-c')).toHaveLength(1);

    feed({ v: 1, kind: 'link-close', src: 'ctrl-c', payload: { reason: 'user' } });
    tapWindowBroadcast('local-db:messages:created', {
      sessionId: 's1',
      id: 'm-after-close',
    });

    expect(getActiveControllers()).toHaveLength(0);
    expect(dispatchTesting.queuedPushesFor('ctrl-c')).toEqual([]);
    expect(hasBroadcastTapListener()).toBe(false);
  });

  it('非订阅 remote invoke 在结果发送前持有更新 busy lease', async () => {
    remoteControlEnabled = true;
    let resolveInvoke: ((value: string[]) => void) | undefined;
    registry.register(
      'maker:list-active',
      () =>
        new Promise<string[]>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const busyChanges: boolean[] = [];
    setRemoteInvokeBusyChangedListener((busy) => busyChanges.push(busy));
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-1',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    });

    await vi.waitFor(() => expect(hasInFlightRemoteInvokes()).toBe(true));
    expect(busyChanges).toEqual([true]);
    resolveInvoke?.(['s1']);
    await vi.waitFor(() => expect(hasInFlightRemoteInvokes()).toBe(false));
    expect(busyChanges).toEqual([true, false]);
    expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-1',
      payload: { ok: true, result: ['s1'] },
    });
  });

  it('同一控制端重复 invoke 复用在途/已完成结果，不重复执行副作用', async () => {
    remoteControlEnabled = true;
    let resolveInvoke: ((value: string[]) => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    const duplicate: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-duplicate',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    };

    feed(duplicate);
    feed(duplicate);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    resolveInvoke?.(['s1']);
    await vi.waitFor(() => expect(
      calls.invokeResult.filter((call) => call.requestId === 'invoke-duplicate'),
    ).toHaveLength(2));

    feed(duplicate);
    await vi.waitFor(() => expect(
      calls.invokeResult.filter((call) => call.requestId === 'invoke-duplicate'),
    ).toHaveLength(3));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls.invokeResult.filter((call) => call.requestId === 'invoke-duplicate')).toEqual([
      { dst: 'ctrl-a', requestId: 'invoke-duplicate', payload: { ok: true, result: ['s1'] } },
      { dst: 'ctrl-a', requestId: 'invoke-duplicate', payload: { ok: true, result: ['s1'] } },
      { dst: 'ctrl-a', requestId: 'invoke-duplicate', payload: { ok: true, result: ['s1'] } },
    ]);
  });

  it('invoke-result 本地发送背压时进入有界 outbox，恢复后原结果补发且不重复执行', async () => {
    remoteControlEnabled = true;
    const handler = vi.fn(() => ['s1']);
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    const mutableClient = client as unknown as {
      sendInvokeResult: (dst: string, requestId: string, payload: unknown) => void;
    };
    const sendInvokeResult = mutableClient.sendInvokeResult;
    let blocked = true;
    mutableClient.sendInvokeResult = (dst, requestId, payload) => {
      if (blocked) throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
      sendInvokeResult(dst, requestId, payload);
    };
    wireInboundDispatch(client);
    const invoke: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-outbox',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    };

    feed(invoke);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(calls.invokeResult).toEqual([]);
    expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(1);

    feed({
      ...invoke,
      payload: { channel: 'maker:list-active', args: ['reused-with-different-payload'] },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(1);

    // presence offline 是弱网瞬断信号，不能把已执行但未发出的结果清掉。
    handleControllerOffline('ctrl-a');
    blocked = false;
    dispatchTesting.flushRemoteInvokeResultOutbox();

    expect(calls.invokeResult).toEqual([
      { dst: 'ctrl-a', requestId: 'invoke-outbox', payload: { ok: true, result: ['s1'] } },
    ]);
    expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(0);

    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('outbox 补发降级裁剪时保留原始锚点参数', async () => {
    remoteControlEnabled = true;
    const largeField = 'x'.repeat(1024 * 1024);
    registry.register('local-db:messages:around-client-id', () => [
      { id: 'm-anchor', clientId: 'anchor', role: 'user', content: 'anchor', largeField },
      { id: 'm-middle', clientId: 'middle', role: 'assistant', content: 'middle', largeField },
      { id: 'm-tail', clientId: 'tail', role: 'assistant', content: 'tail', largeField },
    ]);
    const { client, calls, feed } = makeFakeClient();
    const mutableClient = client as unknown as {
      sendInvokeResult: (dst: string, requestId: string, payload: unknown) => void;
    };
    const sendInvokeResult = mutableClient.sendInvokeResult;
    let firstAttempt = true;
    mutableClient.sendInvokeResult = (dst, requestId, payload) => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
      }
      if (JSON.stringify(payload).length > 2 * 1024 * 1024) {
        throw new DeviceLinkError('PAYLOAD_TOO_LARGE', 'legacy frame too large');
      }
      sendInvokeResult(dst, requestId, payload);
    };
    wireInboundDispatch(client);

    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-anchor-outbox',
      src: 'ctrl-a',
      payload: {
        channel: 'local-db:messages:around-client-id',
        args: ['s1', 'anchor', { radius: 20 }],
      },
    });
    await vi.waitFor(() => expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(1));

    dispatchTesting.flushRemoteInvokeResultOutbox();

    expect(calls.invokeResult).toHaveLength(1);
    const payload = calls.invokeResult[0]?.payload as {
      ok: true;
      result: Array<{ clientId?: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.result.some((message) => message.clientId === 'anchor')).toBe(true);
    expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(0);
  });

  it('显式 link-close 后丢弃旧世代晚到 IPC 结果，快速重开也不串进新链路', async () => {
    remoteControlEnabled = true;
    let resolveInvoke: ((value: string[]) => void) | undefined;
    registry.register('maker:list-active', () => new Promise<string[]>((resolve) => {
      resolveInvoke = resolve;
    }));
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-old-link',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    });
    await vi.waitFor(() => expect(hasInFlightRemoteInvokes()).toBe(true));

    feed({ v: 1, kind: 'link-close', src: 'ctrl-a', payload: { reason: 'user' } });
    feed({
      v: 1,
      kind: 'link-open',
      id: 'open-new-link',
      src: 'ctrl-a',
      payload: {
        controllerName: 'reopened',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });
    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-old-link',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    });
    resolveInvoke?.(['stale']);
    await vi.waitFor(() => expect(hasInFlightRemoteInvokes()).toBe(false));

    expect(calls.invokeResult.some((call) => call.requestId === 'invoke-old-link')).toBe(false);
    expect(calls.linkAccept).toContainEqual({ dst: 'ctrl-a', requestId: 'open-new-link' });
  });

  it('已完成缓存淘汰仍不绕过 outbox 的 requestId 去重', async () => {
    remoteControlEnabled = true;
    const handler = vi.fn((_event: unknown, value: unknown) => value);
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    const mutableClient = client as unknown as {
      sendInvokeResult: (dst: string, requestId: string, payload: unknown) => void;
    };
    const sendInvokeResult = mutableClient.sendInvokeResult;
    mutableClient.sendInvokeResult = (dst, requestId, payload) => {
      if (requestId === 'invoke-outbox-evicted') {
        throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
      }
      sendInvokeResult(dst, requestId, payload);
    };
    wireInboundDispatch(client);
    const queuedInvoke: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-outbox-evicted',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: ['original'] },
    };
    feed(queuedInvoke);
    await vi.waitFor(() => expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(1));

    // 用不同 requestId 推进 completed cache，确保最早的 original 已被容量淘汰。
    let sent = 0;
    for (const batchSize of [50, 50, 30]) {
      for (let offset = 0; offset < batchSize; offset++) {
        const index = sent + offset;
        feed({
          v: 1,
          kind: 'invoke',
          id: `invoke-cache-pressure-${index}`,
          src: `ctrl-cache-pressure-${index}`,
          payload: { channel: 'maker:list-active', args: [`value-${index}`] },
        });
      }
      sent += batchSize;
      await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(sent));
    }
    expect(handler).toHaveBeenCalledTimes(131);

    feed(queuedInvoke);
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(131);
    expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(1);
  });

  it('单个控制端达到 invoke-result outbox 上限后拒绝继续积压并停止执行新副作用', async () => {
    const client = {
      sendInvokeResult: () => {
        throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
      },
    } as never;
    for (
      let index = 0;
      index < dispatchTesting.remoteInvokeResultOutboxPerControllerLimit;
      index++
    ) {
      expect(dispatchTesting.sendInvokeResultSafe(
        client,
        'ctrl-a',
        `invoke-outbox-${index}`,
        { ok: true, result: index },
        'maker:list-active',
      )).toBe(true);
    }

    expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(
      dispatchTesting.remoteInvokeResultOutboxPerControllerLimit,
    );
    expect(dispatchTesting.sendInvokeResultSafe(
      client,
      'ctrl-a',
      'invoke-outbox-over-limit',
      { ok: true, result: 'overflow' },
      'maker:list-active',
    )).toBe(false);

    const handler = vi.fn(() => ['must-not-run']);
    registry.register('maker:list-active', handler);
    const h = makeFakeClient();
    wireInboundDispatch(h.client);
    h.feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-after-outbox-full',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    });
    await vi.waitFor(() => expect(h.calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-after-outbox-full',
      payload: {
        ok: false,
        error: {
          code: 'BACKPRESSURE',
          message: 'remote invoke execution queue is full',
        },
      },
    }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('多个控制端的 invoke-result outbox 仍受全局消息上限保护', () => {
    const client = {
      sendInvokeResult: () => {
        throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
      },
    } as never;
    const controllerCount = Math.ceil(
      dispatchTesting.remoteInvokeResultOutboxLimit
        / dispatchTesting.remoteInvokeResultOutboxPerControllerLimit,
    );
    let queued = 0;
    for (let controller = 0; controller < controllerCount; controller++) {
      for (
        let index = 0;
        index < dispatchTesting.remoteInvokeResultOutboxPerControllerLimit
          && queued < dispatchTesting.remoteInvokeResultOutboxLimit;
        index++
      ) {
        expect(dispatchTesting.sendInvokeResultSafe(
          client,
          `ctrl-${controller}`,
          `invoke-global-outbox-${queued}`,
          { ok: true, result: queued },
          'maker:list-active',
        )).toBe(true);
        queued++;
      }
    }
    expect(dispatchTesting.remoteInvokeResultOutboxSize()).toBe(
      dispatchTesting.remoteInvokeResultOutboxLimit,
    );
    expect(dispatchTesting.sendInvokeResultSafe(
      client,
      'ctrl-over',
      'invoke-global-outbox-over-limit',
      { ok: true, result: 'overflow' },
      'maker:list-active',
    )).toBe(false);
  });

  it('invoke-result outbox 字节预算包含 request fingerprint', () => {
    const client = {
      sendInvokeResult: () => {
        throw new DeviceLinkError('BACKPRESSURE', 'socket buffer full');
      },
    } as never;
    const fingerprint = 'x'.repeat(1_500_000);

    for (let index = 0; index < 2; index++) {
      expect(dispatchTesting.sendInvokeResultSafe(
        client,
        'ctrl-a',
        `invoke-large-fingerprint-${index}`,
        { ok: true, result: index },
        'maker:list-active',
        [],
        `${fingerprint}${index}`,
      )).toBe(true);
    }
    expect(dispatchTesting.sendInvokeResultSafe(
      client,
      'ctrl-a',
      'invoke-large-fingerprint-overflow',
      { ok: true, result: 'overflow' },
      'maker:list-active',
      [],
      `${fingerprint}overflow`,
    )).toBe(false);
  });

  it('不可 JSON 序列化的 IPC 结果转为明确错误并缓存，不留下已 ACK 黑洞', async () => {
    remoteControlEnabled = true;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const handler = vi.fn(() => circular);
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    const invoke: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-circular-result',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    };

    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-circular-result',
      payload: {
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message: '[SERIALIZATION_ERROR] remote invoke result is not JSON serializable',
        },
      },
    }));

    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('超缓存上限的大结果以 compact wire 结果去重，不因原对象自淘汰而重复执行', async () => {
    remoteControlEnabled = true;
    const oversizedContent = 'x'.repeat(17 * 1024 * 1024);
    const handler = vi.fn(() => [{
      id: 'm-large',
      role: 'assistant',
      content: oversizedContent,
    }]);
    registry.register('local-db:messages:list', handler);
    const { client, calls, feed } = makeFakeClient();
    const mutableClient = client as unknown as {
      sendInvokeResult: (dst: string, requestId: string, payload: unknown) => void;
    };
    const sendInvokeResult = mutableClient.sendInvokeResult;
    mutableClient.sendInvokeResult = (dst, requestId, payload) => {
      if (JSON.stringify(payload).length > 1024 * 1024) {
        throw new DeviceLinkError('PAYLOAD_TOO_LARGE', 'frame too large');
      }
      sendInvokeResult(dst, requestId, payload);
    };
    wireInboundDispatch(client);
    const invoke: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-large-result-cache',
      src: 'ctrl-a',
      payload: { channel: 'local-db:messages:list', args: ['s1'] },
    };

    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(1));
    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(2));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls.invokeResult[0].payload).length).toBeLessThan(1024 * 1024);
    expect(calls.invokeResult[1].payload).toEqual(calls.invokeResult[0].payload);
  });

  it('永久挂起 IPC 到孤儿期限后释放执行槽和 busy lease，同 requestId 不重复执行', async () => {
    vi.useFakeTimers();
    try {
      remoteControlEnabled = true;
      const handler = vi.fn(() => new Promise<never>(() => {}));
      registry.register('maker:list-active', handler);
      const busyChanges: boolean[] = [];
      setRemoteInvokeBusyChangedListener((busy) => busyChanges.push(busy));
      const { client, calls, feed } = makeFakeClient();
      wireInboundDispatch(client);
      const invoke: Envelope = {
        v: 1,
        kind: 'invoke',
        id: 'invoke-orphan',
        src: 'ctrl-a',
        payload: { channel: 'maker:list-active', args: [] },
      };

      feed(invoke);
      await Promise.resolve();
      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(hasInFlightRemoteInvokes()).toBe(true);
      expect(busyChanges).toEqual([true]);

      await vi.advanceTimersByTimeAsync(
        dispatchTesting.remoteInvokeOrphanTimeoutForChannelMs('maker:list-active'),
      );

      expect(calls.invokeResult).toContainEqual({
        dst: 'ctrl-a',
        requestId: 'invoke-orphan',
        payload: {
          ok: false,
          error: {
            code: 'IPC_ERROR',
            message: expect.stringContaining('[TIMEOUT]'),
          },
        },
      });
      expect(hasInFlightRemoteInvokes()).toBe(false);
      expect(busyChanges).toEqual([true, false]);

      feed(invoke);
      await Promise.resolve();
      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(calls.invokeResult).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一 requestId 换 payload 不复用在途或已完成结果', async () => {
    remoteControlEnabled = true;
    let resolveInvoke: ((value: string[]) => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    const original: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-reused-id',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    };
    const changed: Envelope = {
      ...original,
      payload: { channel: 'maker:list-active', args: ['different'] },
    };

    feed(original);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    feed(changed);
    await vi.waitFor(() => expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-reused-id',
      payload: {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: 'request id reused with different payload',
        },
      },
    }));

    resolveInvoke?.(['s1']);
    await vi.waitFor(() => expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-reused-id',
      payload: { ok: true, result: ['s1'] },
    }));
    feed(changed);
    await vi.waitFor(() => expect(
      calls.invokeResult.filter((call) => (
        call.requestId === 'invoke-reused-id'
        && (call.payload as { error?: { message?: string } }).error?.message
          === 'request id reused with different payload'
      )),
    ).toHaveLength(2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('撤权检查优先于 requestId 结果缓存', async () => {
    remoteControlEnabled = true;
    const handler = vi.fn(() => ['s1']);
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    const invoke: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-before-revoke',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    };

    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-before-revoke',
      payload: { ok: true, result: ['s1'] },
    }));
    revokedControllers = ['ctrl-a'];
    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-before-revoke',
      payload: {
        ok: false,
        error: {
          code: 'ACCESS_REVOKED',
          message: 'access revoked by target device',
        },
      },
    }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('执行边界外的异常也会返回并缓存 IPC_ERROR，不让已 ACK 请求只剩超时', async () => {
    remoteControlEnabled = true;
    const handler = vi.fn(() => ({ session: { id: 'must-not-run' } }));
    registry.register('maker:create-session', handler as never);
    setRemoteWorkingDirGuard(async () => {
      throw new Error('guard crashed');
    });
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    const invoke: Envelope = {
      v: 1,
      kind: 'invoke',
      id: 'invoke-guard-crash',
      src: 'ctrl-a',
      payload: {
        channel: 'maker:create-session',
        args: [{ workingDir: '/project' }],
      },
    };

    feed(invoke);
    await vi.waitFor(() => expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-guard-crash',
      payload: {
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message: 'guard crashed',
        },
      },
    }));
    expect(handler).not.toHaveBeenCalled();
    expect(hasInFlightRemoteInvokes()).toBe(false);

    feed(invoke);
    await vi.waitFor(() => expect(
      calls.invokeResult.filter((call) => call.requestId === 'invoke-guard-crash'),
    ).toHaveLength(2));
    expect(handler).not.toHaveBeenCalled();
  });

  it('耗时 invoke 执行队列有界，超限立即返回 BACKPRESSURE', async () => {
    remoteControlEnabled = true;
    const releases: Array<() => void> = [];
    const handler = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          releases.push(() => resolve([]));
        }),
    );
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    for (let index = 0; index < dispatchTesting.remoteInvokeInFlightLimit; index++) {
      feed({
        v: 1,
        kind: 'invoke',
        id: `invoke-bounded-${index}`,
        src: `ctrl-${Math.floor(index / dispatchTesting.remoteInvokeInFlightPerControllerLimit)}`,
        payload: { channel: 'maker:list-active', args: [] },
      });
    }
    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-over-limit',
      src: 'ctrl-over',
      payload: { channel: 'maker:list-active', args: [] },
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(
      dispatchTesting.remoteInvokeInFlightLimit,
    ));
    expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-over',
      requestId: 'invoke-over-limit',
      payload: {
        ok: false,
        error: {
          code: 'BACKPRESSURE',
          message: 'remote invoke execution queue is full',
        },
      },
    });

    for (const release of releases) release();
    await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(
      dispatchTesting.remoteInvokeInFlightLimit + 1,
    ));
  });

  it('单个控制端达到配额时，不阻塞其他控制端的 invoke', async () => {
    remoteControlEnabled = true;
    const releases: Array<() => void> = [];
    const handler = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          releases.push(() => resolve([]));
        }),
    );
    registry.register('maker:list-active', handler);
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    for (let index = 0; index < dispatchTesting.remoteInvokeInFlightPerControllerLimit; index++) {
      feed({
        v: 1,
        kind: 'invoke',
        id: `invoke-controller-a-${index}`,
        src: 'ctrl-a',
        payload: { channel: 'maker:list-active', args: [] },
      });
    }
    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-controller-a-over-limit',
      src: 'ctrl-a',
      payload: { channel: 'maker:list-active', args: [] },
    });
    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-controller-b-admitted',
      src: 'ctrl-b',
      payload: { channel: 'maker:list-active', args: [] },
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(
      dispatchTesting.remoteInvokeInFlightPerControllerLimit + 1,
    ));
    expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-controller-a-over-limit',
      payload: {
        ok: false,
        error: {
          code: 'BACKPRESSURE',
          message: 'remote invoke execution queue is full',
        },
      },
    });
    expect(calls.invokeResult).not.toContainEqual(expect.objectContaining({
      dst: 'ctrl-b',
      requestId: 'invoke-controller-b-admitted',
      payload: expect.objectContaining({
        error: expect.objectContaining({ code: 'BACKPRESSURE' }),
      }),
    }));

    for (const release of releases) release();
    await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(
      dispatchTesting.remoteInvokeInFlightPerControllerLimit + 2,
    ));
  });

  it.each([
    { channel: 'local-db:sessions:list', args: [] },
    {
      channel: 'local-db:sessions:get',
      args: ['s1', DEVICE_LINK_RECONCILIATION_PROBE_MARKER],
    },
  ])(
    '后台 $channel reconciliation 不持有更新 busy lease',
    async ({ channel, args }) => {
      remoteControlEnabled = true;
      registry.register(channel, () => []);
      const busyChanges: boolean[] = [];
      setRemoteInvokeBusyChangedListener((busy) => busyChanges.push(busy));
      const { client, calls, feed } = makeFakeClient();
      wireInboundDispatch(client);

      feed({
        v: 1,
        kind: 'invoke',
        id: `invoke-${channel}`,
        src: 'ctrl-a',
        payload: { channel, args },
      });

      await vi.waitFor(() =>
        expect(calls.invokeResult).toContainEqual({
          dst: 'ctrl-a',
          requestId: `invoke-${channel}`,
          payload: { ok: true, result: [] },
        }),
      );
      expect(hasInFlightRemoteInvokes()).toBe(false);
      expect(busyChanges).toEqual([]);
    },
  );

  it('普通 sessions:get 交互读取仍持有更新 busy lease', async () => {
    remoteControlEnabled = true;
    let resolveInvoke: ((value: { id: string }) => void) | undefined;
    registry.register(
      'local-db:sessions:get',
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const busyChanges: boolean[] = [];
    setRemoteInvokeBusyChangedListener((busy) => busyChanges.push(busy));
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed({
      v: 1,
      kind: 'invoke',
      id: 'invoke-interactive-get',
      src: 'ctrl-a',
      payload: { channel: 'local-db:sessions:get', args: ['s1'] },
    });

    await vi.waitFor(() => expect(hasInFlightRemoteInvokes()).toBe(true));
    expect(busyChanges).toEqual([true]);
    resolveInvoke?.({ id: 's1' });
    await vi.waitFor(() => expect(hasInFlightRemoteInvokes()).toBe(false));
    expect(busyChanges).toEqual([true, false]);
    expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'invoke-interactive-get',
      payload: { ok: true, result: { id: 's1' } },
    });
  });

  it.each([
    {
      name: 'remote control disabled',
      configure: () => {
        remoteControlEnabled = false;
      },
      payload: { channel: 'maker:list-active', args: [] },
    },
    {
      name: 'revoked controller',
      configure: () => {
        revokedControllers = ['ctrl-a'];
      },
      payload: { channel: 'maker:list-active', args: [] },
    },
    {
      name: 'non-allowlisted channel',
      configure: () => undefined,
      payload: { channel: 'shell:open-path', args: [] },
    },
    {
      name: 'malformed payload',
      configure: () => undefined,
      payload: undefined,
    },
  ])('被拒绝的 $name 不持有更新 busy lease', async ({ configure, payload }) => {
    configure();
    const busyChanges: boolean[] = [];
    setRemoteInvokeBusyChangedListener((busy) => busyChanges.push(busy));
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed({
      v: 1,
      kind: 'invoke',
      id: `invoke-rejected-${calls.invokeResult.length}`,
      src: 'ctrl-a',
      payload,
    });

    await vi.waitFor(() => expect(calls.invokeResult).toHaveLength(1));
    expect(hasInFlightRemoteInvokes()).toBe(false);
    expect(busyChanges).toEqual([]);
  });
});

// ─── 订阅 registry + topic-scoped fan-out + set-* 持久化回流(push 驱动重构)──────

const SUB = 'device-link:subscribe';
const UNSUB = 'device-link:unsubscribe';

/** feed 一个 subscribe/unsubscribe 控制帧(走 invoke 帧承载)。 */
function subFrame(
  src: string,
  channel: string,
  topics: string[],
  controllerName?: string,
  capabilities?: unknown,
): Envelope {
  return {
    v: 1,
    kind: 'invoke',
    id: `q-${src}-${topics.join(',')}${channel === UNSUB ? '-unsubscribe' : ''}`,
    src,
    payload: {
      channel,
      args: [{
        topics,
        ...(controllerName ? { controllerName } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      }],
    },
  };
}

describe('被控端订阅 registry + topic 转发', () => {
  it('subscribe frame negotiates bounded capabilities and rejects malformed shapes', () => {
    const { client, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed(subFrame(
      'ctrl-current',
      SUB,
      ['sessions'],
      'Current',
      ['provider-logo-kinds-v2'],
    ));
    expect(dispatchTesting.controllerSupports(
      'ctrl-current',
      'provider-logo-kinds-v2',
    )).toBe(true);

    feed(subFrame('ctrl-malformed', SUB, ['sessions'], 'Malformed', { invalid: true }));
    expect(dispatchTesting.controllerSupports(
      'ctrl-malformed',
      'provider-logo-kinds-v2',
    )).toBe(false);
  });

  it('link-close(transport-timeout) 保留被控端反向控制状态;永久关闭 reason 维持清理语义', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    // 对端(另一台桌面)作为控制端订阅本机 sessions
    feed(subFrame('ctrl-desktop', SUB, ['sessions'], 'OtherMac'));
    calls.push.length = 0;

    // 对端作为**被控端**对另一条方向的 link 做瞬时重置 → 发来 transport-timeout。
    // 互控场景下这不得清掉它作为控制端的订阅/记忆路由——否则反向实时推送
    // 静默断流而对端毫不知情。
    feed({
      v: 1,
      kind: 'link-close',
      src: 'ctrl-desktop',
      payload: { reason: 'transport-timeout' },
    });
    tapWindowBroadcast('local-db:sessions:created', { sessionId: 's1' });
    expect(calls.push).toEqual([
      { dst: 'ctrl-desktop', channel: 'local-db:sessions:created', payload: { sessionId: 's1' } },
    ]);

    // 永久关闭(user)仍完整清理
    calls.push.length = 0;
    feed({ v: 1, kind: 'link-close', src: 'ctrl-desktop', payload: { reason: 'user' } });
    tapWindowBroadcast('local-db:sessions:created', { sessionId: 's2' });
    expect(calls.push).toEqual([]);
  });

  it('subscribe 帧 → 回 invoke-result;sessions topic 只发列表订阅者,不发未订阅的 heavy 事件', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed(subFrame('ctrl-a', SUB, ['sessions'], 'MacA'));
    expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'q-ctrl-a-sessions',
      payload: { ok: true, result: { ok: true } },
    });

    tapWindowBroadcast('local-db:sessions:created', { sessionId: 's1' });
    expect(calls.push).toEqual([
      { dst: 'ctrl-a', channel: 'local-db:sessions:created', payload: { sessionId: 's1' } },
    ]);

    calls.push.length = 0;
    tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, {
      sessionId: 's1',
      phase: 'running',
      compactDetail: 'Editing README',
    });
    expect(calls.push).toEqual([
      {
        dst: 'ctrl-a',
        channel: SESSION_ACTIVITY_CHANNEL,
        payload: { sessionId: 's1', phase: 'running', compactDetail: 'Editing README' },
      },
    ]);

    // 只订阅了 sessions → maker:event(session:s1)不转发(bandwidth scoping)
    calls.push.length = 0;
    tapWindowBroadcast('maker:event', { sessionId: 's1', event: {} });
    expect(calls.push).toEqual([]);
  });

  it('sessions subscribe triggers a current activity replay for late list subscribers', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    setSessionsSubscribedListener(() => {
      tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, {
        sessionId: 's1',
        phase: 'running',
        compactDetail: 'Running tests',
      });
    });

    feed(subFrame('ctrl-a', SUB, ['sessions'], 'MacA'));

    expect(calls.push).toEqual([
      {
        dst: 'ctrl-a',
        channel: SESSION_ACTIVITY_CHANNEL,
        payload: {
          sessionId: 's1',
          phase: 'running',
          compactDetail: 'Running tests',
        },
      },
    ]);
  });

  describe('会话活动出站整流(latest-wins 暂存)', () => {
    it('窗口占用达软上限时暂存并合并同会话帧;窗口空出后只发最新值', async () => {
      vi.useFakeTimers();
      try {
        remoteControlEnabled = true;
        const { client, calls, feed, setReliableSendQueueDepth } = makeFakeClient();
        wireInboundDispatch(client);
        feed(subFrame('ctrl-a', SUB, ['sessions'], 'MacA'));
        calls.push.length = 0;

        setReliableSendQueueDepth(dispatchTesting.sessionActivityWindowSoftCap);
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's1', phase: 'running', compactDetail: 'step 1' });
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's1', phase: 'running', compactDetail: 'step 2' });
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's2', phase: 'running', compactDetail: 'other' });
        expect(calls.push).toEqual([]);
        // 同一会话只保留最新值 → 暂存里只有 s1 + s2 两个键
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(2);

        setReliableSendQueueDepth(0);
        await vi.advanceTimersByTimeAsync(dispatchTesting.sessionActivityDrainRetryMs);
        expect(calls.push).toEqual([
          {
            dst: 'ctrl-a',
            channel: SESSION_ACTIVITY_CHANNEL,
            payload: { sessionId: 's1', phase: 'running', compactDetail: 'step 2' },
          },
          {
            dst: 'ctrl-a',
            channel: SESSION_ACTIVITY_CHANNEL,
            payload: { sessionId: 's2', phase: 'running', compactDetail: 'other' },
          },
        ]);
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('BACKPRESSURE 保留暂存退避重试;其它错误沿 best-effort 丢弃不堵队', async () => {
      vi.useFakeTimers();
      try {
        remoteControlEnabled = true;
        const { client, calls, feed, failNextPush } = makeFakeClient();
        wireInboundDispatch(client);
        feed(subFrame('ctrl-a', SUB, ['sessions'], 'MacA'));
        calls.push.length = 0;

        failNextPush(new DeviceLinkError('BACKPRESSURE', 'buffer full'));
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's1', phase: 'running', compactDetail: 'busy' });
        expect(calls.push).toEqual([]);
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(1);

        await vi.advanceTimersByTimeAsync(dispatchTesting.sessionActivityDrainRetryMs);
        expect(calls.push).toEqual([
          {
            dst: 'ctrl-a',
            channel: SESSION_ACTIVITY_CHANNEL,
            payload: { sessionId: 's1', phase: 'running', compactDetail: 'busy' },
          },
        ]);

        // 非背压错误(如 PAYLOAD_TOO_LARGE)丢弃该条,后续帧不受影响
        calls.push.length = 0;
        failNextPush(new DeviceLinkError('PAYLOAD_TOO_LARGE', 'too large'));
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's3', phase: 'running', compactDetail: 'x' });
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(0);
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's4', phase: 'running', compactDetail: 'y' });
        expect(calls.push).toEqual([
          {
            dst: 'ctrl-a',
            channel: SESSION_ACTIVITY_CHANNEL,
            payload: { sessionId: 's4', phase: 'running', compactDetail: 'y' },
          },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('定向 replay 只投给目标控制端,不扇出给其它订阅者;未订阅目标为 no-op', () => {
      remoteControlEnabled = true;
      const { client, calls, feed } = makeFakeClient();
      wireInboundDispatch(client);
      feed(subFrame('ctrl-a', SUB, ['sessions'], 'MacA'));
      feed(subFrame('ctrl-b', SUB, ['sessions'], 'MacB'));
      calls.push.length = 0;

      pushSessionActivityToController('ctrl-b', { sessionId: 's1', phase: 'running', compactDetail: 'replay' });
      expect(calls.push).toEqual([
        {
          dst: 'ctrl-b',
          channel: SESSION_ACTIVITY_CHANNEL,
          payload: { sessionId: 's1', phase: 'running', compactDetail: 'replay' },
        },
      ]);

      // 未订阅 sessions 的控制端:不投递、不暂存
      calls.push.length = 0;
      pushSessionActivityToController('ctrl-unknown', { sessionId: 's1', phase: 'running', compactDetail: 'replay' });
      expect(calls.push).toEqual([]);
      expect(dispatchTesting.sessionActivityStageSize('ctrl-unknown')).toBe(0);
    });

    it('relay 离线期间保持退避重试,恢复在线后无需新事件即自动投递暂存值', async () => {
      vi.useFakeTimers();
      try {
        remoteControlEnabled = true;
        const { client, calls, feed, setStatus, setReliableSendQueueDepth } = makeFakeClient();
        wireInboundDispatch(client);
        feed(subFrame('ctrl-a', SUB, ['sessions'], 'MacA'));
        calls.push.length = 0;

        // 背压下暂存 → 随后 relay 离线
        setReliableSendQueueDepth(dispatchTesting.sessionActivityWindowSoftCap);
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's1', phase: 'completed', compactDetail: '', attention: false });
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(1);
        setStatus('connecting');
        setReliableSendQueueDepth(0);

        // 离线期间定时器照常触发:不投递、不丢暂存、继续自我调度
        await vi.advanceTimersByTimeAsync(dispatchTesting.sessionActivityDrainRetryMs * 3);
        expect(calls.push).toEqual([]);
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(1);

        // 恢复在线:无需新活动事件/重订阅,下一轮重试自动投递
        setStatus('online');
        await vi.advanceTimersByTimeAsync(dispatchTesting.sessionActivityDrainRetryMs);
        expect(calls.push).toEqual([
          {
            dst: 'ctrl-a',
            channel: SESSION_ACTIVITY_CHANNEL,
            payload: { sessionId: 's1', phase: 'completed', compactDetail: '', attention: false },
          },
        ]);
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('退订 sessions 清空该控制端暂存(含排期中的重试)', async () => {
      vi.useFakeTimers();
      try {
        remoteControlEnabled = true;
        const { client, calls, feed, setReliableSendQueueDepth } = makeFakeClient();
        wireInboundDispatch(client);
        feed(subFrame('ctrl-a', SUB, ['sessions'], 'MacA'));
        calls.push.length = 0;

        setReliableSendQueueDepth(dispatchTesting.sessionActivityWindowSoftCap);
        tapWindowBroadcast(SESSION_ACTIVITY_CHANNEL, { sessionId: 's1', phase: 'running', compactDetail: 'staged' });
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(1);

        feed(subFrame('ctrl-a', UNSUB, ['sessions']));
        expect(dispatchTesting.sessionActivityStageSize('ctrl-a')).toBe(0);

        setReliableSendQueueDepth(0);
        await vi.advanceTimersByTimeAsync(dispatchTesting.sessionActivityDrainRetryMs * 2);
        expect(calls.push).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('订阅 session:<id> → heavy 事件转发 + 横幅亮;纯 sessions 不亮横幅', () => {
    remoteControlEnabled = true;
    const changes: ActiveController[][] = [];
    setControllersChangedListener((cs) => changes.push(cs));
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed(subFrame('ctrl-a', SUB, ['sessions']));
    expect(changes.at(-1)).toEqual([]); // 纯 sessions → 无横幅

    feed(subFrame('ctrl-a', SUB, ['session:s1'], 'MacA'));
    expect(changes.at(-1)).toEqual([{ deviceId: 'ctrl-a', name: 'MacA' }]); // 横幅亮

    tapWindowBroadcast('maker:event', { sessionId: 's1', event: { t: 1 } });
    expect(calls.push).toContainEqual({
      dst: 'ctrl-a',
      channel: 'maker:event',
      payload: { sessionId: 's1', event: { t: 1 } },
    });
  });

  it('空 subscribe 保留 legacy wildcard，现代有效 subscribe 替换它且重复 open 不恢复', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed({
      v: 1,
      kind: 'link-open',
      id: 'open-modern',
      src: 'ctrl-modern',
      payload: {
        controllerName: 'Modern',
        protocolVersion: 1,
        appVersion: '1.0.0',
        capabilities: ['provider-logo-kinds-v2'],
      },
    });
    expect(getUpdateRelaunchControllers()).toEqual([
      { deviceId: 'ctrl-modern', name: 'Modern' },
    ]);

    feed(subFrame('ctrl-modern', SUB, ['*', 'garbage', 'session:', 'fs-watch:']));
    expect(getUpdateRelaunchControllers()).toEqual([
      { deviceId: 'ctrl-modern', name: 'Modern' },
    ]);

    feed(subFrame('ctrl-modern', SUB, ['sessions'], 'Modern'));

    expect(dispatchTesting.getActiveControllers()).toEqual([]);
    expect(dispatchTesting.getUpdateRelaunchControllers()).toEqual([]);
    expect(dispatchTesting.controllerSupports(
      'ctrl-modern',
      'provider-logo-kinds-v2',
    )).toBe(true);

    feed({
      v: 1,
      kind: 'link-open',
      id: 'open-modern-again',
      src: 'ctrl-modern',
      payload: {
        controllerName: 'Modern renamed',
        protocolVersion: 1,
        appVersion: '1.0.0',
        capabilities: ['provider-logo-kinds-v2'],
      },
    });
    expect(dispatchTesting.getActiveControllers()).toEqual([]);
    expect(dispatchTesting.getUpdateRelaunchControllers()).toEqual([]);
    expect(dispatchTesting.controllerSupports(
      'ctrl-modern',
      'provider-logo-kinds-v2',
    )).toBe(true);

    tapWindowBroadcast('local-db:sessions:created', { sessionId: 's1' });
    tapWindowBroadcast('maker:event', { sessionId: 's1', event: {} });
    expect(calls.push).toEqual([
      {
        dst: 'ctrl-modern',
        channel: 'local-db:sessions:created',
        payload: { sessionId: 's1' },
      },
    ]);

    feed({
      v: 1,
      kind: 'link-close',
      src: 'ctrl-modern',
      payload: { reason: 'user' },
    });
    feed({
      v: 1,
      kind: 'link-open',
      id: 'open-after-disconnect',
      src: 'ctrl-modern',
      payload: {
        controllerName: 'Modern reconnect',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });
    expect(getUpdateRelaunchControllers()).toEqual([]);
    feed(subFrame('ctrl-modern', SUB, ['session:s1'], 'Modern reconnect'));
    expect(getUpdateRelaunchControllers()).toEqual([
      { deviceId: 'ctrl-modern', name: 'Modern reconnect' },
    ]);
  });

  it('modern reconnect after releasing every topic waits for a fresh subscribe', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed({
      v: 1,
      kind: 'link-open',
      id: 'open-modern',
      src: 'ctrl-modern',
      payload: {
        controllerName: 'Modern',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });
    feed(subFrame('ctrl-modern', SUB, ['sessions'], 'Modern'));
    feed(subFrame('ctrl-modern', UNSUB, ['sessions']));
    handleControllerOffline('ctrl-modern');

    feed({
      v: 1,
      kind: 'link-open',
      id: 'open-modern-again',
      src: 'ctrl-modern',
      payload: {
        controllerName: 'Modern reconnect',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });

    tapWindowBroadcast('local-db:sessions:created', { sessionId: 's1' });
    tapWindowBroadcast('maker:event', { sessionId: 's1', event: {} });

    expect(calls.push).toEqual([]);
    expect(getUpdateRelaunchControllers()).toEqual([]);
  });

  it('dropAll closes an accepted modern reconnect before explicit subscribe', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-modern', SUB, ['sessions'], 'Modern'));
    handleControllerOffline('ctrl-modern');

    feed({
      v: 1,
      kind: 'link-open',
      id: 'open-modern-again',
      src: 'ctrl-modern',
      payload: {
        controllerName: 'Modern reconnect',
        protocolVersion: 1,
        appVersion: '1.0.0',
      },
    });
    dropAllControllers(client, 'shutdown');

    expect(calls.closed).toContainEqual({
      dst: 'ctrl-modern',
      reason: 'shutdown',
    });
  });

  it('无人值守更新忽略纯 sessions viewer，但保护文件浏览和实际会话控制', () => {
    remoteControlEnabled = true;
    const changes: Array<{
      controlled: ActiveController[];
      updateBusy: ActiveController[];
    }> = [];
    setControllersChangedListener((controlled, updateBusy) =>
      changes.push({ controlled, updateBusy }),
    );
    const { client, feed } = makeFakeClient();
    wireInboundDispatch(client);

    feed(subFrame('ctrl-empty', SUB, []));
    feed(subFrame('ctrl-invalid', SUB, ['*', 'garbage', 'session:', 'fs-watch:']));
    expect(getActiveControllers()).toEqual([]);

    feed(subFrame('ctrl-viewer', SUB, ['sessions'], 'Viewer'));

    expect(getActiveControllers()).toEqual([]);
    expect(getUpdateRelaunchControllers()).toEqual([]);
    expect(changes.at(-1)).toEqual({ controlled: [], updateBusy: [] });

    feed(subFrame('ctrl-viewer', SUB, ['fs-watch:/repo'], 'Viewer'));
    expect(getActiveControllers()).toEqual([]);
    expect(getUpdateRelaunchControllers()).toEqual([
      { deviceId: 'ctrl-viewer', name: 'Viewer' },
    ]);
    expect(changes.at(-1)).toEqual({
      controlled: [],
      updateBusy: [{ deviceId: 'ctrl-viewer', name: 'Viewer' }],
    });

    feed(subFrame('ctrl-viewer', UNSUB, ['fs-watch:/repo']));
    expect(getActiveControllers()).toEqual([]);
    expect(getUpdateRelaunchControllers()).toEqual([]);
    expect(changes.at(-1)).toEqual({ controlled: [], updateBusy: [] });

    feed(subFrame('ctrl-viewer', SUB, ['session:s1'], 'Viewer'));
    expect(getActiveControllers()).toEqual([
      { deviceId: 'ctrl-viewer', name: 'Viewer' },
    ]);
    expect(getUpdateRelaunchControllers()).toEqual([
      { deviceId: 'ctrl-viewer', name: 'Viewer' },
    ]);
    expect(changes.at(-1)).toEqual({
      controlled: [{ deviceId: 'ctrl-viewer', name: 'Viewer' }],
      updateBusy: [{ deviceId: 'ctrl-viewer', name: 'Viewer' }],
    });
  });

  it('多控制端:各只收自己订阅 session 的 push', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-a', SUB, ['session:s1']));
    feed(subFrame('ctrl-b', SUB, ['session:s2']));
    tapWindowBroadcast('maker:event', { sessionId: 's1', event: {} });
    expect(calls.push).toEqual([
      { dst: 'ctrl-a', channel: 'maker:event', payload: { sessionId: 's1', event: {} } },
    ]);
  });

  it('device-link strips Desktop-only plugin setup helpers without mutating local push', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-a', SUB, ['session:s1']));
    const payload = {
      sessionId: 's1',
      request: {
        kind: 'plugin_setup',
        requestId: 'setup-1',
        revision: 1,
        ghost: { id: 'generic-plugin', name: 'Generic plugin' },
        steps: [
          {
            id: 'api-key',
            groupId: 'credentials',
            groupMode: 'any_of',
            title: 'API key',
            description: 'Configure a key',
            phase: 'pending',
            action: {
              id: 'inline_form:opaque',
              kind: 'inline_form',
              form: {
                fields: [
                  {
                    id: 'value',
                    type: 'secret',
                    label: 'API key',
                    externalLink: { url: 'https://desktop-only.example/keys' },
                    required: true,
                    maxLength: 4096,
                  },
                ],
              },
            },
          },
        ],
      },
    };

    tapWindowBroadcast(MAKER_PUSH.INTERACTION_REQUEST, payload);

    expect(calls.push).toHaveLength(1);
    expect(calls.push[0]).toMatchObject({
      dst: 'ctrl-a',
      channel: MAKER_PUSH.INTERACTION_REQUEST,
      payload: {
        sessionId: 's1',
        request: {
          kind: 'plugin_setup',
          ghost: { id: 'generic-plugin' },
          steps: [
            {
              action: {
                kind: 'inline_form',
                form: {
                  fields: [
                    {
                      id: 'value',
                      label: 'API key',
                      required: true,
                      maxLength: 4096,
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(calls.push[0].payload)).not.toContain('desktop-only.example');
    expect(payload.request.steps[0].action.form.fields[0].externalLink).toEqual({
      url: 'https://desktop-only.example/keys',
    });
  });

  it.each([
    'issue_confirm',
    'rename_sessions_confirm',
    'ghost_grant_confirm',
  ])('device-link does not forward Desktop-only %s live pushes', (kind) => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-a', SUB, ['session:s1']));

    tapWindowBroadcast(MAKER_PUSH.INTERACTION_REQUEST, {
      sessionId: 's1',
      request: {
        kind,
        requestId: `${kind}-1`,
        absPath: '/Users/me/private.png',
        previewDataUrl: 'data:image/png;base64,private',
      },
    });

    expect(calls.push).toEqual([]);
  });

  it('explicit unsubscribe removes the final remembered topic and stops the tap', () => {
    remoteControlEnabled = true;
    const { client, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-a', SUB, ['sessions']));
    expect(hasBroadcastTapListener()).toBe(true);
    feed(subFrame('ctrl-a', UNSUB, ['sessions']));
    expect(hasBroadcastTapListener()).toBe(false);
  });

  it('relay-offline queues broadcasts for active topic subscribers', () => {
    remoteControlEnabled = true;
    const { client, calls, feed, setStatus } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-a', SUB, ['session:s1']));
    setStatus('connecting');

    tapWindowBroadcast('local-db:messages:created', {
      sessionId: 's1',
      id: 'm1',
    });

    expect(calls.push).toEqual([]);
    expect(dispatchTesting.queuedPushesFor('ctrl-a')).toEqual([
      {
        channel: 'local-db:messages:created',
        payload: { sessionId: 's1', id: 'm1' },
        topic: 'session:s1',
      },
    ]);
  });

  it('presence-offline keeps the tap alive and queues broadcasts for remembered topics', () => {
    remoteControlEnabled = true;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-a', SUB, ['session:s1']));
    handleControllerOffline('ctrl-a');

    expect(hasBroadcastTapListener()).toBe(true);
    tapWindowBroadcast('local-db:messages:created', {
      sessionId: 's1',
      id: 'm1',
    });

    expect(calls.push).toEqual([]);
    expect(dispatchTesting.queuedPushesFor('ctrl-a')).toEqual([
      {
        channel: 'local-db:messages:created',
        payload: { sessionId: 's1', id: 'm1' },
        topic: 'session:s1',
      },
    ]);
  });

  it('开关关闭 → subscribe 帧回 REMOTE_DISABLED,不记录', () => {
    remoteControlEnabled = false;
    const { client, calls, feed } = makeFakeClient();
    wireInboundDispatch(client);
    feed(subFrame('ctrl-a', SUB, ['sessions']));
    expect(calls.invokeResult).toContainEqual({
      dst: 'ctrl-a',
      requestId: 'q-ctrl-a-sessions',
      payload: { ok: false, error: { code: 'REMOTE_DISABLED', message: 'remote control disabled' } },
    });
    expect(hasBroadcastTapListener()).toBe(false);
  });
});

describe('远程 set-* 持久化回流', () => {
  it('set-model 成功后注入的 persist 被以 {model} 调用', async () => {
    const persist = vi.fn();
    setRemoteSettingsPersist(persist);
    registry.register('maker:set-model', () => undefined);
    const r = await runInvoke('ctrl-a', { channel: 'maker:set-model', args: ['sess-1', 'claude-x'] });
    expect(r).toMatchObject({ ok: true });
    expect(persist).toHaveBeenCalledWith('sess-1', { model: 'claude-x' });
  });

  it('set-model 持久化 trim 后的 providerId', async () => {
    const persist = vi.fn();
    setRemoteSettingsPersist(persist);
    registry.register('maker:set-model', () => undefined);

    const r = await runInvoke('ctrl-a', {
      channel: 'maker:set-model',
      args: ['sess-1', 'claude-x', '  anthropic  '],
    });

    expect(r).toMatchObject({ ok: true });
    expect(persist).toHaveBeenCalledWith('sess-1', {
      model: 'claude-x',
      providerId: 'anthropic',
    });
  });

  it('set-model handler 返回 superseded 时不持久化过期 model/provider', async () => {
    const persist = vi.fn();
    setRemoteSettingsPersist(persist);
    registry.register('maker:set-model', () => ({ deferred: false, superseded: true }));

    const r = await runInvoke('ctrl-a', {
      channel: 'maker:set-model',
      args: ['sess-1', 'stale-model', 'stale-provider', 7],
    });

    expect(r).toEqual({ ok: true, result: { deferred: false, superseded: true } });
    expect(persist).not.toHaveBeenCalled();
  });

  it('set-model handler 已在 session 锁内持久化时 dispatch 不重复回流', async () => {
    const persist = vi.fn();
    setRemoteSettingsPersist(persist);
    const handlerResult = { deferred: false, superseded: false };
    markRemoteSettingPersistedInsideHandler(handlerResult);
    registry.register('maker:set-model', () => handlerResult);

    const r = await runInvoke('ctrl-a', {
      channel: 'maker:set-model',
      args: ['sess-1', 'claude-x', 'anthropic'],
    });

    expect(r).toEqual({ ok: true, result: handlerResult });
    expect(persist).not.toHaveBeenCalled();
  });

  it('set-fast-mode → {fastMode}', async () => {
    const persist = vi.fn();
    setRemoteSettingsPersist(persist);
    registry.register('maker:set-fast-mode', () => undefined);
    await runInvoke('ctrl-a', { channel: 'maker:set-fast-mode', args: ['sess-1', true] });
    expect(persist).toHaveBeenCalledWith('sess-1', { fastMode: true });
  });

  it('set-plan-mode → {planModeEnabled}', async () => {
    const persist = vi.fn();
    setRemoteSettingsPersist(persist);
    registry.register('maker:set-plan-mode', () => undefined);
    await runInvoke('ctrl-a', { channel: 'maker:set-plan-mode', args: ['sess-1', true] });
    expect(persist).toHaveBeenCalledWith('sess-1', { planModeEnabled: true });
  });

  it('set-model 等待注入 persist 完成后才返回 ok', async () => {
    let resolvePersist!: () => void;
    let resolved = false;
    const persist = vi.fn(() => new Promise<void>((resolve) => {
      resolvePersist = resolve;
    }));
    setRemoteSettingsPersist(persist);
    registry.register('maker:set-model', () => 'runtime-ok');

    const pending = runInvoke('ctrl-a', {
      channel: 'maker:set-model',
      args: ['sess-1', 'claude-x'],
    }).then((result) => {
      resolved = true;
      return result;
    });

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(persist).toHaveBeenCalledWith('sess-1', { model: 'claude-x' });
    expect(resolved).toBe(false);

    resolvePersist();
    await expect(pending).resolves.toEqual({ ok: true, result: 'runtime-ok' });
  });

  it('set-fast-mode persist 失败时返回 IPC_ERROR,不报告远程设置成功', async () => {
    const persist = vi.fn(async () => {
      throw new Error('db write failed');
    });
    setRemoteSettingsPersist(persist);
    registry.register('maker:set-fast-mode', () => undefined);

    const r = await runInvoke('ctrl-a', {
      channel: 'maker:set-fast-mode',
      args: ['sess-1', true],
    });

    expect(r).toMatchObject({
      ok: false,
      error: { code: 'IPC_ERROR', message: 'db write failed' },
    });
  });

  it('非 set-* channel 不触发 persist', async () => {
    const persist = vi.fn();
    setRemoteSettingsPersist(persist);
    registry.register('maker:list-active', () => []);
    await runInvoke('ctrl-a', { channel: 'maker:list-active', args: [] });
    expect(persist).not.toHaveBeenCalled();
  });

  it('未注入 persist 时 set-model 仍正常(no-op 回流)', async () => {
    registry.register('maker:set-model', () => undefined);
    const r = await runInvoke('ctrl-a', { channel: 'maker:set-model', args: ['sess-1', 'm'] });
    expect(r).toMatchObject({ ok: true });
  });
});
