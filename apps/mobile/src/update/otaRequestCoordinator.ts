import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';

import type { UpdateChannel } from '@cindy/maker-shared/update-channel';

import { OTA_SERVER_BASE_URL } from '@/config/env';
import { updateChannelRequestHeaders } from './canaryChannelStore';

/**
 * expo-updates 要求 EAS-Client-ID 是合法 UUID；自建 OTA 全设备共用这个非设备标识值。
 * 它只进入 JS runtime override，不进入 app.config.js，因此不会改变 runtime fingerprint。
 */
export const SHARED_OTA_CLIENT_ID = '00000000-0000-4000-8000-000000000000';
export const EAS_CLIENT_ID_HEADER = 'EAS-Client-ID';

const STORAGE_KEY = 'cindy.mobile.update.request-header-baseline.v1';
const EMERGENCY_BASELINE_UPDATE_ID = 'embedded-emergency-launch';

// Bootstrap 边界：已经内置 #3359 且 consent=false 的旧客户端不会请求任何 OTA，尚未
// 到达设备的 JS 无法解除这道门。用户必须先同意一次以取得首个 bridge OTA；bridge
// 启动后，后续自建 OTA 才全部通过本协调器匿名检查。卸载重装同一旧整包不能改变该边界。

export interface OtaCheckResult {
  isAvailable: boolean;
  manifest?: { id?: string };
}

export interface OtaFetchResult {
  isNew: boolean;
  manifest?: { id?: string };
}

/** 一次 OTA 事务可用的原生能力；三条检查路径都通过同一个实例串行执行。 */
export interface OtaRequestClient {
  checkForUpdateAsync: () => Promise<OtaCheckResult>;
  fetchUpdateAsync: () => Promise<OtaFetchResult>;
  reloadAsync: () => Promise<void>;
}

type HeaderMode = 'legacy' | 'shared';

interface HeaderBaseline {
  version: 1;
  /** 当前可启动 bundle 下载时使用的自定义 requestHeaders 形态。 */
  mode: HeaderMode;
  updateId: string;
  runtimeVersion: string;
  updateUrl: string;
  channel: UpdateChannel;
}

interface UpdateRequestConfig {
  updateUrl: string;
  requestHeaders: Record<string, string>;
}

interface CoordinatorRunOptions {
  updateUrl: string;
  channel: UpdateChannel;
  currentUpdateId: string | null;
  currentRuntimeVersion: string | null;
  checkTimeoutMs?: number;
  fetchTimeoutMs?: number;
}

interface CoordinatorDeps {
  readBaseline: () => Promise<string | null>;
  writeBaseline: (raw: string) => Promise<void>;
  setConfigOverride: (config: UpdateRequestConfig) => void;
  client: OtaRequestClient;
}

export interface OtaRequestCoordinator {
  run: <T>(
    options: CoordinatorRunOptions,
    operation: (client: OtaRequestClient) => Promise<T>,
  ) => Promise<T>;
}

