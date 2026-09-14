import type { AuthRegion } from '@cindy/auth-client';

import type { ModelAccessStatus } from '../../shared/modelAccess.js';
import { hasAuthSessionIdentityChanged } from './authSessionIdentity.js';
import type { ModelAccessCredentialsStore } from './credentialsStore.js';

/**
 * credentialsSync.ts — 网关凭据自动下发的同步状态机(纯逻辑,依赖注入)。
 * ---------------------------------------------------------------------------
 * 职责:登录后向 model-access-server 拉取 {endpoint, apiKey},成功则落
 * safeStorage + endpoint 元数据;失败按错误语义进入 failed / disabled /
 * unsupported 态。所有 IO(HTTP / safeStorage / codex 重启副作用 / 广播)
 * 经 deps 注入,可用内存 harness 单测(规则 14)。
 *
 * 状态语义(shared/modelAccess.ts):
 *  - disabled(503):灰度未启用,不覆盖本地任何东西,UI 走手填兜底;
 *  - unsupported(403 ORG_NOT_SUPPORTED):企业未接入,终态不重试,UI 无手填入口;
 *  - failed:有限重试(指数退避)后停在 failed,**绝不因同步失败清本地 key**
 *    ——既有 key(无论手填还是旧下发)继续工作,新会话无感。
 *
 * 并发:single-flight——同步进行中再触发(登录三入口并发 / 手动重试)复用在途
 * Promise。写 key 仅在值变化时发生,避免每次登录都触发 codex env-key 重启抖动。
 */

/** 服务端错误的最小切片(serverApiClient.ServerApiError 的结构子集)。 */
export interface CredentialsFetchError {
  code: string;
  statusCode: number;
}

function asFetchError(err: unknown): CredentialsFetchError {
  if (
    err &&
    typeof err === 'object' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number'
  ) {
    return err as CredentialsFetchError;
  }
  return { code: 'UNKNOWN', statusCode: 0 };
}

export interface CredentialsPayload {
  endpoint: string;
  apiKey: string;
}

/**
 * 下发凭据的落盘前校验:serverApiFetch 不做运行时字段验证,服务端/中间层异常
 * 地以 2xx 返回空 key / 非法 endpoint 时,绝不能覆盖本机可用凭据(PR review
 * P1)。不合法按可重试失败处理,保留既有凭据。
 */
