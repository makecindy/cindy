import { app, BrowserWindow, ipcMain } from 'electron';

import { createLogger } from '../logger.js';
import * as authManager from '../authManager.js';
import { serverApiFetch, ServerApiError } from '../serverApiClient.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { getCodexProxyAuthInjectionState } from '../maker-host/codex-proxy-host.js';
import {
  prepareCodexForAuthModeChange,
  finalizeCodexAfterAuthModeChange,
  cancelCodexAuthModeChange,
} from '../maker-host/index.js';
import {
  getXdGatewayModels,
  markXdGatewayModelAccessUnknown,
  setXdGatewayModels,
} from '../maker-host/active-catalog.js';
import { migrateLegacyNamespacedModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { replaceGatewayModelPricing, trackGatewayModelPricingSync } from '../usage/modelPricing.js';
import { isPricedGatewayModel } from '../../shared/modelPriceQuote.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  MODEL_ACCESS_STATUS_CHANNEL,
  type ModelAccessAccountTier,
  type ModelAccessGatewayModel,
  type ModelAccessStatus,
} from '../../shared/modelAccess.js';
import { getModelAccessCredentialsStore } from './credentialsStore.js';
import { getAppCapabilities } from '../appCapabilities.js';
import {
  createCredentialsSync,
  type CredentialsPayload,
  type CredentialsSync,
} from './credentialsSync.js';
import {
  buildModelsSyncRequest,
  ensureCredentialsReadyForModelsRefresh,
  modelsWithoutStalePaymentUpsell,
  parseModelsSyncPayload,
  shouldPreservePaymentRequiredRoutes,
  withModelsSyncOverallDeadline,
  waitForModelsSyncRefresh,
} from './modelsSyncRefresh.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';
import { hasAuthSessionIdentityChanged } from './authSessionIdentity.js';
import {
  listExecutableMediaModels,
  resetExecutableMediaModelCache,
} from './mediaModels.js';
export { isModelAccessReady } from './readiness.js';

const log = createLogger('modelAccess');

/**
 * model-access/index.ts — 网关凭据自动下发的 desktop 接线层。
 * ---------------------------------------------------------------------------
 * 组装 credentialsSync 的真实依赖并接入:
 *  - authManager.onAuthStateChange:登录(completeLogin / 冷启动 / refresh 换号)
 *    自动触发同步,登出复位;
 *  - serverApiFetch + 独立 base(clientEndpoints 'modelAccessApiBaseUrl'):
 *    自动带 Bearer access token + 401 refresh;
 *  - providerSecretStore('xd')写 key,值变化时复用 codex env-key 重启副作用
 *    (与 safe-storage IPC 层同一套 prepare/finalize,见 bootstrap-electron 注释)
 *    ——main 侧自动写 key 的副作用缺口在此补齐(providerSecretStore.ts 顶注预告过);
 *  - 状态经 MODEL_ACCESS_STATUS_CHANNEL 推给所有窗口,IPC 提供
 *    get-status / retry / rotate 三个通道(仅本机设置页使用,不进 device-link
 *    allowlist)。
 */

const CREDENTIALS_PATH = '/api/model-access/credentials';

function notifyXdProviderKeyChanged(): void {
  getGhostSetupChangeBus().emitAll({
    source: 'host_config',
    ref: 'model-provider',
  });
}

function fetchCredentials(): Promise<CredentialsPayload> {
  return serverApiFetch<CredentialsPayload>(CREDENTIALS_PATH, {
    baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
  });
}

function rotateCredentials(): Promise<CredentialsPayload> {
  return serverApiFetch<CredentialsPayload>(`${CREDENTIALS_PATH}/rotate`, {
    method: 'POST',
    baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
  });
}

/**
 * 写 XD key(main 侧自动下发路径),带 codex env-key 重启副作用:
 * env-key spawn 的 codex app-server 把 gateway key 冻在子进程 env 里,写盘后
 * 必须重建才生效——与 renderer 手填走的 safe-storage IPC 同一套语义。
 * 非 env-key 形态零副作用(Claude 每 session 现读 key,天然跟随)。
 */
