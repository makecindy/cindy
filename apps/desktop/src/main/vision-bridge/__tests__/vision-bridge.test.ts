/**
 * vision-bridge（层 B 钩子）单元测试。
 *
 * 覆盖：未启用/不命中 → applied=false 原样透传（零干扰契约）；命中 → image block 替换为
 * 描述 text block + focus hint 取自同消息文本；主后端失败 → fallback；都挂 → applied=false
 * + note；无图 → applied=false。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserMessage } from '@cindy/maker-core';

import { createVisionBridge } from '../vision-bridge.js';
import type { VisionBridgeSettings } from '../vision-bridge-settings-store.js';

vi.mock('../vision-bridge-settings-store.js', () => ({
  readVisionBridgeSettings: vi.fn(),
  isTargetModelsCustomized: vi.fn(),
}));
vi.mock('../vision-channel.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../vision-channel.js')>();
  return { ...orig, describeImageWithProvider: vi.fn() };
});

import {
  isTargetModelsCustomized,
  readVisionBridgeSettings,
} from '../vision-bridge-settings-store.js';
import { describeImageWithProvider, VisionBackendError } from '../vision-channel.js';

const mockedSettings = vi.mocked(readVisionBridgeSettings);
const mockedTargetsCustomized = vi.mocked(isTargetModelsCustomized);
const mockedDescribe = vi.mocked(describeImageWithProvider);

function baseSettings(): VisionBridgeSettings {
  return {
    enabled: true,
    targetModels: ['deepseek-v4'],
    primary: { providerId: 'user-deepseek', modelId: 'deepseek-v4' },
    fallback: null,
  };
}

function userMsg(text: string, imagePath?: string) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; path: string; pathOrigin?: 'desktop-host' }> = [
    { type: 'text', text },
  ];
  if (imagePath) content.push({ type: 'image', path: imagePath, pathOrigin: 'desktop-host' });
  return { type: 'user' as const, content };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedSettings.mockReturnValue(baseSettings());
  // 默认视为「未显式自定义 targetModels」：no-vision 模型默认走视觉桥。
  mockedTargetsCustomized.mockReturnValue(false);
});

describe('createVisionBridge hook', () => {
  it('passes through when disabled', async () => {
    mockedSettings.mockReturnValue({ ...baseSettings(), enabled: false });
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('hi', '/tmp/a.png');
    const r = await hook(msg, { model: 'deepseek-v4' });
    expect(r.applied).toBe(false);
    expect(r.message).toBe(msg);
  });

  it('passes through when model is not a target', async () => {
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('hi', '/tmp/a.png');
    const r = await hook(msg, { model: 'claude-sonnet-4-8' });
    expect(r.applied).toBe(false);
  });

  it('applies to a no-vision model not in targetModels when targets not customized (default merge)', async () => {
    // targetModels 不含 deepseek，但未显式自定义 → no-vision 默认走视觉桥。
    mockedSettings.mockReturnValue({ ...baseSettings(), targetModels: [] });
    mockedDescribe.mockResolvedValue('default merged description');
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('hi', '/tmp/a.png');
    const r = await hook(msg, { model: 'deepseek-v4' });
    expect(r.applied).toBe(true);
  });

  it('does not apply to no-vision model when targets were explicitly customized (user opted out)', async () => {
    // 用户显式自定义过 targetModels（不含 deepseek）→ 不再默认合并。
    mockedSettings.mockReturnValue({ ...baseSettings(), targetModels: ['other-model'] });
    mockedTargetsCustomized.mockReturnValue(true);
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('hi', '/tmp/a.png');
    const r = await hook(msg, { model: 'deepseek-v4' });
    expect(r.applied).toBe(false);
  });

  it('matches explicitly checked model with normalized runtime variant ([1m] suffix)', async () => {
    // targetModels 存 catalog id；运行时 handle.model 带 [1m] 变体 → 归一化后应命中。
    mockedSettings.mockReturnValue({ ...baseSettings(), targetModels: ['deepseek/deepseek-v4-flash'] });
    mockedTargetsCustomized.mockReturnValue(true);
    mockedDescribe.mockResolvedValue('normalized match description');
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('hi', '/tmp/a.png');
    const r = await hook(msg, { model: 'deepseek/deepseek-v4-flash[1m]' });
    expect(r.applied).toBe(true);
  });

  it('passes through when no image blocks', async () => {
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('hi');
    const r = await hook(msg, { model: 'deepseek-v4' });
    expect(r.applied).toBe(false);
  });

  it('skips remote images (no pathOrigin) and passes through', async () => {
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg: UserMessage = {
      type: 'user',
      content: [
        { type: 'text', text: 'remote screenshot' },
        { type: 'image', path: '/remote/workspace/screenshot.png' },
      ],
    };
    const r = await hook(msg, { model: 'deepseek-v4' });
    expect(r.applied).toBe(false);
    expect(r.message).toBe(msg);
  });

  it('replaces image block with description using same-message text as focus hint', async () => {
    mockedDescribe.mockResolvedValue('a red button labeled Send');
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('what is this ui?', '/tmp/ui.png');
    const r = await hook(msg, { model: 'deepseek-v4' });
    expect(r.applied).toBe(true);
    const blocks = r.message.content as Array<{ type: string; text?: string; path?: string }>;
    // 两张 text block 或 text+image 被替换为 text。这里原来 1 text + 1 image → 替换后应为 2 个 text block。
    expect(blocks.every((b) => b.type === 'text')).toBe(true);
    expect(blocks.some((b) => b.text?.includes('red button'))).toBe(true);
    // focus hint = 同消息文本
    expect(mockedDescribe).toHaveBeenCalledWith(
      'user-deepseek',
      'deepseek-v4',
      expect.objectContaining({ imagePath: '/tmp/ui.png', prompt: 'what is this ui?' }),
      expect.anything(),
    );
  });

  it('uses fallback backend when primary fails and reports usedFallback via note', async () => {
    mockedDescribe
      .mockRejectedValueOnce(new VisionBackendError('http', 'primary 500'))
      .mockResolvedValueOnce('fallback description');
    const onNote = vi.fn();
    const settings = {
      ...baseSettings(),
      fallback: { providerId: 'user-qwen', modelId: 'qwen-vl' },
    };
    mockedSettings.mockReturnValue(settings);
    const { hook } = createVisionBridge({ getProviderById: () => null, onNote });
    const r = await hook(userMsg('hi', '/tmp/a.png'), { model: 'deepseek-v4' });
    expect(r.applied).toBe(true);
    expect(r.note).toBeTruthy();
    expect(onNote).toHaveBeenCalled();
    expect(mockedDescribe).toHaveBeenCalledTimes(2);
  });

  it('calls onStart with sessionId and imageCount when target hit with images', async () => {
    mockedDescribe.mockResolvedValue('desc');
    const onStart = vi.fn();
    const { hook } = createVisionBridge({ getProviderById: () => null, onStart });
    await hook(userMsg('hi', '/tmp/a.png'), { model: 'deepseek-v4', sessionId: 'sess-1' });
    expect(onStart).toHaveBeenCalledWith('sess-1', 1);
  });

  it('does not call onStart when no images', async () => {
    mockedDescribe.mockResolvedValue('desc');
    const onStart = vi.fn();
    const { hook } = createVisionBridge({ getProviderById: () => null, onStart });
    await hook(userMsg('hi'), { model: 'deepseek-v4', sessionId: 'sess-1' });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('does not call onStart when target not matched', async () => {
    mockedDescribe.mockResolvedValue('desc');
    const onStart = vi.fn();
    const { hook } = createVisionBridge({ getProviderById: () => null, onStart });
    await hook(userMsg('hi', '/tmp/a.png'), { model: 'claude-sonnet', sessionId: 'sess-1' });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('replaces all images with unavailable placeholder when both backends fail', async () => {
    mockedDescribe.mockRejectedValue(new VisionBackendError('http', 'both down'));
    const onNote = vi.fn();
    const settings = {
      ...baseSettings(),
      fallback: { providerId: 'user-qwen', modelId: 'qwen-vl' },
    };
    mockedSettings.mockReturnValue(settings);
    const { hook } = createVisionBridge({ getProviderById: () => null, onNote });
    const msg = userMsg('hi', '/tmp/a.png');
    const r = await hook(msg, { model: 'deepseek-v4' });
    // 全失败时不再是「原样透传图」——原始 image block 会让层 A（proxy transform）对同一
    // 模型再次调用同一个失败的视觉后端，加倍延迟且与文档不符（P1）。改为替换为占位文本，
    // 层 A 无 image block 可处理，行为确定。
    expect(r.applied).toBe(true);
    expect(r.message).not.toBe(msg);
    const content = (r.message.content as Array<{ type: string; text?: string }>)[1];
    expect(content).toMatchObject({ type: 'text' });
    expect(content.text).toContain('Image unavailable');
    expect(r.note).toBeTruthy();
    expect(onNote).toHaveBeenCalled();
  });

  it('mixes success and failure with out-of-order completion (concurrency ordering)', async () => {
    // 3 张图：制造「首图慢、次图快、第三失败」的延迟差异，验证并发乱序完成后
    // 仍按原 idx 顺序回填。img1 用 deferred（慢），img2 立即成功，img3 失败。
    let resolveImg1!: (v: string) => void;
    mockedDescribe.mockImplementation((_p, _m, input: { imagePath?: string }) => {
      if (input.imagePath?.includes('img3')) {
        return Promise.reject(new VisionBackendError('http', 'backend 500'));
      }
      if (input.imagePath?.includes('img1')) {
        return new Promise<string>((resolve) => {
          resolveImg1 = resolve;
        });
      }
      return Promise.resolve(`desc of ${input.imagePath}`);
    });
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg: UserMessage = {
      type: 'user',
      content: [
        { type: 'text', text: 'look at these' },
        { type: 'image', path: '/tmp/img1.png', pathOrigin: 'desktop-host' },
        { type: 'image', path: '/tmp/img2.png', pathOrigin: 'desktop-host' },
        { type: 'image', path: '/tmp/img3.png', pathOrigin: 'desktop-host' },
      ],
    };
    const p = hook(msg, { model: 'deepseek-v4' });
    // 等 img2（快）和 img3（失败）完成；img1 还挂着。
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    // img1 最后 resolve（乱序完成）。
    resolveImg1('desc of /tmp/img1.png');
    const r = await p;
    expect(r.applied).toBe(true);
    // 3 个 image block 都被替换，且按原图顺序回填（img1 慢完成但仍在正确位置）。
    const blocks = r.message.content as Array<{ type: string; text?: string }>;
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
    expect(texts[1]).toContain('desc of /tmp/img1.png');
    expect(texts[2]).toContain('desc of /tmp/img2.png');
    // 失败图用独立占位：不套「已转成文字描述」前缀，声明不可用 + 约束不猜测。
    expect(texts[3]).toContain('Image unavailable');
    expect(texts[3]).not.toContain('已由外部多模态模型转成文字描述');
    // 3 张图各调用一次。
    expect(mockedDescribe).toHaveBeenCalledTimes(3);
  });

  it('caches descriptions for same image + hint', async () => {
    mockedDescribe.mockResolvedValue('cached desc');
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('q', '/tmp/a.png');
    await hook(msg, { model: 'deepseek-v4' });
    await hook(msg, { model: 'deepseek-v4' });
    expect(mockedDescribe).toHaveBeenCalledTimes(1);
  });

  it('treats different backend model as a different cache key', async () => {
    mockedDescribe.mockResolvedValue('desc');
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('q', '/tmp/a.png');
    // primary model A。
    mockedSettings.mockReturnValue({
      ...baseSettings(),
      primary: { providerId: 'user-x', modelId: 'vision-a' },
    });
    await hook(msg, { model: 'deepseek-v4' });
    // 切到 primary model B → 同图同 hint，key 变 → 重新 describe。
    mockedSettings.mockReturnValue({
      ...baseSettings(),
      primary: { providerId: 'user-x', modelId: 'vision-b' },
    });
    await hook(msg, { model: 'deepseek-v4' });
    // 两次不同后端 → 两次描述。
    expect(mockedDescribe).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used entry when cache limit is reached', async () => {
    mockedDescribe.mockResolvedValue('desc');
    const { hook } = createVisionBridge({ getProviderById: () => null, cacheLimit: 2 });
    // 图 a（先）、图 b（后），填满 cache 2 条。
    await hook(userMsg('q1', '/tmp/a.png'), { model: 'deepseek-v4' });
    await hook(userMsg('q2', '/tmp/b.png'), { model: 'deepseek-v4' });
    // 再访问 a（touch，变热）→ 然后插入 c → 淘汰 order 最小（b）。
    await hook(userMsg('q1', '/tmp/a.png'), { model: 'deepseek-v4' });
    await hook(userMsg('q3', '/tmp/c.png'), { model: 'deepseek-v4' });
    // 热 key a 命中；b 被淘汰 → b 重新 describe。
    await hook(userMsg('q1', '/tmp/a.png'), { model: 'deepseek-v4' });
    await hook(userMsg('q2', '/tmp/b.png'), { model: 'deepseek-v4' });
    // 总共：a 首次、b 首次、c 首次、a 命中（不计）、a 命中（不计）、b 淘汰后重调 = 4 次 describe。
    expect(mockedDescribe).toHaveBeenCalledTimes(4);
  });

  it('deduplicates concurrent requests for the same cache key', async () => {
    let release: (() => void) | undefined;
    mockedDescribe.mockImplementation(
      () => new Promise<string>((resolve) => { release = () => resolve('shared desc'); }),
    );
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('q', '/tmp/shared.png');
    // 三个并发同 key 请求。
    const p1 = hook(msg, { model: 'deepseek-v4' });
    const p2 = hook(msg, { model: 'deepseek-v4' });
    const p3 = hook(msg, { model: 'deepseek-v4' });
    await new Promise<void>((r) => setTimeout(r, 10));
    release?.();
    const rs = await Promise.all([p1, p2, p3]);
    // 同 key 并发只触发一次 describe（in-flight 合并）。
    expect(mockedDescribe).toHaveBeenCalledTimes(1);
    expect(rs.every((r) => r.applied === true)).toBe(true);
  });

  it('in-flight waiter with cancelled signal aborts instead of waiting on initiator', async () => {
    // 第一个请求挂起（in-flight），第二个同 key 请求带已取消的 signal 并发进来。
    let release: (() => void) | undefined;
    mockedDescribe.mockImplementation(
      () => new Promise<string>((resolve) => { release = () => resolve('slow desc'); }),
    );
    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('q', '/tmp/same.png');

    const first = hook(msg, { model: 'deepseek-v4' });
    // 等 first 进入 describe 后，第二个请求复用同一 in-flight。
    await new Promise<void>((r) => setTimeout(r, 10));

    const controller = new AbortController();
    controller.abort();
    const second = hook(msg, { model: 'deepseek-v4', signal: controller.signal });
    // 已取消 signal 同步生效 → 等待方立即失败，不等到 release（发起方仍挂起）。
    const t0 = Date.now();
    const r2 = await second;
    const waited = Date.now() - t0;
    // 等待方带已取消 signal → 立即以 abort 失败返回（不干等发起方），整条请求回退
    // 无视觉桥（单图失败 → anySucceeded=false → applied:false 原样透传 + note）。
    expect(r2.applied).toBe(false);
    expect(waited).toBeLessThan(50);

    release?.();
    await first;
  });

  it('fallback in-flight waiter with cancelled signal aborts instead of waiting on initiator', async () => {
    // 主后端同步失败 → 进入 fallback；fallback 挂起（in-flight）。第二个同 key 请求带
    // 已取消 signal 并发进来，应复用 awaitSharedFlight 立即 abort，不干等发起方 fallback。
    const fallback: VisionBridgeSettings['fallback'] = {
      providerId: 'user-fb',
      modelId: 'fb-vision',
    };
    mockedSettings.mockReturnValue({ ...baseSettings(), fallback });
    mockedDescribe
      .mockRejectedValueOnce(new VisionBackendError('network', 'primary down'))
      .mockImplementationOnce(
        () => new Promise<string>(() => { /* fallback 挂起 */ }),
      );

    const { hook } = createVisionBridge({ getProviderById: () => null });
    const msg = userMsg('q', '/tmp/fb.png');

    const first = hook(msg, { model: 'deepseek-v4' });
    // 等 first 进入 fallback in-flight 后，第二个复用同一 fallback flight。
    await new Promise<void>((r) => setTimeout(r, 10));

    const controller = new AbortController();
    controller.abort();
    const second = hook(msg, { model: 'deepseek-v4', signal: controller.signal });
    const t0 = Date.now();
    const r2 = await second;
    const waited = Date.now() - t0;
    // fallback waiter 带已取消 signal → 立即 abort 返回（不干等发起方），单图失败 → applied:false。
    expect(r2.applied).toBe(false);
    expect(waited).toBeLessThan(50);
    // 发起方 fallback 永不 resolve，但 waiters 已清；无需 release（避免悬挂 promise 影响其它测试）。
  });

  it('passes through malformed non-array content without throwing', async () => {
    mockedDescribe.mockResolvedValue('desc');
    const { hook } = createVisionBridge({ getProviderById: () => null });
    for (const content of [null, 42, { type: 'user' }]) {
      const msg = { type: 'user' as const, content: content as never };
      const r = await hook(msg, { model: 'deepseek-v4' });
      // 畸形 content → 无图可处理 → applied:false 原样透传，不 throw。
      expect(r.applied).toBe(false);
      expect(r.message).toBe(msg);
    }
    expect(mockedDescribe).not.toHaveBeenCalled();
  });

  it('does not log image-failed warn or write placeholder when cancelled (abort is not failure)', async () => {
    const loggerWarn = vi.fn();
    mockedDescribe.mockImplementation(
      () => new Promise<string>((_resolve, reject) => {
        reject(new VisionBackendError('abort', 'vision request cancelled'));
      }),
    );
    const { hook } = createVisionBridge({ getProviderById: () => null, logger: { warn: loggerWarn } });
    const controller = new AbortController();
    controller.abort();
    const msg = userMsg('q', '/tmp/a.png');
    const r = await hook(msg, { model: 'deepseek-v4', signal: controller.signal });
    // 取消 → quiet 终止，不打 image failed warn、不写 unavailable 占位，整条透传。
    expect(r.applied).toBe(false);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('quietly passes through when signal aborts while describeImage is in flight', async () => {
    const loggerWarn = vi.fn();
    const onNote = vi.fn();
    // describe 挂起，并监听 signal：中途 abort → reject VisionBackendError('abort')。
    mockedDescribe.mockImplementation(
      (_p: unknown, _m: unknown, input: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () =>
            reject(new VisionBackendError('abort', 'vision request cancelled')),
          );
        }),
    );
    const { hook } = createVisionBridge({
      getProviderById: () => null,
      logger: { warn: loggerWarn },
      onNote,
    });
    const controller = new AbortController();
    const msg = userMsg('q', '/tmp/inflight.png');
    const p = hook(msg, { model: 'deepseek-v4', signal: controller.signal });
    // 等 describe 启动后，中途 abort。
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const r = await p;
    // 运行中 abort → quiet 透传：不 warn、不 note、applied:false 原消息。
    expect(r.applied).toBe(false);
    expect(r.message).toBe(msg);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(onNote).not.toHaveBeenCalled();
  });

  it('quietly passes through when fallback aborts while in flight', async () => {
    const loggerWarn = vi.fn();
    const onNote = vi.fn();
    const fallback: VisionBridgeSettings['fallback'] = {
      providerId: 'user-fb',
      modelId: 'fb-vision',
    };
    mockedSettings.mockReturnValue({ ...baseSettings(), fallback });
    // primary 非 abort 失败（http 500）→ 进入 fallback；fallback 挂起，中途 abort。
    mockedDescribe
      .mockRejectedValueOnce(new VisionBackendError('http', 'primary 500'))
      .mockImplementationOnce(
        (_p: unknown, _m: unknown, input: { signal?: AbortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            input.signal?.addEventListener('abort', () =>
              reject(new VisionBackendError('abort', 'vision request cancelled')),
            );
          }),
      );
    const { hook } = createVisionBridge({
      getProviderById: () => null,
      logger: { warn: loggerWarn },
      onNote,
    });
    const controller = new AbortController();
    const msg = userMsg('q', '/tmp/fb-abort.png');
    const p = hook(msg, { model: 'deepseek-v4', signal: controller.signal });
    // 等进入 fallback 后，中途 abort。
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const r = await p;
    // primary 是真实 http 失败 → primary warn 预期；但 fallback abort 不应有 fallback warn、
    // 不应包装成「vision backends unavailable」、不 note、applied:false 原消息。
    expect(r.applied).toBe(false);
    expect(r.message).toBe(msg);
    expect(loggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('fallback backend failed'),
      expect.anything(),
    );
    // 最严格：所有 warn 参数里都不含「vision backends unavailable」包装（abort 不合成双后端故障）。
    for (const call of loggerWarn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('vision backends unavailable');
    }
    expect(onNote).not.toHaveBeenCalled();
  });

  it('records resolved route fields (resolvedModel/wireProtocol/requestPath) on primary failure warn', async () => {
    const loggerWarn = vi.fn();
    // 提供可解析 provider（带 openai-chat routing），routeInfoOf 能算出 resolvedModel 等。
    const provider = {
      id: 'user-qwen',
      name: 'Qwen',
      source: 'user',
      agents: ['claude-code', 'codex', 'pi'],
      auth: { method: 'apiKey' },
      routing: {
        'claude-code': {
          wireProtocol: 'openai-chat',
          upstream: 'https://qwen.example/v1',
          authStrategy: 'api-key-header',
        },
      },
      models: { 'claude-code': [{ id: 'qwen-vl', name: 'Qwen VL' }] },
    } as never;
    // primary 用 qwen（匹配 mock provider 的 id），routeInfoOf 才能解析出 qwen-vl。
    mockedSettings.mockReturnValue({
      ...baseSettings(),
      primary: { providerId: 'user-qwen', modelId: 'qwen-vl' },
    });
    mockedDescribe.mockRejectedValue(new VisionBackendError('http', 'primary 500'));
    const { hook } = createVisionBridge({
      getProviderById: () => provider,
      readCustomProviderKey: () => 'sk-test',
      logger: { warn: loggerWarn },
    });
    await hook(userMsg('hi', '/tmp/a.png'), { model: 'deepseek-v4' });
    // primary 失败 warn 应含 routeInfoOf 解析出的三字段（排障定位模型/协议/路径）。
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('primary backend failed'),
      expect.objectContaining({
        resolvedModel: 'qwen-vl',
        wireProtocol: 'openai-chat',
        requestPath: '/chat/completions',
      }),
    );
  });
});

