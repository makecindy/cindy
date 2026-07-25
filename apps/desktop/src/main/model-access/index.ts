import { BrowserWindow, ipcMain } from 'electron';

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
import { getActiveCatalog, setXdGatewayModels } from '../maker-host/active-catalog.js';
import { isDev } from '../manifestService.js';
import { overlayCindyModelMeta } from './devMetaOverlay.js';
import {
  replaceGatewayModelPricing,
  trackGatewayModelPricingSync,
} from '../usage/modelPricing.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  MODEL_ACCESS_STATUS_CHANNEL,
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
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';
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
const MODELS_PATH = '/api/model-access/models';

function notifyXdProviderKeyChanged(): void {
  getGhostSetupChangeBus().emitAll({
    source: 'host_config',
    ref: 'model-provider',
  });
}

function fetchCredentials(): Promise<CredentialsPayload> {
  return serverApiFetch<CredentialsPayload>(CREDENTIALS_PATH, {
    baseUrl: getClientEndpoint('modelAccessApiBaseUrl'),
  });
}

function rotateCredentials(): Promise<CredentialsPayload> {
  return serverApiFetch<CredentialsPayload>(`${CREDENTIALS_PATH}/rotate`, {
    method: 'POST',
    baseUrl: getClientEndpoint('modelAccessApiBaseUrl'),
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

function broadcastStatus(status: ModelAccessStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MODEL_ACCESS_STATUS_CHANNEL, status);
    }
  }
}

// ─── XD 网关模型目录同步(网关为准,目录仅补元数据)────────────────────
// 凭据同步成功后从 model-access-server 拉 GET /models(AIGateway /model-groups
// 的 mode=chat 投影),整体重建 xd 供应商的模型列表(active-catalog
// setXdGatewayModels)。拉取失败保留最后一次完整成功快照；成功空列表同时清空模型和价格。

let modelsSyncInflight: Promise<void> | null = null;
/** 在途目录请求所属的认证世代。 */
let modelsSyncGen = -1;
/** 旧世代请求在途时新账号的补发标记。 */
let modelsSyncRerunQueued = false;
/**
 * 认证世代:登出或 userId 变化时自增(与 credentialsSync 的 epoch 同语义)。
 * 目录请求以发起时世代为闸——A 账号的在途 /models 响应在切到 B 后一律丢弃,
 * 且 B 会补发自己的请求(PR review P1:旧账号目录不得覆盖新账号)。
 */
let authGeneration = 0;
let lastAuthUserId: string | null = null;

function applyGatewayModels(models: ModelAccessGatewayModel[]): void {
  // 同一次 /models 响应先建立 provider-scoped 价格投影，再做仅影响展示元数据的
  // dev overlay。空成功响应会同时清空模型和价格；请求失败不会调用本函数，
  // 因而保留上一份完整成功快照。
  replaceGatewayModelPricing(models);
  // dev:本地目录文件(catalog/providers.json)的 cindyModelMeta 段覆盖服务端下发的
  // 元数据,改本地 json + 重启即可自测,无需发 OSS / 等服务端热加载;只覆盖同 id,
  // 清单成员资格仍以网关为准。packaged 不走此分支(语义见 devMetaOverlay.ts)。
  const effective =
    isDev() && models.length > 0
      ? overlayCindyModelMeta(models, getActiveCatalog().cindyModelMeta, log)
      : models;
  // active-catalog 统一收口会原地刷新 Maker capabilities，再广播同一 revision。
  setXdGatewayModels(effective);
}

async function runModelsSync(myGen: number): Promise<void> {
  let payload: { models: ModelAccessGatewayModel[] };
  try {
    payload = await serverApiFetch<{ models: ModelAccessGatewayModel[] }>(MODELS_PATH, {
      baseUrl: getClientEndpoint('modelAccessApiBaseUrl'),
    });
  } catch (err) {
    log.warn('xd gateway models fetch failed (keeping last valid list)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (myGen !== authGeneration) return; // 响应归属旧账号,丢弃
  const models = (payload.models ?? []).filter((m) => typeof m?.id === 'string' && m.id);
  if (models.length === 0) {
    log.warn('xd gateway models fetch returned empty list; clearing current list');
    applyGatewayModels([]);
    return;
  }
  log.info(`xd gateway models synced: ${models.length}`);
  applyGatewayModels(models);
}

/** 触发一次模型目录同步(同世代 single-flight;旧世代在途时为新账号排队补发)。 */
function scheduleModelsSync(): void {
  const gen = authGeneration;
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
  modelsSyncInflight = runModelsSync(gen)
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

function getSync(): CredentialsSync {
  if (!syncInstance) {
    syncInstance = createCredentialsSync({
      fetchCredentials,
      rotateCredentials,
      readXdKey: () => getProviderSecretStore().get('xd'),
      writeXdKey: writeXdKeyWithCodexSideEffect,
      store: getModelAccessCredentialsStore(),
      onStatusChange: (status) => {
        broadcastStatus(status);
        // 凭据就绪(下发/轮换成功)→ 拉取网关模型目录(XD 模型列表的权威来源)。
        if (status.state === 'ok') scheduleModelsSync();
        // 凭据明确不可用时,旧模型清单也不再具备可用性证明。syncing 期间先保留
        // 已成功拉到的清单,最终成功会覆盖、失败会走这里清空。
        else if (['failed', 'disabled', 'unsupported', 'idle'].includes(status.state)) {
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
  return getSync().getStatus();
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

  const noteAuthState = (isAuthenticated: boolean, userId: string | null) => {
    // 认证世代:登出或换号自增,作废旧账号在途的目录请求(runModelsSync 世代闸)。
    if (!isAuthenticated || (userId !== null && lastAuthUserId !== null && userId !== lastAuthUserId)) {
      authGeneration++;
      // 旧账号模型清单不能跨账号继续显示;新账号凭据 / 模型拉取成功后再注入。
      applyGatewayModels([]);
    }
    lastAuthUserId = isAuthenticated ? (userId ?? lastAuthUserId) : null;
    sync.handleAuthChange({ isAuthenticated, userId });
  };

  authManager.onAuthStateChange((state) => {
    noteAuthState(state.isAuthenticated, state.user?.id ?? null);
  });
  // 订阅挂载时可能已错过冷启动的首次 notify(初始化顺序取决于 bootstrap),补一次。
  const initial = authManager.getAuthState();
  if (initial.isAuthenticated) {
    noteAuthState(true, initial.user?.id ?? null);
  }
  ipcMain.handle('model-access:get-status', () => sync.getStatus());

  ipcMain.handle('model-access:retry', async (): Promise<ModelAccessStatus> => {
    if (!getAppCapabilities().canUseCindyGateway) {
      throwIpcError('PERMISSION_DENIED', 'Cindy AI requires a Cindy account.');
    }
    return sync.retry();
  });

  ipcMain.handle('model-access:rotate', async (): Promise<ModelAccessStatus> => {
    if (!getAppCapabilities().canUseCindyGateway) {
      throwIpcError('PERMISSION_DENIED', 'Cindy AI requires a Cindy account.');
    }
    try {
      return await sync.rotate();
    } catch (err) {
      mapServerError(err);
    }
  });
}

/** 仅测试:重置单例。 */
export function resetModelAccessForTest(): void {
  syncInstance = null;
  modelsSyncInflight = null;
  modelsSyncGen = -1;
  modelsSyncRerunQueued = false;
  authGeneration = 0;
  lastAuthUserId = null;
  applyGatewayModels([]);
}
