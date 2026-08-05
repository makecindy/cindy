/**
 * hostLifecycle.test.ts — embedding-host 的多 consumer 启停契约(PR #1707 review)。
 *
 * 背景:host 原本由「聊天嵌入」设置独占启停(代码注释里预告过"未来加第二个 consumer
 * 时要重构")。插件向量(embed.text)就是第二个 consumer —— 用户关掉聊天嵌入后
 * getEmbeddingService() 必抛 not-started,已授权的 embed_text 全变 INTERNAL,而
 * Settings 里向量模型照常显示可用。
 *
 * 这里锁住的是"错了不报错、只是能力悄悄没了/后台悄悄多转一个定时器"的两端:
 *   1. 插件请求时打标必须发生在懒启动**之前** —— starter 靠回读这个标记才敢在
 *      chat 关着的情况下启 host;顺序反了就退化回原 bug;
 *   2. 没有任何 consumer 时一定不启(零 Worker setInterval 的承诺),stop 之后标记
 *      必须清 —— 否则切账号后会为一个并没有在请求的插件 consumer 白起一个 host。
 *
 * EmbeddingService 被替身掉:真身的依赖链(utility-model → runtime-configs)会在
 * 模块顶层读 electron app 路径,与本文件要验的启停逻辑无关。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({ instances: 0, stops: 0 }));

vi.mock('../EmbeddingService', () => ({
  EmbeddingService: class {
    readonly seq: number;
    constructor(readonly _deps: unknown) {
      this.seq = ++hoisted.instances;
    }
    start(): void {}
    async stop(): Promise<void> {
      hoisted.stops += 1;
    }
  },
}));

type HostModule = typeof import('../index');

function fakeDeps(): Parameters<HostModule['startEmbeddingHost']>[0] {
  return {
    getDbClient: () => ({}) as never,
    // false → Worker 不打 tick;本文件不关心 Worker 行为
    isVecAvailable: () => false,
    getApiKey: () => 'sk-test',
    gatewayBaseUrl: () => 'https://gateway.invalid',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
}

/**
 * 复刻 bootstrap-electron 的 attemptStartEmbeddingHost 判据(那个文件是 app 入口,
 * 不能在单测里 import)。判据只有两条:任一 consumer 要用才启;已起则复用。
 */
function bootstrapStarter(host: HostModule, chatEnabled: () => boolean) {
  return vi.fn(() => {
    if (!chatEnabled() && !host.isPluginVectorConsumerActive()) return;
    if (host.isEmbeddingHostStarted()) return;
    host.startEmbeddingHost(fakeDeps());
  });
}

async function loadHost(): Promise<HostModule> {
  vi.resetModules();
  return await import('../index');
}