export interface OtaRequestTimeouts {
  checkTimeoutMs?: number;
  fetchTimeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

function withRequestTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ota-request-timeout(${ms}ms)`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 目标请求头：保留发布通道，只把 expo-updates 的单安装 ID 覆盖成共享 UUID。 */
export function sharedOtaRequestHeaders(channel: UpdateChannel): Record<string, string> {
  return {
    ...updateChannelRequestHeaders(channel),
    [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
  };
}

function legacyOtaRequestHeaders(channel: UpdateChannel): Record<string, string> {
  return updateChannelRequestHeaders(channel);
}

function requestConfig(
  updateUrl: string,
  mode: HeaderMode,
  channel: UpdateChannel,
): UpdateRequestConfig {
  return {
    updateUrl,
    requestHeaders: mode === 'shared'
      ? sharedOtaRequestHeaders(channel)
      : legacyOtaRequestHeaders(channel),
  };
}

function sameRequestConfig(left: UpdateRequestConfig, right: UpdateRequestConfig): boolean {
  if (left.updateUrl !== right.updateUrl) return false;
  const leftEntries = Object.entries(left.requestHeaders);
  const rightEntries = Object.entries(right.requestHeaders);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right.requestHeaders[key] === value);
}

function manifestUpdateId(manifest: { id?: string } | undefined): string | null {
  const id = manifest?.id;
  return typeof id === 'string' && id.trim() ? id.toLowerCase() : null;
}

function parseBaseline(raw: string | null): HeaderBaseline | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<HeaderBaseline>;
    if (
      value.version !== 1
      || (value.mode !== 'legacy' && value.mode !== 'shared')
      || typeof value.updateId !== 'string'
      || !value.updateId.trim()
      || typeof value.runtimeVersion !== 'string'
      || !value.runtimeVersion.trim()
      || typeof value.updateUrl !== 'string'
      || !value.updateUrl.trim()
      || (value.channel !== 'release' && value.channel !== 'canary' && value.channel !== 'beta')
    ) {
      return null;
    }
    return {
      version: 1,
      mode: value.mode,
      updateId: value.updateId.toLowerCase(),
      runtimeVersion: value.runtimeVersion,
      updateUrl: value.updateUrl,
      channel: value.channel,
    };
  } catch {
    return null;
  }
}

function unavailableResult(result: OtaCheckResult): OtaCheckResult {
  return { ...result, isAvailable: false, manifest: undefined };
}

function notNewResult(result: OtaFetchResult): OtaFetchResult {
  return { ...result, isNew: false, manifest: undefined };
}

/**
 * 创建两阶段 requestHeaders 协调器。
 *
 * U1 仍由旧请求头下载并启动，所以无更新、同 ID、异常或超时时必须恢复这组旧请求头；
 * 只有用共享 UUID 成功下载了不同 ID 的 U2，并先把 U2 的基线落盘后，才允许持久保留
 * 共享请求头。expo-updates 的 override 自身会原生持久化，这个顺序是避免下次冷启动
 * 筛选不到 U1 的关键。
 */
export function createOtaRequestCoordinator(deps: CoordinatorDeps): OtaRequestCoordinator {
  let queue: Promise<void> = Promise.resolve();
  let baseline: HeaderBaseline | null = null;

  async function persistBaseline(next: HeaderBaseline): Promise<void> {
    await deps.writeBaseline(JSON.stringify(next));
    baseline = next;
  }

  async function resolveBaseline(options: CoordinatorRunOptions): Promise<HeaderBaseline> {
    const currentUpdateId = options.currentUpdateId?.toLowerCase() ?? null;
    if (!currentUpdateId) throw new Error('ota-request-current-update-id-unavailable');
    const currentRuntimeVersion = options.currentRuntimeVersion?.trim() ?? '';
    if (!currentRuntimeVersion) throw new Error('ota-request-runtime-version-unavailable');

    if (baseline) {
      // shared + 不同 ID 表示 U2 已下载、但本进程仍在跑 U1；它仍是下一次启动的基线。
      if (
        baseline.runtimeVersion === currentRuntimeVersion
        && (baseline.mode === 'shared' || baseline.updateId === currentUpdateId)
      ) return baseline;
      baseline = null;
    }

    const stored = parseBaseline(await deps.readBaseline());
    if (
      stored?.runtimeVersion === currentRuntimeVersion
      && (stored.mode === 'shared' || stored.updateId === currentUpdateId)
    ) {
      baseline = stored;
      return stored;
    }

    // 第一次运行 U1：此时原生正是按旧 header + 当前持久通道选中了它，先把该基线钉住。
    const initial: HeaderBaseline = {
      version: 1,
      mode: 'legacy',
      updateId: currentUpdateId,
      runtimeVersion: currentRuntimeVersion,
      updateUrl: options.updateUrl,
      channel: options.channel,
    };
    await persistBaseline(initial);
    return initial;
  }

  async function execute<T>(
    options: CoordinatorRunOptions,
    operation: (client: OtaRequestClient) => Promise<T>,
  ): Promise<{ result: Promise<T>; drained: Promise<void> }> {
    const currentUpdateId = options.currentUpdateId?.toLowerCase() ?? null;
    const currentRuntimeVersion = options.currentRuntimeVersion?.trim() ?? '';
    if (!currentRuntimeVersion) throw new Error('ota-request-runtime-version-unavailable');
    const startingBaseline = await resolveBaseline(options);
    const targetConfig = requestConfig(options.updateUrl, 'shared', options.channel);
    const pendingNativeRequests: Promise<unknown>[] = [];
    let appliedConfig: UpdateRequestConfig | null = null;

    function trackNativeRequest<T>(promise: Promise<T>): Promise<T> {
      pendingNativeRequests.push(promise);
      return promise;
    }

    function restoreBaseline(): void {
      // baseline 可能已由成功 fetch 原子推进到 U2；否则恢复进入事务前的 U1 配置。
      const finalBaseline = baseline ?? startingBaseline;
      const config = requestConfig(
        finalBaseline.updateUrl,
        finalBaseline.mode,
        finalBaseline.channel,
      );
      if (appliedConfig && sameRequestConfig(appliedConfig, config)) return;
      deps.setConfigOverride(config);
      appliedConfig = config;
    }

    const coordinatedClient: OtaRequestClient = {
      checkForUpdateAsync: async () => {
        // 原生请求不会被 JS timer 取消。raw promise 由事务单独追踪：调用方可按预算
        // fail-open，但串行队列要等它真正结束，避免晚到结果与下一事务交错。
        const result = await withRequestTimeout(
          trackNativeRequest(deps.client.checkForUpdateAsync()),
          options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        );
        const targetUpdateId = manifestUpdateId(result.manifest);
        // 同一 update ID 无法靠重下改写数据库中的 requestHeaders；直接按无更新收口，
        // 避免 U1 在共享 header 下把自己误判成可迁移的 U2。
        if (
          result.isAvailable
          && targetUpdateId
          && (targetUpdateId === currentUpdateId || targetUpdateId === baseline?.updateId)
        ) {
          return unavailableResult(result);
        }
        return result;
      },
      fetchUpdateAsync: async () => {
        // marker 更新属于原生 fetch 的完成处理，也必须被 drain 追踪。即使外层先超时，
        // 晚到的成功下载仍会在队列锁内提交 shared 基线，不会留下永远无法启动的 U2。
        const nativeFetch = deps.client.fetchUpdateAsync().then(async (result) => {
          if (!result.isNew) return result;
          const targetUpdateId = manifestUpdateId(result.manifest);
          if (!targetUpdateId) throw new Error('ota-request-fetched-update-id-unavailable');
          if (targetUpdateId === currentUpdateId || targetUpdateId === baseline?.updateId) {
            return notNewResult(result);
          }

          // fetch 已完成后、reload 或进程退出前先提交新基线；写失败会让 baseline 保持
          // 原值，事务恢复旧配置，因此不会主动留下没有迁移标记的 shared override。
          await persistBaseline({
            version: 1,
            mode: 'shared',
            updateId: targetUpdateId,
            runtimeVersion: currentRuntimeVersion,
            updateUrl: options.updateUrl,
            channel: options.channel,
          });
          return result;
        });
        return withRequestTimeout(
          trackNativeRequest(nativeFetch),
          options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        );
      },
      reloadAsync: deps.client.reloadAsync,
    };

    try {
      deps.setConfigOverride(targetConfig);
      appliedConfig = targetConfig;
    } catch (error) {
      // 原生实现会先持久化 override 再重建内存配置；即使后一步抛错，也尽力恢复
      // 已知可启动基线，不能假设一次失败的调用完全没有副作用。
      restoreBaseline();
      throw error;
    }
    const result = Promise.resolve()
      .then(() => operation(coordinatedClient))
      // 逻辑预算到期时先恢复可启动基线并把结果交给 UI；底层原生请求继续由 drained
      // 持锁收尾。这样启动页不会被慢下载卡住，持久 override 也不会长时间停在 shared。
      .finally(restoreBaseline);
    const drained = result
      .then(() => undefined, () => undefined)
      .then(async () => {
        await Promise.allSettled(pendingNativeRequests);
        // 晚到 fetch 可能刚把 baseline 推进为 shared；在释放队列前同步最终配置。
        restoreBaseline();
      });
    return { result, drained };
  }

  return {
    run<T>(
      options: CoordinatorRunOptions,
      operation: (client: OtaRequestClient) => Promise<T>,
    ): Promise<T> {
      const transaction = queue.then(() => execute(options, operation));
      const result = transaction.then((started) => started.result);
      queue = transaction
        .then((started) => started.drained)
        .then(() => undefined, () => undefined);
      return result;
    },
  };
}

const nativeCoordinator = createOtaRequestCoordinator({
  readBaseline: () => AsyncStorage.getItem(STORAGE_KEY),
  writeBaseline: (raw) => AsyncStorage.setItem(STORAGE_KEY, raw),
  setConfigOverride: (config) => Updates.setUpdateURLAndRequestHeadersOverride(config),
  client: {
    checkForUpdateAsync: () => Updates.checkForUpdateAsync(),
    fetchUpdateAsync: () => Updates.fetchUpdateAsync(),
    reloadAsync: () => Updates.reloadAsync(),
  },
});

/** 自建 OTA 的唯一网络入口；启动、回前台、手动检查必须全部走这里。 */
export function runSelfHostedOtaRequest<T>(
  channel: UpdateChannel,
  operation: (client: OtaRequestClient) => Promise<T>,
  {
    checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  }: OtaRequestTimeouts = {},
): Promise<T> {
  if (!OTA_SERVER_BASE_URL) {
    return Promise.reject(new Error('endpoint manifest missing mobileUpdateBaseUrl'));
  }
  return nativeCoordinator.run({
    updateUrl: `${OTA_SERVER_BASE_URL}/manifest`,
    channel,
    // emergency launch 使用 NoDatabaseLauncher，expo-updates 不暴露 launched update ID。
    // 合成值只用于暂存 legacy 基线；成功 fetch 后会立刻被真实的 U2 manifest ID 替换。
    currentUpdateId: Updates.updateId
      ?? (Updates.isEmergencyLaunch ? EMERGENCY_BASELINE_UPDATE_ID : null),
    currentRuntimeVersion: Updates.runtimeVersion,
    checkTimeoutMs,
    fetchTimeoutMs,
  }, operation);
}

export const __testing = {
  storageKey: STORAGE_KEY,
};