describe('createVisionBridge describeImage', () => {
  it('透传 imagePath 到视觉通道(ghost 工具结果描述路径)', async () => {
    mockedDescribe.mockResolvedValue('a chat list screenshot');
    const { describeImage } = createVisionBridge({ getProviderById: () => null });
    const text = await describeImage({
      imagePath: '/tmp/blob.jpg',
      prompt: 'Describe this image',
    });
    expect(text).toBe('a chat list screenshot');
    expect(mockedDescribe).toHaveBeenCalledWith(
      'user-deepseek',
      'deepseek-v4',
      expect.objectContaining({
        imagePath: '/tmp/blob.jpg',
        imageUrl: undefined,
        prompt: 'Describe this image',
      }),
      expect.anything(),
    );
  });

  it('向后兼容:仅 imageUrl 时透传 imageUrl(层 A proxy transform 路径)', async () => {
    mockedDescribe.mockResolvedValue('a url image');
    const { describeImage } = createVisionBridge({ getProviderById: () => null });
    const text = await describeImage({
      imageUrl: 'data:image/png;base64,abc',
      prompt: 'Describe this',
    });
    expect(text).toBe('a url image');
    expect(mockedDescribe).toHaveBeenCalledWith(
      'user-deepseek',
      'deepseek-v4',
      expect.objectContaining({
        imagePath: undefined,
        imageUrl: 'data:image/png;base64,abc',
      }),
      expect.anything(),
    );
  });

  it('imagePath 与 imageUrl 同时提供时都透传', async () => {
    mockedDescribe.mockResolvedValue('both');
    const { describeImage } = createVisionBridge({ getProviderById: () => null });
    await describeImage({
      imagePath: '/tmp/blob.jpg',
      imageUrl: 'data:image/png;base64,abc',
      prompt: 'p',
    });
    expect(mockedDescribe).toHaveBeenCalledWith(
      'user-deepseek',
      'deepseek-v4',
      expect.objectContaining({
        imagePath: '/tmp/blob.jpg',
        imageUrl: 'data:image/png;base64,abc',
      }),
      expect.anything(),
    );
  });
});