describe('embedding-host 多 consumer 启停', () => {
  beforeEach(() => {
    hoisted.instances = 0;
    hoisted.stops = 0;
  });

  it('chat 关 + 插件从未请求 → 不启动(零 Worker 轮询的承诺)', async () => {
    const host = await loadHost();
    const starter = bootstrapStarter(host, () => false);
    host.registerEmbeddingHostLazyStart(starter);

    // 模拟 onReady 时的那次调用
    starter();

    expect(host.isEmbeddingHostStarted()).toBe(false);
    expect(host.isPluginVectorConsumerActive()).toBe(false);
    expect(hoisted.instances).toBe(0);
  });

  it('chat 关 + 插件请求 → 懒启动成功(打标先于启动,starter 能看见)', async () => {
    const host = await loadHost();
    const starter = bootstrapStarter(host, () => false);
    host.registerEmbeddingHostLazyStart(starter);

    const service = host.ensureEmbeddingServiceForPluginVector();

    expect(starter).toHaveBeenCalledTimes(1);
    expect(host.isEmbeddingHostStarted()).toBe(true);
    expect(host.isPluginVectorConsumerActive()).toBe(true);
    // 拿到的就是单例本身,不是新建的第二个
    expect(service).toBe(host.getEmbeddingService());
    expect(hoisted.instances).toBe(1);
  });

  it('host 已起 → 插件请求只打标,不再调 starter(不重复起 Worker)', async () => {
    const host = await loadHost();
    host.startEmbeddingHost(fakeDeps());
    const starter = bootstrapStarter(host, () => true);
    host.registerEmbeddingHostLazyStart(starter);

    host.ensureEmbeddingServiceForPluginVector();

    expect(starter).not.toHaveBeenCalled();
    expect(host.isPluginVectorConsumerActive()).toBe(true);
    expect(hoisted.instances).toBe(1);
  });

  it('starter 起不动(依赖未 ready)→ 抛 not-started,并把标记回滚', async () => {
    const host = await loadHost();
    // 模拟 DbClient 未 ready 的早退分支:starter 被调了但什么都没起
    host.registerEmbeddingHostLazyStart(() => {});

    expect(() => host.ensureEmbeddingServiceForPluginVector()).toThrow(/not started/);
    expect(host.isEmbeddingHostStarted()).toBe(false);
    // 标记的语义是"有一个正在被服务的 consumer",不是"有人试过"。留着它就成了幽灵
    // consumer:切账号后新账号的 onReady 会把它当成当前有人在用(review 第十二轮)。
    expect(host.isPluginVectorConsumerActive()).toBe(false);
  });

  it('starter 抛错也回滚标记(不靠 starter 自己 catch 干净)', async () => {
    const host = await loadHost();
    host.registerEmbeddingHostLazyStart(() => {
      throw new Error('boom');
    });

    expect(() => host.ensureEmbeddingServiceForPluginVector()).toThrow(/boom/);
    expect(host.isPluginVectorConsumerActive()).toBe(false);
  });

  it('启动失败后切账号 → 新账号(chat 关)不会被幽灵 consumer 拽起一个 host', async () => {
    const host = await loadHost();
    const chatEnabled = { value: false };
    const starter = bootstrapStarter(host, () => chatEnabled.value);
    // 旧账号:DbClient 未 ready,插件请求失败
    host.registerEmbeddingHostLazyStart(() => {});
    expect(() => host.ensureEmbeddingServiceForPluginVector()).toThrow(/not started/);

    // 切账号边界:stopEmbeddingHost 此时没有 service,不能因此跳过清标记
    await host.stopEmbeddingHost();
    expect(host.isPluginVectorConsumerActive()).toBe(false);

    // 新账号 onReady:chat 关着,新账号的插件也没请求过 → 一个 Worker 都不该起
    host.registerEmbeddingHostLazyStart(starter);
    starter();
    expect(host.isEmbeddingHostStarted()).toBe(false);
    expect(hoisted.instances).toBe(0);
  });

  it('没注册 starter → 懒启动是 no-op,不炸在 undefined 上', async () => {
    const host = await loadHost();

    expect(() => host.ensureEmbeddingServiceForPluginVector()).toThrow(/not started/);
    expect(host.isPluginVectorConsumerActive()).toBe(false);
  });

  it('stopEmbeddingHost 清插件标记 → 切账号后不会为没在请求的 consumer 白起 host', async () => {
    const host = await loadHost();
    const chatEnabled = { value: false };
    const starter = bootstrapStarter(host, () => chatEnabled.value);
    host.registerEmbeddingHostLazyStart(starter);
    host.ensureEmbeddingServiceForPluginVector();
    expect(host.isEmbeddingHostStarted()).toBe(true);

    // 切账号边界:stopEmbeddingHost + (bootstrap 侧)resetChatEmbedderCache
    await host.stopEmbeddingHost();
    expect(hoisted.stops).toBe(1);
    expect(host.isPluginVectorConsumerActive()).toBe(false);

    // 新账号 onReady:chat 仍关着,且新账号的插件还没请求过 → 不启
    starter();
    expect(host.isEmbeddingHostStarted()).toBe(false);

    // 插件再次请求 → 重新打标 + 重新起(按需的自愈路径)
    host.ensureEmbeddingServiceForPluginVector();
    expect(host.isEmbeddingHostStarted()).toBe(true);
    expect(hoisted.instances).toBe(2);
  });

  it('chat 关但插件在用 → 停机判据为假,host 必须留着', async () => {
    const host = await loadHost();
    const starter = bootstrapStarter(host, () => true);
    host.registerEmbeddingHostLazyStart(starter);
    starter(); // chat ON 时启动
    host.ensureEmbeddingServiceForPluginVector(); // 插件也开始用

    // 复刻 bootstrap 的 shutdownChatEmbeddingConsumer 判据
    const shouldStop = host.isEmbeddingHostStarted() && !host.isPluginVectorConsumerActive();

    expect(shouldStop).toBe(false);
    expect(host.isEmbeddingHostStarted()).toBe(true);
    expect(hoisted.stops).toBe(0);
  });
});
