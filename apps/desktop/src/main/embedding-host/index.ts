/**
 * embedding-host (Phase 1.1): 主进程内 embedding 能力层的启停 + 单例入口。
 *
 * 启动时机: localDb ensureReady (含 sqlite-vec 探测) 之后, 在 onReady 钩子里调
 *   startEmbeddingHost({...})。
 *
 * 退出时机: lifecycle 'async' 阶段调 stopEmbeddingHost() (Worker 等当前 tick 跑完)。
 *
 * 设计:
 *   - 单例; 重复 start 是 no-op
 *   - 不依赖 user login state (依赖的是 localDb 已 ready + EmbeddingClient 能拿 api key)
 *   - sqlite-vec 未加载也启动, Worker 自己识别并 idle (warn 一次), 不抛错阻断启动
 *   - 切账号: localDb closeDb 时务必先 stopEmbeddingHost (避免 Worker tick 撞 'not ready')
 *
 * **多 consumer 的启停归属** (PR #1707 review): host 的生命周期不属于任何单个
 * consumer。chat consumer 由「聊天嵌入」设置控制, 插件向量 consumer (embed.text)
 * 是按需的 —— 谁都可能是唯一在用的那个, 所以:
 *   - 没有任何 consumer 要用 → 根本不启动 (零 Worker setInterval, 用户感受不到轮询)
 *   - 插件首次请求向量 → ensureEmbeddingServiceForPluginVector() 打标 + 懒启动
 *   - 关掉「聊天嵌入」→ 只有在没有插件 consumer 时才 stopEmbeddingHost
 * 启动动作本身要 bootstrap 的依赖 (DbClient / api key / gateway url), 所以这里只存
 * 一个由 bootstrap 注册的 starter 回调, 不把 bootstrap 反向 import 进来。
 */

import { EmbeddingClient, type EmbeddingClientOptions } from '@cindy/embedding-client';

import type { createLogger } from '../logger';
import type { DbClient } from '../localDb/client/DbClient';
import { EmbeddingService } from './EmbeddingService';

export type { EmbeddingProvider, EmbeddingJobForProvider } from './providers';
export type { EmbeddingService } from './EmbeddingService';
export type { VecTableSpec } from './VecTableRegistry';

export interface StartEmbeddingHostDeps {
  getDbClient: () => DbClient;
  isVecAvailable: () => boolean;
  getApiKey: () => string | null | undefined;
  /**
   * XD Gateway base URL(生产接线注入 effectiveXdGatewayBaseUrl,见 bootstrap-electron);
   * 函数形态 = 每次请求现取(model-access 下发的 endpoint 运行期可变)。
   */
  gatewayBaseUrl: string | (() => string);
  log: ReturnType<typeof createLogger>;
  /** 可选: 注入 fetch (测试用) */
  fetchImpl?: typeof fetch;
}

let _service: EmbeddingService | null = null;
let _client: EmbeddingClient | null = null;
/** bootstrap 注册的懒启动器 (= attemptStartEmbeddingHost); 未注册时懒启动是 no-op */
let _lazyStart: (() => void) | null = null;
/** 本次 host 生命周期内是否有插件向量 consumer 请求过 (决定 chat 关闭时能不能停 host) */
let _pluginVectorConsumer = false;

export function startEmbeddingHost(deps: StartEmbeddingHostDeps): EmbeddingService {
  if (_service) {
    deps.log.warn(JSON.stringify({ event: 'embeddingHost.started.duplicate' }));
    return _service;
  }
  const clientOpts: EmbeddingClientOptions = {
    baseUrl: deps.gatewayBaseUrl,
    getApiKey: deps.getApiKey,
    fetchImpl: deps.fetchImpl,
    logger: {
      info: (m) => deps.log.info(m),
      warn: (m) => deps.log.warn(m),
      error: (m) => deps.log.error(m),
    },
  };
  _client = new EmbeddingClient(clientOpts);

  _service = new EmbeddingService({
    getDbClient: deps.getDbClient,
    getClient: () => _client!,
    isVecAvailable: deps.isVecAvailable,
    log: deps.log,
  });
  _service.start();
  deps.log.info(
    JSON.stringify({
      event: 'embeddingHost.started',
      sqliteVecAvailable: deps.isVecAvailable(),
      gatewayBaseUrl: clientOpts.baseUrl,
    }),
  );
  return _service;
}

export async function stopEmbeddingHost(): Promise<void> {
  // 标记清在最前面, **不受 `!_service` 早退影响** (review 第十二轮): 不变量是
  // "没有活着的 host ⇒ 没有已提交的 consumer"。清了也不会丢能力: 插件下一次请求
  // 会重新打标并懒启动 (这就是"按需"的含义)。
  _pluginVectorConsumer = false;
  if (!_service) return;
  await _service.stop();
  _service = null;
  _client = null;
}

export function getEmbeddingService(): EmbeddingService {
  if (!_service) {
    throw new Error('embedding-host not started: call startEmbeddingHost() first');
  }
  return _service;
}

/**
 * bootstrap 启动期注册懒启动器 (幂等, last-write-wins)。
 * 注册的函数必须自己完成"能不能启 / 依赖齐不齐"的判断, 这里只负责在需要时调它。
 */
export function registerEmbeddingHostLazyStart(start: () => void): void {
  _lazyStart = start;
}

/**
 * 插件向量 consumer (`embed.text`) 的入口: 打标 + 按需懒启动 + 取 service。
 *
 * 为什么不直接用 getEmbeddingService(): 用户关掉「聊天嵌入」时 host 会被停掉且下次
 * 启动也不建 —— 而插件向量目录仍按网关可用性展示模型。那时直接取 service 必抛
 * 'embedding-host not started', 已获授权的 embed_text 全变 INTERNAL (PR #1707 review)。
 *
 * 打标发生在启动之前: starter 回调会回读 isPluginVectorConsumerActive() 来决定
 * "chat 关着也要启"。启动失败 (DbClient 未 ready 等) 时照旧抛 not-started, 由
 * 上层折叠成插件可见的错误码。
 *
 * **起不来就回滚标记** (review 第十二轮): 标记的语义是"有一个正在被服务的 consumer",
 * 不是"有人试过"。留着一个从未被服务过的标记会让它变成幽灵 consumer —— 切账号后新账号
 * 的 onReady 会把它当成当前有人在用, 在聊天嵌入关着的情况下白起一个 host, Worker 每
 * 5 秒空转。回滚也不损失什么: 重试路径本身就会重新打标。
 */
export function ensureEmbeddingServiceForPluginVector(): EmbeddingService {
  if (_service) {
    _pluginVectorConsumer = true;
    return _service;
  }
  _pluginVectorConsumer = true;
  try {
    _lazyStart?.();
  } finally {
    // starter 早退 / 抛错 / 根本没注册 → 一律回到"没有 consumer"的状态。
    if (!_service) _pluginVectorConsumer = false;
  }
  return getEmbeddingService();
}

/** 本次 host 生命周期内是否有插件向量 consumer —— chat 开关的停机判据 */
export function isPluginVectorConsumerActive(): boolean {
  return _pluginVectorConsumer;
}

/** dev / debug: 是否已启动 */
export function isEmbeddingHostStarted(): boolean {
  return _service !== null;
}
