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

/** dev / debug: 是否已启动 */
export function isEmbeddingHostStarted(): boolean {
  return _service !== null;
}
