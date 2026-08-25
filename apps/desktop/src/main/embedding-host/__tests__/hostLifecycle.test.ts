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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const readMainSource = (...parts: string[]) =>
  readFileSync(resolve(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n?/g, '\n');
const bootstrapSource = readMainSource('bootstrap-electron.ts');
const makerHostSource = readMainSource('maker-host', 'index.ts');

const hoisted = vi.hoisted(() => ({
  instances: 0,
  stops: 0,
  stopGate: null as Promise<void> | null,
}));

vi.mock('../EmbeddingService', () => ({
  EmbeddingService: class {
    readonly seq: number;
    constructor(readonly _deps: unknown) {
      this.seq = ++hoisted.instances;
    }
    start(): void {}
    async stop(): Promise<void> {
      hoisted.stops += 1;
      await hoisted.stopGate;
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
    hoisted.stopGate = null;
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

    const stopped = await host.stopEmbeddingHostIfNoPluginVectorConsumer();

    expect(stopped).toBe(false);
    expect(host.isEmbeddingHostStarted()).toBe(true);
    expect(hoisted.stops).toBe(0);
  });

  it('条件停机摘除旧 service 后,并发插件请求启动并保留新实例', async () => {
    const host = await loadHost();
    const starter = bootstrapStarter(host, () => false);
    host.registerEmbeddingHostLazyStart(starter);
    host.startEmbeddingHost(fakeDeps());
    const oldService = host.getEmbeddingService();
    let releaseStop!: () => void;
    hoisted.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    const stopping = host.stopEmbeddingHostIfNoPluginVectorConsumer();
    expect(host.isEmbeddingHostStarted()).toBe(false);
    const newService = host.ensureEmbeddingServiceForPluginVector();
    expect(newService).not.toBe(oldService);
    expect(host.isPluginVectorConsumerActive()).toBe(true);

    releaseStop();
    await expect(stopping).resolves.toBe(true);
    expect(host.getEmbeddingService()).toBe(newService);
    expect(host.isPluginVectorConsumerActive()).toBe(true);
  });

  it('暂停的 chat source 在 SQL 层排除,不阻塞插件队列', async () => {
    const host = await loadHost();
    host.setEmbeddingSourceSuspended('chat', true);
    const { EmbeddingWorker } = await import('../EmbeddingWorker');
    const query = vi.fn().mockResolvedValue([]);
    const worker = new EmbeddingWorker({
      getDbClient: () => ({ query }) as never,
      getClient: () => ({ embed: vi.fn() }) as never,
      isVecAvailable: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    await (worker as unknown as { tick(): Promise<void> }).tick();

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('source NOT IN (?)');
    expect(params.slice(1)).toEqual(['chat', 32]);
  });

  it('query 或 markDone 后丢失 availability 时不处理已选中的 chat job', async () => {
    const host = await loadHost();
    const { EmbeddingWorker } = await import('../EmbeddingWorker');
    const { registerProvider } = await import('../providers');
    const getTextsForJobs = vi.fn().mockResolvedValue([{ rowid: 1, text: 'queued chat' }]);
    registerProvider({ source: 'chat', getTextsForJobs });
    const embed = vi.fn();
    const chatJob = {
      rowid: 1,
      source: 'chat',
      source_id: 'm1',
      chunk_index: 0,
      model_id: 'voyage/voyage-4',
      vec_table: 'chat_messages_vec_v1',
      attempts: 0,
    };
    const query = vi.fn().mockResolvedValue([chatJob]);
    const tx = vi.fn(async () => host.setEmbeddingSourceSuspended('chat', true));
    const worker = new EmbeddingWorker({
      getDbClient: () => ({ query, tx }) as never,
      getClient: () => ({ embed }) as never,
      isVecAvailable: () => true,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    const runTick = () => (worker as unknown as { tick(): Promise<void> }).tick();
    const tick = runTick();
    host.setEmbeddingSourceSuspended('chat', true);
    await tick;
    expect(getTextsForJobs).not.toHaveBeenCalled();

    host.setEmbeddingSourceSuspended('chat', false);
    getTextsForJobs.mockResolvedValue([
      { rowid: 1, text: null },
      { rowid: 2, text: 'queued chat' },
    ]);
    query.mockResolvedValue([chatJob, { ...chatJob, rowid: 2, source_id: 'm2' }]);
    await runTick();

    expect(tx).toHaveBeenCalledWith('embedding.markDone', { rowids: [1] });
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('chat embedding availability wiring', () => {
  it('reconciles the runtime whenever provider access or another process changes settings', () => {
    expect(makerHostSource).toContain('providerAccessRuntimeRefreshListener?.();');
    expect(bootstrapSource).toContain(
      'setProviderAccessRuntimeRefreshListener(scheduleChatEmbeddingRuntimeReconcile);',
    );
    expect(bootstrapSource).toContain('createChatEmbeddingSettingsWatcher(() => {');
    expect(bootstrapSource).toContain('rebindChatEmbeddingSettingsWatcher();');
    expect(bootstrapSource).toContain('MAKER_PUSH.CHAT_EMBEDDING_CHANGED');
  });
  it('keeps provider broadcasts alive when runtime reconciliation throws', () => {
    const refreshStart = makerHostSource.indexOf(
      'function refreshSelectableModelsAndBroadcast(payload: Record<string, unknown>): void {',
    );
    const refreshEnd = makerHostSource.indexOf(
      '\n}\n\n/**\n * active catalog',
      refreshStart,
    );
    expect(refreshStart).toBeGreaterThanOrEqual(0);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    const refreshSource = makerHostSource.slice(refreshStart, refreshEnd);
    expect(refreshSource).toMatch(/try\s*{\s*providerAccessRuntimeRefreshListener\?\.\(\);/);
    expect(refreshSource).toContain(
      "desktopMakerLogger.warn('provider access runtime refresh listener failed'",
    );
    expect(refreshSource.indexOf('providerAccessRuntimeRefreshListener?.();')).toBeLessThan(
      refreshSource.indexOf('BrowserWindow.getAllWindows()'),
    );
  });
  it('stops unavailable consumers and restores an enabled preference when access returns', () => {
    expect(bootstrapSource).toContain(
      "setEmbeddingSourceSuspended('chat', !chatAvailable);",
    );
    expect(bootstrapSource).toContain(
      'if (!chatEnabled) setChatEmbeddingEnabled(false);',
    );
    expect(bootstrapSource).toContain(
      'readChatEmbeddingSettings(chatEmbeddingDefaultContext()).enabled',
    );
    expect(bootstrapSource).toContain('await shutdownChatEmbeddingConsumer();');
  });

  it('routes unavailable enable requests through the stable capability error', () => {
    const start = bootstrapSource.indexOf('MAKER_IPC_INVOKE.CHAT_EMBEDDING_SET');
    const end = bootstrapSource.indexOf('MAKER_IPC_INVOKE.CHAT_EMBEDDING_RESET', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = bootstrapSource.slice(start, end);
    expect(handler).toMatch(/throwIpcError\(\s*'UNSUPPORTED_CAPABILITY'/);
    expect(handler).not.toContain("requireAppCapability('canUseCindyGateway'");
  });

  it('rejects stale renderer owner stamps before mutating an account setting', () => {
    const setStart = bootstrapSource.indexOf('MAKER_IPC_INVOKE.CHAT_EMBEDDING_SET');
    const resetStart = bootstrapSource.indexOf('MAKER_IPC_INVOKE.CHAT_EMBEDDING_RESET', setStart);
    const resetEnd = bootstrapSource.indexOf('MAKER_IPC_INVOKE.GIT_SAFETY_GET', resetStart);
    const setHandler = bootstrapSource.slice(setStart, resetStart);
    const resetHandler = bootstrapSource.slice(resetStart, resetEnd);

    const setGuard = setHandler.indexOf('assertChatEmbeddingMutationOwner(owner);');
    const setWrite = setHandler.indexOf('await writeChatEmbeddingEnabled');
    const resetGuard = resetHandler.indexOf('assertChatEmbeddingMutationOwner(owner);');
    const resetWrite = resetHandler.indexOf('await resetChatEmbeddingSettings');
    expect(setGuard).toBeGreaterThanOrEqual(0);
    expect(setWrite).toBeGreaterThan(setGuard);
    expect(resetGuard).toBeGreaterThanOrEqual(0);
    expect(resetWrite).toBeGreaterThan(resetGuard);
    expect(bootstrapSource).toMatch(/throwIpcError\(\s*'PRECONDITION_FAILED'/);
  });

  it('converts persist failures to a stable IPC error after runtime reconcile', () => {
    expect(bootstrapSource).toContain(
      "import { rethrowChatEmbeddingPersistError } from './maker-host/chat-embedding-persist-error.js';",
    );

    const setStart = bootstrapSource.indexOf('MAKER_IPC_INVOKE.CHAT_EMBEDDING_SET');
    const resetStart = bootstrapSource.indexOf('MAKER_IPC_INVOKE.CHAT_EMBEDDING_RESET', setStart);
    const resetEnd = bootstrapSource.indexOf('MAKER_IPC_INVOKE.GIT_SAFETY_GET', resetStart);
    const setHandler = bootstrapSource.slice(setStart, resetStart);
    const resetHandler = bootstrapSource.slice(resetStart, resetEnd);

    const setReconcile = setHandler.indexOf('await scheduleChatEmbeddingRuntimeReconcile();');
    const setRethrow = setHandler.indexOf(
      "rethrowChatEmbeddingPersistError(error, 'Failed to save chat embedding settings')",
    );
    expect(setReconcile).toBeGreaterThanOrEqual(0);
    expect(setRethrow).toBeGreaterThan(setReconcile);
    expect(setHandler).not.toMatch(/throw error;?/);

    const resetReconcile = resetHandler.indexOf('await scheduleChatEmbeddingRuntimeReconcile();');
    const resetRethrow = resetHandler.indexOf(
      "rethrowChatEmbeddingPersistError(error, 'Failed to reset chat embedding settings')",
    );
    expect(resetReconcile).toBeGreaterThanOrEqual(0);
    expect(resetRethrow).toBeGreaterThan(resetReconcile);
    expect(resetHandler).not.toMatch(/throw error;?/);
  });
});