export function isValidCredentialsPayload(p: unknown): p is CredentialsPayload {
  if (typeof p !== 'object' || p === null) return false;
  const { apiKey, endpoint } = p as { apiKey?: unknown; endpoint?: unknown };
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return false;
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CredentialsSyncDeps {
  /** GET /api/model-access/credentials(失败抛 ServerApiError 形状)。 */
  fetchCredentials(): Promise<CredentialsPayload>;
  /** POST /api/model-access/credentials/rotate。 */
  rotateCredentials(): Promise<CredentialsPayload>;
  /** 读本机 XD key(providerSecretStore 'xd')。 */
  readXdKey(): string | null;
  /** 写本机 XD key,含 codex env-key 重启副作用;false = 落盘失败。 */
  writeXdKey(key: string): Promise<boolean>;
  store: ModelAccessCredentialsStore;
  /** 状态变化回调(index.ts 接 broadcast)。 */
  onStatusChange(status: ModelAccessStatus): void;
  /** 自动重试退避(默认 [2s, 8s];首次尝试不算)。 */
  retryDelaysMs?: number[];
  sleep?(ms: number): Promise<void>;
  log?: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

export interface CredentialsSync {
  getStatus(): ModelAccessStatus;
  /**
   * 登录触发的同步(fire-and-forget 语义,返回的 Promise 仅供测试/重试入口等待)。
   * unsupported 终态下不再发起(切换账号会先经 handleAuthChange 复位)。
   */
  sync(): Promise<ModelAccessStatus>;
  /** UI 手动重试:复位终态限制后重新同步。 */
  retry(): Promise<ModelAccessStatus>;
  /** 轮换:成功返回新状态;失败抛 CredentialsFetchError 形状(IPC 层映射错误码)。 */
  rotate(): Promise<ModelAccessStatus>;
  /**
   * 登录/登出/切账号入口(authManager.onAuthStateChange)。
   * userId + realm 构成身份边界:runtime refresh 换号或同账号跨区都可能
   * **不经过** isAuthenticated:false,只有携带完整身份才能作废旧请求。
   */
  handleAuthChange(state: {
    isAuthenticated: boolean;
    userId?: string | null;
    realm?: AuthRegion | null;
  }): void;
  /** 手填保存成功(safe-storage IPC 层通知):source 翻 manual。 */
  noteManualKeySaved(): void;
  /** 手填 key 被删除:清来源标记。 */
  noteManualKeyRemoved(): void;
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000];

export function createCredentialsSync(deps: CredentialsSyncDeps): CredentialsSync {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  let status: ModelAccessStatus = snapshot('idle');
  let inflight: Promise<ModelAccessStatus> | null = null;
  /**
   * 认证世代号:登出、换账号或同账号跨区时自增。所有写盘(key/endpoint/状态)
   * 都以发起时捕获的世代为闸——旧身份的在途请求在世代变更后一律作废。
   */
  let epoch = 0;
  /** 在途同步所属的世代;世代变更后旧 inflight 不再被复用。 */
  let inflightEpoch = -1;
  /** 当前登录身份(handleAuthChange 维护),null = 未登录/未知。 */
  let currentUserId: string | null = null;
  let currentRealm: AuthRegion | null = null;

  function snapshot(
    state: ModelAccessStatus['state'],
    errorCode?: string,
  ): ModelAccessStatus {
    return {
      state,
      ...(errorCode ? { errorCode } : {}),
      source: deps.store.getSource(),
      endpoint: deps.store.getServerEndpoint(),
      accountTier: null,
    };
  }

  function setStatus(state: ModelAccessStatus['state'], errorCode?: string): ModelAccessStatus {
    status = snapshot(state, errorCode);
    deps.onStatusChange(status);
    return status;
  }

  /** 世代闸下的状态写入:发起世代已过期则不动状态(旧请求的余波不得污染新账号)。 */
  function setStatusIfFresh(
    myEpoch: number,
    state: ModelAccessStatus['state'],
    errorCode?: string,
  ): ModelAccessStatus {
    if (myEpoch !== epoch) return status;
    return setStatus(state, errorCode);
  }

  /** 单次拉取 + 落盘。返回终局状态;'retryable' 可退避重试;'stale' = 世代已过期。 */
  async function attemptOnce(myEpoch: number): Promise<ModelAccessStatus | 'retryable' | 'stale'> {
    let payload: CredentialsPayload;
    try {
      payload = await deps.fetchCredentials();
    } catch (err) {
      if (myEpoch !== epoch) return 'stale';
      const e = asFetchError(err);
      if (e.statusCode === 503 || e.code === 'MODEL_ACCESS_DISABLED') {
        deps.log?.info('model-access disabled on server, falling back to manual key flow');
        return setStatusIfFresh(myEpoch, 'disabled');
      }
      if (e.statusCode === 403 || e.code === 'ORG_NOT_SUPPORTED') {
        deps.log?.info('org not supported by model-access, xd provider unavailable');
        return setStatusIfFresh(myEpoch, 'unsupported');
      }
      deps.log?.warn(`model-access credentials fetch failed: ${e.code} (${e.statusCode})`);
      return 'retryable';
    }
    if (myEpoch !== epoch) return 'stale'; // 响应归属旧账号,丢弃
    if (!isValidCredentialsPayload(payload)) {
      deps.log?.warn('model-access credentials response invalid (empty key / bad endpoint), kept local');
      return 'retryable';
    }
    return applyPayload(payload, myEpoch);
  }

  /** 下发结果落盘(sync 与 rotate 共用,世代闸)。值未变不写 key,不触发 codex 重启。 */
  async function applyPayload(
    payload: CredentialsPayload,
    myEpoch: number,
  ): Promise<ModelAccessStatus> {
    if (myEpoch !== epoch) return status;
    const current = deps.readXdKey();
    if (current !== payload.apiKey) {
      const ok = await deps.writeXdKey(payload.apiKey);
      if (myEpoch !== epoch) return status;
      if (!ok) {
        deps.log?.warn('model-access key write failed (safeStorage unavailable?)');
        return setStatus('failed', 'SAFE_STORAGE_UNAVAILABLE');
      }
    }
    deps.store.setServerCredentials(payload.endpoint);
    return setStatus('ok');
  }

  async function runSync(myEpoch: number): Promise<ModelAccessStatus> {
    if (myEpoch !== epoch) return status;
    setStatus('syncing');
    for (let attempt = 0; ; attempt++) {
      const result = await attemptOnce(myEpoch);
      if (result === 'stale' || myEpoch !== epoch) return status; // 登出/换账号,放弃本轮
      if (result !== 'retryable') return result;
      if (attempt >= retryDelays.length) {
        return setStatusIfFresh(myEpoch, 'failed', 'SYNC_FAILED');
      }
      await sleep(retryDelays[attempt]);
      if (myEpoch !== epoch) return status;
    }
  }

  function startSync(): Promise<ModelAccessStatus> {
    // 只复用**同世代**的在途请求;旧世代 inflight 会因世代闸自行作废,
    // 这里直接为当前账号发起新一轮(短暂并行无害,旧轮零写盘)。
    if (inflight && inflightEpoch === epoch) return inflight;
    const myEpoch = epoch;
    inflightEpoch = myEpoch;
    const run = runSync(myEpoch).finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
  }

  return {
    getStatus() {
      return status;
    },

    sync() {
      // unsupported / disabled 是本轮登录期内的终态:重复触发(refresh 等)不再打服务端。
      if (status.state === 'unsupported' || status.state === 'disabled') {
        return Promise.resolve(status);
      }
      return startSync();
    },

    retry() {
      // 手动重试允许从任何状态(含 disabled——灰度可能刚打开)重新发起;
      // 同世代在途请求由 startSync 内部复用。
      return startSync();
    },

    async rotate() {
      // rotate 不与 sync 合并:等待在途同步完成后执行,语义上必须真的轮换。
      if (inflight) await inflight.catch(() => undefined);
      const myEpoch = epoch;
      const payload = await deps.rotateCredentials(); // 失败原样抛给 IPC 层映射
      if (myEpoch !== epoch) {
        // 轮换响应归属旧账号(期间登出/换号),不落盘。
        throw Object.assign(new Error('rotate outcome discarded: account changed'), {
          code: 'STALE_ACCOUNT',
          statusCode: 0,
        });
      }
      if (!isValidCredentialsPayload(payload)) {
        throw Object.assign(new Error('rotate response invalid'), {
          code: 'INVALID_RESPONSE',
          statusCode: 0,
        });
      }
      return applyPayload(payload, myEpoch);
    },

    handleAuthChange(state) {
      if (state.isAuthenticated) {
        const userId = state.userId ?? null;
        const realm = state.realm ?? null;
        if (
          hasAuthSessionIdentityChanged(
            { userId: currentUserId, realm: currentRealm },
            { userId, realm },
          )
        ) {
          // runtime refresh 换号或同账号跨区(均可能不经过登出):作废旧请求与终态。
          epoch++;
        }
        if (userId !== null) currentUserId = userId;
        if (realm !== null) currentRealm = realm;
        void startSync().catch(() => undefined);
      } else {
        // 登出/会话失效:复位状态机(含 unsupported 终态),不动本地 key/元数据。
        epoch++;
        currentUserId = null;
        currentRealm = null;
        setStatus('idle');
      }
    },

    noteManualKeySaved() {
      deps.store.setManualSource();
      // 手填即视为用户显式选择手动模式;同步状态保持现状(disabled/failed 下手填是兜底)。
      setStatus(status.state, status.errorCode);
    },

    noteManualKeyRemoved() {
      deps.store.clear();
      setStatus(status.state, status.errorCode);
    },
  };
}