async function writeXdKeyWithCodexSideEffect(key: string): Promise<boolean> {
  const needRestart = getCodexProxyAuthInjectionState() === 'env-key';
  if (!needRestart) {
    const stored = getProviderSecretStore().set('xd', key);
    if (stored) notifyXdProviderKeyChanged();
    return stored;
  }
  try {
    await prepareCodexForAuthModeChange();
  } catch (err) {
    log.warn('prepare codex before auto key write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const ok = getProviderSecretStore().set('xd', key);
  if (!ok) {
    cancelCodexAuthModeChange();
    return false;
  }
  notifyXdProviderKeyChanged();
  try {
    await finalizeCodexAfterAuthModeChange();
  } catch (err) {
    // key 已写盘(新值有效);codex 重建失败只记日志,下次 spawn 自然用新 key。
    log.warn('finalize codex after auto key write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

let accountTier: ModelAccessAccountTier | null = null;

function statusWithAccountTier(status: ModelAccessStatus): ModelAccessStatus {
  return { ...status, accountTier };
}

function broadcastStatus(status: ModelAccessStatus): void {
  const payload = statusWithAccountTier(status);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MODEL_ACCESS_STATUS_CHANNEL, payload);
    }
  }
}

function setAccountTier(next: ModelAccessAccountTier | null): void {
  if (accountTier === next) return;
  accountTier = next;
  broadcastStatus(getSync().getStatus());
}

// ─── XD 网关模型目录同步(`/models` 是模型、能力与价格的唯一事实源)─────────
// 凭据同步成功后从 model-access-server 拉现有 GET /models：聊天模型与
// 媒体模型都来自同一份 AIGateway /model-groups 投影。active-catalog 按 agents
// 重建聊天目录；媒体存在性仍按 mode，客户端另行预检 Guide operation 与执行器兼容性，
// 只把当前可执行投影交给插件设置和 Core media。调用时仍按 modelId 再取 Guide 复验。
// 拉取失败保留最后一次完整成功快照；成功空列表同时清空模型和价格。

let modelsSyncInflight: Promise<void> | null = null;
/** 模型请求的单调尝试号与最近成功号，供手动刷新区分“旧成功 + 本次失败”。 */
let modelsSyncAttempt = 0;
let lastModelsSyncSucceededAttempt = 0;
let lastModelsSyncStartedAt = 0;
export const XD_MODELS_FOREGROUND_REFRESH_INTERVAL_MS = 5 * 60_000;
/** 在途目录请求所属的认证世代。 */
let modelsSyncGen = -1;
/** 旧世代请求在途时新账号的补发标记。 */
let modelsSyncRerunQueued = false;
/**
 * 认证世代:登出或 userId / realm 变化时自增(与 credentialsSync 的 epoch 同语义)。
 * 目录请求以发起时世代为闸——旧身份的在途 /models 响应在换号或同账号跨区后
 * 一律丢弃,且新身份会补发自己的请求。
 */
let authGeneration = 0;
let lastAuthUserId: string | null = null;
let lastAuthRealm: ReturnType<typeof authManager.getActiveAuthRealm> | null = null;

function applyGatewayModels(
  models: ModelAccessGatewayModel[],
  options: {
    authenticatedUserId?: string;
    authoritative?: boolean;
    preservePaymentRequiredRoutes?: boolean;
  } = {},
): void {
  // 同一次 /models 响应建立 XD 模型与价格投影。空成功响应会同时清空模型和价格；请求失败不会调用本函数，
  // 因而保留上一份完整成功快照。
  const pricing = replaceGatewayModelPricing(models, options.authenticatedUserId);
  // 分母只算会产生报价的条目:免费/无价条目按设计不出报价,不该把健康目录
  // 也报成覆盖不足。此时覆盖缺口只剩一种成因——币种声明与目录冲突被丢弃,
  // 这在 #587 之前是全程静默的,这行日志让现场可判。
  const pricedCount = models.filter(isPricedGatewayModel).length;
  const quoteCount = Object.keys(pricing.xd ?? {}).length;
  if (quoteCount < pricedCount) {
    log.warn(
      `xd gateway pricing quotes cover ${quoteCount}/${pricedCount} priced models (${models.length} total)`,
    );
  }
  // 能力字段不在客户端二次转换 —— Model Access Server 已把 Gateway 的
  // contextLength / supportedEndpoints / reasoning / supportsServiceTier / architecture
  // 一次归一化成 contextWindow / agents / efforts / supportsFastMode / modalities,
  // 同一含义只下发一个字段。这里直接用下发值，唯一事实源在服务端。
  // active-catalog 统一收口会原地刷新 Maker capabilities，再广播同一 revision。
  try {
    migrateLegacyNamespacedModelDisableOverrides(
      'xd',
      models
        .filter(
          (model) =>
            model.mode === 'image_generation' || model.mode === 'video_generation',
        )
        .map((model) => model.id),
    );
  } catch (error) {
    // 偏好迁移失败不能拖垮权威模型目录；读路径仍保留唯一 basename 兼容判定。
    log.warn('legacy media model disable override migration failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  resetExecutableMediaModelCache();
  setXdGatewayModels(models, {
    authoritative: options.authoritative ?? false,
    preservePaymentRequiredRoutes: options.preservePaymentRequiredRoutes,
  });
}

async function runModelsSync(
  myGen: number,
  authenticatedUserId: string,
  myAttempt: number,
): Promise<void> {
  // 新请求开始后，旧 LKG 仍可展示但不再能证明“当前账号明确没有某模型”。
  // 只有本次同认证世代的成功响应会重新把三态提升为 authoritative。
  markXdGatewayModelAccessUnknown();
  let models: ModelAccessGatewayModel[];
  try {
    const request = buildModelsSyncRequest(() => getClientEndpoint('modelAccessApiBaseUrl'));
    const payload = await withModelsSyncOverallDeadline(
      serverApiFetch<unknown>(request.path, request.options),
    );
    const parsed = parseModelsSyncPayload(payload);
    if (!parsed.ok) {
      log.warn('xd gateway models response rejected (keeping executable last valid list)', {
        error: parsed.error,
      });
      if (myGen === authGeneration) {
        setAccountTier(null);
        setXdGatewayModels(modelsWithoutStalePaymentUpsell(getXdGatewayModels()), {
          authoritative: false,
          preservePaymentRequiredRoutes: true,
        });
      }
      return;
    }
    models = parsed.models;
    if (myGen === authGeneration) setAccountTier(parsed.accountTier);
  } catch (err) {
    log.warn('xd gateway models fetch failed (keeping executable last valid list)', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (myGen === authGeneration) {
      setAccountTier(null);
      setXdGatewayModels(modelsWithoutStalePaymentUpsell(getXdGatewayModels()), {
        authoritative: false,
        preservePaymentRequiredRoutes: true,
      });
    }
    return;
  }
  if (myGen !== authGeneration) return; // 响应归属旧账号,丢弃
  if (models.length === 0) {
    log.warn('xd gateway models fetch returned empty list; clearing current list');
    applyGatewayModels([], { authenticatedUserId, authoritative: true });
    lastModelsSyncSucceededAttempt = myAttempt;
    return;
  }
  log.info(`xd gateway models synced: ${models.length}`);
  applyGatewayModels(models, { authenticatedUserId, authoritative: true });
  try {
    const availability = await listExecutableMediaModels([], {
      includeDisabled: true,
      forceRefresh: true,
    });
    if (myGen !== authGeneration) return;
    // executable cache 已按当前客户端 Guide 能力重建；再次提升 catalog revision，
    // 让同步读取插件设置的界面从临时空清单刷新到可执行投影。
    setXdGatewayModels(models);
    if (availability.unavailable.length > 0) {
      log.warn('xd media Guide preflight isolated unavailable models', {
        unavailableModelCount: availability.unavailable.length,
      });
    }
  } catch (error) {
    // 原始模型目录仍然有效；Guide 预检失败只让媒体可执行投影保持为空，
    // 不能撤销聊天目录或拖垮登录后的模型同步。
    log.warn('xd media Guide preflight failed; keeping media execution disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  lastModelsSyncSucceededAttempt = myAttempt;
}

/** 触发一次模型目录同步(同世代 single-flight;旧世代在途时为新账号排队补发)。 */
function scheduleModelsSync(): void {
  const gen = authGeneration;
  // localDb takeover and /models run independently during startup. Capture the
  // authenticated owner here instead of asking localDb who owns the cache only
  // after the network response arrives.
  const authenticatedUserId = lastAuthUserId;
  if (!authenticatedUserId) {
    log.warn('xd gateway models sync skipped: authenticated user id unavailable');
    return;
  }
  if (modelsSyncInflight) {
    if (modelsSyncGen === gen) return; // 同账号在途,复用
    if (!modelsSyncRerunQueued) {
      // 旧账号请求在途:等它结束(其结果会被世代闸丢弃)后为当前账号补发。
      modelsSyncRerunQueued = true;
      void modelsSyncInflight.finally(() => {
        modelsSyncRerunQueued = false;
        scheduleModelsSync();
      });
    }
    return;
  }
  modelsSyncGen = gen;
  const attempt = ++modelsSyncAttempt;
  lastModelsSyncStartedAt = Date.now();
  modelsSyncInflight = runModelsSync(gen, authenticatedUserId, attempt)
    .catch((err) => {
      log.warn('xd gateway models sync threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      modelsSyncInflight = null;
    });
  trackGatewayModelPricingSync(modelsSyncInflight);
}

let syncInstance: CredentialsSync | null = null;
let foregroundRefreshListener: (() => void) | null = null;

function getSync(): CredentialsSync {
  if (!syncInstance) {
    syncInstance = createCredentialsSync({
      fetchCredentials,
      rotateCredentials,
      readXdKey: () => getProviderSecretStore().get('xd'),
      writeXdKey: writeXdKeyWithCodexSideEffect,
      store: getModelAccessCredentialsStore(),
      onStatusChange: (status) => {
        if (['failed', 'disabled', 'unsupported', 'idle'].includes(status.state)) {
          accountTier = null;
        }
        broadcastStatus(status);
        // 凭据就绪(下发/轮换成功)→ 拉取网关模型目录(XD 模型列表的权威来源)。
        if (status.state === 'ok') scheduleModelsSync();
        // failed 是同一账号下的临时同步失败，credentialsSync 明确保留本地 key；隐藏
        // 过期营销列表的同时必须保留最近一次付费拒绝，避免已有会话绕过路由守卫。
        // disabled / unsupported / idle 是真实能力边界，清空模型和拒绝快照。
        else if (status.state === 'failed') {
          applyGatewayModels([], {
            preservePaymentRequiredRoutes: shouldPreservePaymentRequiredRoutes(status),
          });
        } else if (['disabled', 'unsupported', 'idle'].includes(status.state)) {
          applyGatewayModels([]);
        }
      },
      log: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
      },
    });
  }
  return syncInstance;
}

/** 当前同步状态(renderer 首帧经 IPC 拉;main 内部也可直接读)。 */
export function getModelAccessStatus(): ModelAccessStatus {
  return statusWithAccountTier(getSync().getStatus());
}

/**
 * 设置页手动刷新：已有 ready 凭据时直接刷新 `/models`；只有凭据不可用时才复用
 * retry 状态机。随后等待同源 `/models` single-flight 真正结束。凭据或模型请求
 * 任一失败都 reject，Renderer 才不会误报“已刷新”。
 */
export async function refreshXdGatewayModels(): Promise<void> {
  if (!getAppCapabilities().canUseCindyGateway) {
    throwIpcError('PERMISSION_DENIED', 'Cindy AI requires a Cindy account.');
  }
  // Capture the call boundary before credential recovery can schedule a request. A flight that
  // already existed here may have read entitlement before a just-completed payment; explicit
  // refresh must wait through it and require a strictly newer attempt.
  const minimumAttempt = modelsSyncAttempt + 1;
  const status = await ensureCredentialsReadyForModelsRefresh(getSync());
  if (status.state !== 'ok') {
    throwIpcError('MODEL_ACCESS_FAILED', 'Cindy AI credentials are not ready.');
  }
  const gen = authGeneration;
  // onStatusChange(ok) 已经 schedule；重复调用会复用同世代在途请求。若此时仍有
  // 旧账号 flight，先等它作废，再显式补发当前世代并等待当前尝试号的真实结果。
  const outcome = await waitForModelsSyncRefresh({
    expectedGeneration: gen,
    minimumAttempt,
    schedule: scheduleModelsSync,
    snapshot: () => ({
      flight: modelsSyncInflight,
      generation: modelsSyncGen,
      attempt: modelsSyncAttempt,
    }),
    currentGeneration: () => authGeneration,
    lastSuccessfulAttempt: () => lastModelsSyncSucceededAttempt,
  });
  switch (outcome) {
    case 'succeeded':
      return;
    case 'not-started':
      throwIpcError('MODEL_ACCESS_FAILED', 'Cindy AI model list refresh did not start.');
    case 'account-changed':
      throwIpcError('MODEL_ACCESS_FAILED', 'Cindy AI account changed during model list refresh.');
    case 'failed':
      throwIpcError('MODEL_ACCESS_FAILED', 'Cindy AI model list refresh failed.');
  }
}

/** 存量手填 key 场景的写入通知(safe-storage IPC 层保留的兼容钩子):来源标记翻 manual。 */
export function noteManualXdKeySaved(): void {
  getSync().noteManualKeySaved();
}

/** 手填 key 被删除(safe-storage IPC 层通知):清来源标记。 */
export function noteManualXdKeyRemoved(): void {
  getSync().noteManualKeyRemoved();
}

function mapServerError(err: unknown): never {
  if (err instanceof ServerApiError) {
    if (err.statusCode === 503 || err.code === 'MODEL_ACCESS_DISABLED') {
      throwIpcError('MODEL_ACCESS_DISABLED', '模型访问服务未启用');
    }
    if (err.statusCode === 403 || err.code === 'ORG_NOT_SUPPORTED') {
      throwIpcError('MODEL_ACCESS_UNSUPPORTED', '当前企业未开通模型访问');
    }
    throwIpcError('MODEL_ACCESS_FAILED', err.message);
  }
  throwIpcError('MODEL_ACCESS_FAILED', err instanceof Error ? err.message : String(err));
}

/**
 * 初始化:订阅登录态变化 + 注册 IPC。在 bootstrap 的 IPC 注册阶段调用一次。
 * onAuthStateChange 覆盖 completeLogin / 冷启动 initialize / refresh 换账号
 * 三条入口(authManager.notifyAuthListeners 的全部触发点),无需插桩 authManager。
 */
export function initModelAccess(): void {
  const sync = getSync();

  const noteAuthState = (
    isAuthenticated: boolean,
    userId: string | null,
    realm: ReturnType<typeof authManager.getActiveAuthRealm> | null,
  ) => {
    // 认证世代:登出、换号或同账号跨区均自增,作废旧身份在途的目录请求。
    if (
      !isAuthenticated ||
      hasAuthSessionIdentityChanged(
        { userId: lastAuthUserId, realm: lastAuthRealm },
        { userId, realm },
      )
    ) {
      authGeneration++;
      accountTier = null;
      // 旧身份模型清单不能跨账号/区域继续显示;新身份拉取成功后再注入。
      applyGatewayModels([]);
    }
    lastAuthUserId = isAuthenticated ? (userId ?? lastAuthUserId) : null;
    lastAuthRealm = isAuthenticated ? (realm ?? lastAuthRealm) : null;
    sync.handleAuthChange({ isAuthenticated, userId, realm });
  };

  authManager.onAuthStateChange((state) => {
    noteAuthState(
      state.isAuthenticated,
      state.user?.id ?? null,
      state.isAuthenticated ? authManager.getActiveAuthRealm() : null,
    );
  });
  // 订阅挂载时可能已错过冷启动的首次 notify(初始化顺序取决于 bootstrap),补一次。
  const initial = authManager.getAuthState();
  if (initial.isAuthenticated) {
    noteAuthState(true, initial.user?.id ?? null, authManager.getActiveAuthRealm());
  }
  foregroundRefreshListener = () => {
    if (!lastAuthUserId || getSync().getStatus().state !== 'ok') return;
    if (Date.now() - lastModelsSyncStartedAt < XD_MODELS_FOREGROUND_REFRESH_INTERVAL_MS) return;
    scheduleModelsSync();
  };
  app.on('browser-window-focus', foregroundRefreshListener);
  ipcMain.handle('model-access:get-status', () => getModelAccessStatus());

  ipcMain.handle('model-access:retry', async (): Promise<ModelAccessStatus> => {
    if (!getAppCapabilities().canUseCindyGateway) {
      throwIpcError('PERMISSION_DENIED', 'Cindy AI requires a Cindy account.');
    }
    return statusWithAccountTier(await sync.retry());
  });

  ipcMain.handle('model-access:rotate', async (): Promise<ModelAccessStatus> => {
    if (!getAppCapabilities().canUseCindyGateway) {
      throwIpcError('PERMISSION_DENIED', 'Cindy AI requires a Cindy account.');
    }
    try {
      return statusWithAccountTier(await sync.rotate());
    } catch (err) {
      mapServerError(err);
    }
  });
}

/** 仅测试:重置单例。 */
export function resetModelAccessForTest(): void {
  if (foregroundRefreshListener) {
    app.removeListener('browser-window-focus', foregroundRefreshListener);
    foregroundRefreshListener = null;
  }
  syncInstance = null;
  modelsSyncInflight = null;
  modelsSyncGen = -1;
  modelsSyncRerunQueued = false;
  modelsSyncAttempt = 0;
  lastModelsSyncSucceededAttempt = 0;
  lastModelsSyncStartedAt = 0;
  authGeneration = 0;
  lastAuthUserId = null;
  lastAuthRealm = null;
  accountTier = null;
  applyGatewayModels([]);
}
