/**
 * FeishuIM 开场白卡消费(consumePendingOpenerCard / consumePendingOpenerAsCard)
 * 的失败语义: patch/替换失败时认领已完成 — 撤回开场白卡(不让「思考中」卡
 * 永久残留)并返回 false 让编排层回落正常发送。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '../../types.js';

const fakeClient = { fake: 'client' };

const outboundMocks = vi.hoisted(() => ({
  claimPatchableOpener: vi.fn<() => string | null>(() => null),
  getBoundClient: vi.fn<() => { fake: string } | null>(() => ({ fake: 'client' })),
  recallOwnMessageWith: vi.fn(async () => true),
  updateInteractive: vi.fn(async () => undefined),
  registerCardLane: vi.fn(),
  rearmAnchorToTrigger: vi.fn(() => true),
}));

vi.mock('../outbound.js', () => ({
  claimPatchableOpener: outboundMocks.claimPatchableOpener,
  getBoundClient: outboundMocks.getBoundClient,
  recallOwnMessageWith: outboundMocks.recallOwnMessageWith,
  updateInteractive: outboundMocks.updateInteractive,
  registerCardLane: outboundMocks.registerCardLane,
  rearmAnchorToTrigger: outboundMocks.rearmAnchorToTrigger,
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
import * as streamingText from '../streamingText.js';

const im = new FeishuIM({} as unknown as IMHost);

const SPEC = { body: 'picker', buttons: [] };

describe('FeishuIM opener consumption failure semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认有绑定 client — 个别用例覆盖为 null, 不能泄漏到后续用例。
    outboundMocks.getBoundClient.mockReturnValue({ fake: 'client' });
  });

  it('consumePendingOpenerCard: 无 pending opener 返回 false(不撤回)', async () => {
    outboundMocks.claimPatchableOpener.mockReturnValue(null);
    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(false);
    expect(outboundMocks.recallOwnMessageWith).not.toHaveBeenCalled();
  });

  it('重连空窗(无绑定 client)不认领 opener, 保留注册给重连后消费', async () => {
    outboundMocks.getBoundClient.mockReturnValue(null);
    await expect(im.consumePendingOpenerCard('g/oc_c/omt_t', '回复')).resolves.toBe(false);
    await expect(im.consumePendingOpenerAsCard('g/oc_c/omt_t', SPEC)).resolves.toBe(false);
    expect(outboundMocks.claimPatchableOpener).not.toHaveBeenCalled();
    expect(outboundMocks.recallOwnMessageWith).not.toHaveBeenCalled();
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
});
