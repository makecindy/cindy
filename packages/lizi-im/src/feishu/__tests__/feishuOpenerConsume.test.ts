/**
 * FeishuIM 开场白卡消费(consumePendingOpenerCard / consumePendingOpenerAsCard)
 * 的失败语义: patch/替换失败时认领已完成 — 撤回开场白卡(不让「思考中」卡
 * 永久残留)并返回 false 让编排层回落正常发送。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '../../types.js';

const fakeClient = { fake: 'client' };

const outboundMocks = vi.hoisted(() => ({
  claimPatchableOpener: vi.fn<() => string | null>(() => null),
  getBoundClient: vi.fn<() => { fake: string } | null>(() => ({ fake: 'client' })),
  recallOwnMessageWith: vi.fn(async () => true),
  updateInteractive: vi.fn(async () => undefined),
  registerCardLane: vi.fn(),
  rearmAnchorToTrigger: vi.fn(() => true),
  deferOpenerConsume: vi.fn(),
  sendInteractive: vi.fn(async () => ({ messageId: 'om_sent' })),
  drainDeferredOpenerConsumes: vi.fn<
    () => Array<{
      userId: string;
      openerId: string;
      markdown?: string;
      spec?: { body: string; buttons: unknown[] };
    }>
  >(() => []),
  takeMatchingDeferredOpenerConsume: vi.fn<
    () =>
      | ({
          userId: string;
          openerId: string;
          markdown?: string;
          spec?: { body: string; buttons: unknown[] };
        } & { epoch: number })
      | undefined
  >(() => undefined),
  takeDeferredOpenerConsumeById: vi.fn<
    (openerId: string) =>
      | ({
          userId: string;
          openerId: string;
          markdown?: string;
          spec?: { body: string; buttons: unknown[] };
        } & { epoch: number })
      | undefined
  >(() => undefined),
  drainEvictedOpeners: vi.fn(() => []),
  getAccountEpoch: vi.fn(() => 0),
  recallOwnMessage: vi.fn(async () => true),
  sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
  getOpenerTrigger: vi.fn(() => undefined),
}));

vi.mock('../outbound.js', () => ({
  claimPatchableOpener: outboundMocks.claimPatchableOpener,
  getBoundClient: outboundMocks.getBoundClient,
  recallOwnMessageWith: outboundMocks.recallOwnMessageWith,
  recallOwnMessage: outboundMocks.recallOwnMessage,
  updateInteractive: outboundMocks.updateInteractive,
  registerCardLane: outboundMocks.registerCardLane,
  rearmAnchorToTrigger: outboundMocks.rearmAnchorToTrigger,
  deferOpenerConsume: outboundMocks.deferOpenerConsume,
  drainDeferredOpenerConsumes: outboundMocks.drainDeferredOpenerConsumes,
  takeMatchingDeferredOpenerConsume: outboundMocks.takeMatchingDeferredOpenerConsume,
  takeDeferredOpenerConsumeById: outboundMocks.takeDeferredOpenerConsumeById,
  drainEvictedOpeners: outboundMocks.drainEvictedOpeners,
  getAccountEpoch: outboundMocks.getAccountEpoch,
  sendInteractive: outboundMocks.sendInteractive,
  sendText: outboundMocks.sendText,
  getOpenerTrigger: outboundMocks.getOpenerTrigger,
}));

vi.mock('../streamingText.js', () => ({
  patchMarkdown: vi.fn(async () => undefined),
}));

vi.mock('../wsClient.js', () => ({
  QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS: 4500,
  getCurrentStatus: () => 'idle',
  getCurrentBotAppId: () => null,
  setLifecycleAnnouncement: vi.fn(),
  stop: vi.fn(async () => undefined),
  start: vi.fn(async () => 'connected' as const),
}));

vi.mock('../storage.js', () => ({
  readCredentials: () => null,
  readOwnerOpenId: () => null,
  readLifecycleAnnouncement: () => true,
  writeLifecycleAnnouncement: vi.fn(),
  writeCredentials: vi.fn(),
  writeOwnerOpenId: vi.fn(),
  clearAll: vi.fn(),
}));

vi.mock('../ownerGuard.js', () => ({
  loadFromDisk: vi.fn(),
  firstAllowed: () => null,
  clear: vi.fn(),
}));

vi.mock('../appRegistration.js', () => ({
  requestAppRegistration: vi.fn(),
  pollAppRegistration: vi.fn(),
}));

vi.mock('../moduleScope.js', () => ({
  getLog: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
  setHost: vi.fn(),
}));

import { FeishuIM } from '../index.js';
import { feishuEvents } from '../events.js';
import * as streamingText from '../streamingText.js';

let im: FeishuIM;

const SPEC = { body: 'picker', buttons: [] };

describe('FeishuIM opener consumption failure semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    im = new FeishuIM({} as unknown as IMHost);
    outboundMocks.drainDeferredOpenerConsumes.mockReset();
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValue([]);
    outboundMocks.takeMatchingDeferredOpenerConsume.mockReset();
    outboundMocks.takeMatchingDeferredOpenerConsume.mockReturnValue(undefined);
    outboundMocks.takeDeferredOpenerConsumeById.mockReset();
    outboundMocks.takeDeferredOpenerConsumeById.mockReturnValue(undefined);
    outboundMocks.drainEvictedOpeners.mockReset();
    outboundMocks.drainEvictedOpeners.mockReturnValue([]);
    outboundMocks.getAccountEpoch.mockReset();
    outboundMocks.getAccountEpoch.mockReturnValue(0);
    outboundMocks.sendInteractive.mockReset();
    outboundMocks.sendInteractive.mockResolvedValue({ messageId: 'om_sent' });
    outboundMocks.sendText.mockReset();
    outboundMocks.sendText.mockResolvedValue({ messageId: 'om_sent' });
    outboundMocks.deferOpenerConsume.mockReset();
    outboundMocks.recallOwnMessageWith.mockReset();
    outboundMocks.recallOwnMessageWith.mockResolvedValue(true);
    outboundMocks.updateInteractive.mockReset();
    outboundMocks.updateInteractive.mockResolvedValue(undefined);
    outboundMocks.registerCardLane.mockReset();
    outboundMocks.rearmAnchorToTrigger.mockReset();
    outboundMocks.rearmAnchorToTrigger.mockReturnValue(true);
    outboundMocks.claimPatchableOpener.mockReset();
    outboundMocks.claimPatchableOpener.mockReturnValue(null);
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockReset();
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // 默认有绑定 client — 个别用例覆盖为 null, 不能泄漏到后续用例。
    outboundMocks.getBoundClient.mockReturnValue({ fake: 'client' });
  });

  afterEach(async () => {
    await im.dispose();
    vi.useRealTimers();
  });

  async function queueOriginalFallback(openerId: string, markdown: string): Promise<void> {
    outboundMocks.getBoundClient.mockReturnValue(null);
    outboundMocks.claimPatchableOpener.mockReturnValue(openerId);
    await im.consumePendingOpenerCard('g/oc_c/omt_t', markdown);
    outboundMocks.getBoundClient.mockReturnValue({ fake: 'client' });
  }

  async function sendOriginalFallback(
    userId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const fallbackOpenerId = im.takeNotedFallbackOpenerId(userId, 'markdown');
    return im.sendText(userId, text, { fallbackOpenerId });
  }

  it('兜底发送就地收口撤回失败不另发, 重新暂存', async () => {
    await queueOriginalFallback('om_reserved', '终态');
    outboundMocks.takeDeferredOpenerConsumeById.mockReturnValueOnce({
      userId: 'g/oc_c/omt_t',
      openerId: 'om_reserved',
      markdown: '终态',
      epoch: 0,
    });
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('patch failed'),
    );
    outboundMocks.recallOwnMessageWith.mockResolvedValueOnce(false);

    await expect(sendOriginalFallback('g/oc_c/omt_t', '兜底')).rejects.toThrow('patch failed');
    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalled();
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_reserved',
        markdown: '终态',
      }),
    );
  });

  it('同账号未换代时最终发送失败也重新暂存, 进入退避排空', async () => {
    await queueOriginalFallback('om_reserved', '终态');
    outboundMocks.takeDeferredOpenerConsumeById.mockReturnValueOnce({
      userId: 'g/oc_c/omt_t',
      openerId: 'om_reserved',
      markdown: '终态',
      epoch: 0,
    });
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('rate limited'),
    );
    outboundMocks.sendText.mockRejectedValueOnce(new Error('rate limited'));

    await expect(sendOriginalFallback('g/oc_c/omt_t', '兜底')).rejects.toThrow('rate limited');
    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalled();
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_reserved',
        markdown: '终态',
      }),
    );
  });

  it('排空时撤回失败不补发终态, 重新入队', async () => {
    const pinned = { fake: 'pinned-client' };
    outboundMocks.getBoundClient.mockReturnValue(pinned);
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_opener', markdown: '兜底回复' },
    ]);
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('patch failed'),
    );
    outboundMocks.recallOwnMessageWith.mockResolvedValueOnce(false);

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalledWith(pinned, 'om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(outboundMocks.sendInteractive).not.toHaveBeenCalled();
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_opener',
        markdown: '兜底回复',
      }),
    );
  });

  it('排空时 patch 失败: 撤回 pin 到排空开始的 client 并补发终态兜底', async () => {
    const pinned = { fake: 'pinned-client' };
    outboundMocks.getBoundClient.mockReturnValue(pinned);
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_opener', markdown: '兜底回复' },
    ]);
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('patch failed'),
    );

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalledWith(pinned, 'om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).toHaveBeenCalledWith('g/oc_c/omt_t');
    // 补发兜底: 文本经 sendMarkdownText(sendInteractive) 正常发送。
    expect(outboundMocks.sendInteractive).toHaveBeenCalledWith('g/oc_c/omt_t', {
      body: '兜底回复',
      buttons: [],
    });
  });

  it('兜底发送就地收口预留 opener(不另发、不留思考卡)', async () => {
    // 空窗暂存后连接恢复: 兜底发送应优先 patch 预留卡, 而不是另发。
    await queueOriginalFallback('om_reserved', '回复');
    outboundMocks.takeDeferredOpenerConsumeById.mockReturnValueOnce({
      userId: 'g/oc_c/omt_t',
      openerId: 'om_reserved',
      markdown: '回复',
      epoch: 0,
    });

    const result = await sendOriginalFallback('g/oc_c/omt_t', '兜底');
    expect(outboundMocks.takeDeferredOpenerConsumeById).toHaveBeenCalledWith('om_reserved');
    expect(streamingText.patchMarkdown).toHaveBeenCalledWith('om_reserved', '回复');
    expect(result).toEqual({ messageId: 'om_reserved' });
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
  });

  it('排空兜底发送也失败(再次重连)时重新入队, 下一次 connected 重试', async () => {
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_opener', markdown: '终态' },
    ]);
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('patch failed'),
    );
    outboundMocks.sendInteractive.mockRejectedValueOnce(new Error('client unbound again'));

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    // 兜底发送失败 → 条目重新入队(终态不因一次失败永久丢失)。
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_opener',
        markdown: '终态',
      }),
    );
  });

  it('等待排空期间换代后丢弃旧轮次, 不回落用新账号发送', async () => {
    let rejectPatch!: (err: Error) => void;
    const patchGate = new Promise<void>((_resolve, reject) => {
      rejectPatch = reject;
    });
    await queueOriginalFallback('om_flushing', '终态回复');
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => patchGate,
    );
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_flushing', markdown: '终态回复' },
    ]);

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    const sendP = sendOriginalFallback('g/oc_c/omt_t', '兜底');
    outboundMocks.getAccountEpoch.mockReturnValue(1);
    outboundMocks.getBoundClient.mockReturnValue({ fake: 'account-b' });
    rejectPatch(new Error('patch failed after rebind'));

    await expect(sendP).rejects.toThrow(/account changed while waiting for opener flush/);
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
  });

  it('connected 排空与兜底发送重叠时复用在途暂存项, 不另发一份', async () => {
    let resolvePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    await queueOriginalFallback('om_flushing', '终态回复');
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => patchGate,
    );
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_flushing', markdown: '终态回复' },
    ]);
    outboundMocks.takeMatchingDeferredOpenerConsume.mockReturnValue(undefined);

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    const sendP = sendOriginalFallback('g/oc_c/omt_t', '兜底');
    resolvePatch();
    await expect(sendP).resolves.toEqual({ messageId: 'om_flushing' });
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
  });

  it('排空已成功后原兜底发送仍复用同一 opener, 不另发', async () => {
    await queueOriginalFallback('om_done', '终态回复');
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_done', markdown: '终态回复' },
    ]);
    outboundMocks.takeMatchingDeferredOpenerConsume.mockReturnValue(undefined);

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    await expect(sendOriginalFallback('g/oc_c/omt_t', '兜底')).resolves.toEqual({
      messageId: 'om_done',
    });
    expect(outboundMocks.sendText).not.toHaveBeenCalled();
  });

  it('排空完成后同 lane 后续发送不得认领旧 opener 终态', async () => {
    await queueOriginalFallback('om_done', '终态回复');
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_done', markdown: '终态回复' },
    ]);
    outboundMocks.takeMatchingDeferredOpenerConsume.mockReturnValue(undefined);

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    outboundMocks.sendText.mockResolvedValue({ messageId: 'om_help' });
    await expect(im.sendText('g/oc_c/omt_t', '/help')).resolves.toEqual({
      messageId: 'om_help',
    });
    expect(outboundMocks.sendText).toHaveBeenCalledWith('g/oc_c/omt_t', '/help');

    await expect(sendOriginalFallback('g/oc_c/omt_t', '兜底')).resolves.toEqual({
      messageId: 'om_done',
    });
  });

  it('排空进行中时同 lane 的新发送不认领旧终态', async () => {
    let resolvePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => patchGate,
    );
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t', openerId: 'om_flushing', markdown: '/new 回复' },
    ]);
    outboundMocks.sendText.mockResolvedValue({ messageId: 'om_help' });

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    const helpP = im.sendText('g/oc_c/omt_t', '/help');
    resolvePatch();
    await expect(helpP).resolves.toEqual({ messageId: 'om_help' });
    expect(outboundMocks.sendText).toHaveBeenCalledWith('g/oc_c/omt_t', '/help');
  });

  it('保持连接时重新入队后按退避再排空, 不依赖下一次 connected', async () => {
    vi.useFakeTimers();
    outboundMocks.drainDeferredOpenerConsumes
      .mockReturnValueOnce([
        { userId: 'g/oc_c/omt_t', openerId: 'om_opener', markdown: '终态' },
      ])
      .mockReturnValueOnce([
        { userId: 'g/oc_c/omt_t', openerId: 'om_opener', markdown: '终态' },
      ]);
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('patch failed'))
      .mockResolvedValueOnce(undefined);
    outboundMocks.sendInteractive.mockRejectedValueOnce(new Error('rate limited'));

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    await vi.advanceTimersByTimeAsync(0);
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledTimes(1);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(2);
    expect(streamingText.patchMarkdown).toHaveBeenNthCalledWith(2, 'om_opener', '终态');
    vi.useRealTimers();
  });

  it('排空持续失败时按退避上限停止, 不零延迟风暴', async () => {
    vi.useFakeTimers();
    outboundMocks.drainDeferredOpenerConsumes.mockImplementation(() => [
      { userId: 'g/oc_c/omt_t', openerId: 'om_opener', markdown: '终态' },
    ]);
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('patch failed'),
    );
    outboundMocks.sendInteractive.mockRejectedValue(new Error('rate limited'));

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    await vi.advanceTimersByTimeAsync(0);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(900);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2700);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streamingText.patchMarkdown).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it('consumePendingOpenerCard: 无 pending opener 返回 false(不撤回)', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue(null);
    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(false);
    expect(outboundMocks.recallOwnMessageWith).not.toHaveBeenCalled();
  });

  it('重连空窗(无绑定 client)暂存消费: 原子预留 opener 并携带 id, 返回 false', async () => {
    outboundMocks.getBoundClient.mockReturnValue(null);
    outboundMocks.claimPatchableOpener.mockReturnValue('om_reserved');
    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(false);
    await expect(im.consumePendingOpenerAsCard('g/oc_c/omt_t', SPEC)).resolves.toBe(false);
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_reserved',
        markdown: '回复',
      }),
    );
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_reserved',
        spec: SPEC,
      }),
    );
  });

  it('连接就绪后排空暂存消费: 用预留的 openerId patch 文本 / 替换卡片', async () => {
    outboundMocks.drainDeferredOpenerConsumes.mockReturnValueOnce([
      { userId: 'g/oc_c/omt_t1', openerId: 'om_opener', markdown: '回复' },
      { userId: 'g/oc_c/omt_t2', openerId: 'om_opener', spec: SPEC },
    ]);

    feishuEvents.emit('imStatus', { kind: 'connected', appId: 'cli' });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    // 排空不再 claim(暂存时已原子预留) — 不会被后续轮次认领。
    expect(outboundMocks.claimPatchableOpener).not.toHaveBeenCalled();
    expect(streamingText.patchMarkdown).toHaveBeenCalledWith('om_opener', '回复');
    expect(outboundMocks.updateInteractive).toHaveBeenCalledWith('om_opener', SPEC);
    expect(outboundMocks.registerCardLane).toHaveBeenCalledWith('g/oc_c/omt_t2', 'om_opener');
  });

  it('consumePendingOpenerCard: patch 失败时撤回开场白卡并返回 false(回落发送)', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('patch failed'),
    );
    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(false);
    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalledWith(fakeClient, 'om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).toHaveBeenCalledWith('g/oc_c/omt_t');
  });

  it('consumePendingOpenerCard: 撤回失败不回拨不另发, 重新暂存等重试', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('patch failed'),
    );
    outboundMocks.recallOwnMessageWith.mockResolvedValueOnce(false);

    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(false);
    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalledWith(fakeClient, 'om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_opener',
        markdown: '回复',
      }),
    );
    expect(im.takeNotedFallbackOpenerId('g/oc_c/omt_t', 'markdown')).toBe('om_opener');
  });

  it('consumePendingOpenerAsCard: 撤回失败不回拨不另发, 重新暂存', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    outboundMocks.updateInteractive.mockRejectedValueOnce(new Error('replace failed'));
    outboundMocks.recallOwnMessageWith.mockResolvedValueOnce(false);

    await expect(im.consumePendingOpenerAsCard('g/oc_c/omt_t', SPEC)).resolves.toBe(false);
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(outboundMocks.registerCardLane).not.toHaveBeenCalled();
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_opener',
        spec: SPEC,
      }),
    );
    expect(im.takeNotedFallbackOpenerId('g/oc_c/omt_t', 'spec')).toBe('om_opener');
  });

  it('consumePendingOpenerAsCard: 替换失败时撤回并返回 false', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    outboundMocks.updateInteractive.mockRejectedValueOnce(new Error('replace failed'));
    await expect(im.consumePendingOpenerAsCard('g/oc_c/omt_t', SPEC)).resolves.toBe(false);
    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalledWith(fakeClient, 'om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).toHaveBeenCalledWith('g/oc_c/omt_t');
    expect(outboundMocks.registerCardLane).not.toHaveBeenCalled();
  });

  it('consumePendingOpenerAsCard: 替换成功登记 lane 并返回 true(不撤回)', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    await expect(im.consumePendingOpenerAsCard('g/oc_c/omt_t', SPEC)).resolves.toBe(true);
    expect(outboundMocks.registerCardLane).toHaveBeenCalledWith('g/oc_c/omt_t', 'om_opener');
    expect(outboundMocks.recallOwnMessageWith).not.toHaveBeenCalled();
  });

  it('consumePendingOpenerCard: patch 等待中换账号则丢弃旧轮次, 不指示调用方发送', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      outboundMocks.getAccountEpoch.mockReturnValue(1);
      outboundMocks.getBoundClient.mockReturnValue({ fake: 'account-b' });
      throw new Error('patch failed after rebind');
    });

    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(true);
    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalledWith(fakeClient, 'om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(outboundMocks.deferOpenerConsume).not.toHaveBeenCalled();
  });

  it('consumePendingOpenerCard: patch 失败仍同账号但空窗时重新暂存, 不撤回', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    (streamingText.patchMarkdown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      outboundMocks.getBoundClient.mockReturnValue(null);
      throw new Error('client unbound mid-patch');
    });

    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(false);
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_opener',
        markdown: '回复',
      }),
    );
    expect(outboundMocks.recallOwnMessageWith).not.toHaveBeenCalled();
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
  });

  it('consumePendingOpenerAsCard: 替换等待中换账号则丢弃旧轮次, 不指示调用方发送', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    outboundMocks.updateInteractive.mockImplementationOnce(async () => {
      outboundMocks.getAccountEpoch.mockReturnValue(1);
      outboundMocks.getBoundClient.mockReturnValue({ fake: 'account-b' });
      throw new Error('replace failed after rebind');
    });

    await expect(im.consumePendingOpenerAsCard('g/oc_c/omt_t', SPEC)).resolves.toBe(true);
    expect(outboundMocks.recallOwnMessageWith).toHaveBeenCalledWith(fakeClient, 'om_opener');
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(outboundMocks.deferOpenerConsume).not.toHaveBeenCalled();
    expect(outboundMocks.registerCardLane).not.toHaveBeenCalled();
  });

  it('consumePendingOpenerAsCard: 替换失败仍同账号但空窗时重新暂存, 不撤回', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue('om_opener');
    outboundMocks.updateInteractive.mockImplementationOnce(async () => {
      outboundMocks.getBoundClient.mockReturnValue(null);
      throw new Error('client unbound mid-replace');
    });

    await expect(im.consumePendingOpenerAsCard('g/oc_c/omt_t', SPEC)).resolves.toBe(false);
    expect(outboundMocks.deferOpenerConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'g/oc_c/omt_t',
        openerId: 'om_opener',
        spec: SPEC,
      }),
    );
    expect(outboundMocks.recallOwnMessageWith).not.toHaveBeenCalled();
    expect(outboundMocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
  });
});
