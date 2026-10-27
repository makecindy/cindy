import { createHash } from 'node:crypto';
import { isProviderDisabled } from '@cindy/model-providers';

import type { ModelAccessCredentialSource } from '../../shared/modelAccess.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { getModelAccessCredentialsStore } from './credentialsStore.js';

/**
 * gatewayKeyRejection.ts — Cindy AI Key 被网关拒绝(HTTP 401)后的统一上报入口。
 * ---------------------------------------------------------------------------
 * 服务端换发或撤销 Key 后,本机旧 Key 会被网关 401;服务端在客户端调用
 * `GET /api/model-access/credentials` 时会探测当前 Key,失效即签发新 Key。主进程各
 * 调用方(辅助模型、搜索、媒体、向量、额度、语音、智能体终态)在 401 时把**本次请求
 * 实际携带的 Key** 交给这里,由这里决定是否触发一次凭据同步。
 *
 * 规则只有两条,不加退避或定时检查:
 *  - 规则 A:上报的 Key 必须等于本机当前保存的 Key——旧请求的迟到 401 不能为已换上的
 *    新 Key 再触发同步;
 *  - 规则 B:同一把 Key 在 `CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS`(5 分钟)内最多触发
 *    一次——内存只记上一次触发的 Key 的 SHA-256 指纹(不存明文)和触发时间,换了 Key 立即
 *    可再触发。
 * 为什么按时间窗口而不是「每把 Key 永远只触发一次」:`sync()` 在服务端暂时不可用时会在内部
 * 重试后以 failed 状态结束(不 reject),服务端也可能在网关鉴权缓存窗口内原样返回这把稍后
 * 才被撤销的 Key。永久标记会让这把 Key 之后的 401 一律被忽略,直到重启;窗口过后再允许
 * 触发一次即可自行恢复。窗口内不重复,则不会对着挂掉的服务端或误报的 401 反复请求。
 * 同步用 `credentialsSync.resyncAfterKeyRejection()`:与 `sync()` 一样尊重 unsupported /
 * disabled 终态、复用同世代在途同步、带内部重试;但不广播 syncing,失败不降级状态、不清空
 * 模型列表(401 可能误报、凭据接口可能暂时不可用,降级会停掉 Cindy AI 且不再有请求触发
 * 窗口后的重试)。这里不新增提示。
 *
 * 工厂函数的依赖全部注入,便于单测。进程内单例的默认依赖在本文件组装,只有凭据同步
 * (`requestSync`)由 model-access/index.ts 在 initModelAccess 时经
 * `installCindyGatewayKeyRejectionReporter` 提供。调用方从本文件导入上报入口,不直接依赖
 * index.ts——后者会拉入 maker-host 等整张主进程依赖图,不适合被底层网络模块反向导入;
 * 本文件的默认依赖也都不会反向导入 index.ts。
 */

export interface GatewayKeyRejectionDeps {
  /** 当前会话是否允许使用 Cindy 网关(getAppCapabilities().canUseCindyGateway)。 */
  canUseCindyGateway(): boolean;
  /** 是否正处于账号切换边界(isAppSessionBoundaryPending)。 */
  isSessionBoundaryPending(): boolean;
  /** 本机 Key 的来源标记;只处理服务端下发('server')的 Key。 */
  getCredentialSource(): ModelAccessCredentialSource | null;
  /** 本机当前保存的 Cindy AI Key(providerSecretStore 'xd')。 */
  readCurrentKey(): string | null;
  /** 触发一次凭据同步(credentialsSync.resyncAfterKeyRejection())。 */
  requestSync(): Promise<unknown>;
  log?: {
    info(message: string): void;
    warn(message: string): void;
  };
  /** 当前时间(毫秒),默认 Date.now;测试注入假时钟。 */
  now?(): number;
}

/** 同一把 Key 两次触发同步之间的最短间隔。 */
export const CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS = 5 * 60_000;

/**
 * 上报器,两个入口:
 *  - `reportUsedKey`:调用方知道请求实际携带的 Key(规则 A + 规则 B,触发即记入
 *    `lastTriggered`);
 *  - `reportCurrentKey`:调用方不知道用的是哪把 Key(智能体回合终态)。当前 Key 在窗口内
 *    已被准确上报触发过,或已被本入口触发过,都跳过;本入口只记自己的
 *    `lastCurrentKeyTriggered`,**不写**准确上报的记录——否则旧 Key 进程(未重启的 Codex、
 *    老任务)的迟到 401 会占用新 Key 的触发机会,新 Key 真失效时准确上报反被忽略。单独记录
 *    则保证卡在旧 Key 上的任务对同一把当前 Key 每个窗口只多触发 1 次。
 */
export interface GatewayKeyRejectionReporter {
  reportUsedKey(usedKey: string | null | undefined): void;
  reportCurrentKey(): void;
}

function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface TriggerRecord {
  fingerprint: string;
  at: number;
}

/** 组装一个上报器;内存里只保留上一次已触发 Key 的指纹与触发时间。 */
export function createGatewayKeyRejectionReporter(
  deps: GatewayKeyRejectionDeps,
): GatewayKeyRejectionReporter {
  const now = deps.now ?? Date.now;
  let lastTriggered: TriggerRecord | null = null;
  /** 只供 reportCurrentKey 读写;reportUsedKey 既不读也不写它。 */
  let lastCurrentKeyTriggered: TriggerRecord | null = null;

  /** 同一指纹且仍在窗口内(时钟回拨视为窗口已过,避免长时间卡住)。 */
  const triggeredRecently = (
    record: TriggerRecord | null,
    fingerprint: string,
    at: number,
  ): boolean => {
    if (!record || record.fingerprint !== fingerprint) return false;
    const elapsed = at - record.at;
    return elapsed >= 0 && elapsed < CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS;
  };

  const warn = (prefix: string, error: unknown): void => {
    deps.log?.warn(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  };

  /** 共同的跳过条件;通过时返回本机当前 Key。 */
  const currentServerKey = (): string | null => {
    if (!deps.canUseCindyGateway()) return null;
    if (deps.isSessionBoundaryPending()) return null;
    if (deps.getCredentialSource() !== 'server') return null;
    return deps.readCurrentKey() || null;
  };

  const triggerSync = (): void => {
    deps.log?.info('Cindy AI key rejected by gateway, re-syncing credentials');
    void deps.requestSync().catch((error: unknown) => {
      warn('Cindy AI credentials re-sync after key rejection failed', error);
    });
  };

  // 上报发生在各调用方的错误处理路径里,任何异常都不能改变调用方原有的失败语义。
  const guarded = (run: () => void): void => {
    try {
      run();
    } catch (error) {
      warn('Cindy AI key rejection report failed', error);
    }
  };

  return {
    reportUsedKey: (usedKey) => guarded(() => {
      if (!usedKey) return;
      const currentKey = currentServerKey();
      // 规则 A:只认本机当前这把 Key 的拒绝。
      if (!currentKey || currentKey !== usedKey) return;
      // 规则 B:同一把 Key 在窗口内最多触发一次。
      const fingerprint = keyFingerprint(usedKey);
      const at = now();
      if (triggeredRecently(lastTriggered, fingerprint, at)) return;
      lastTriggered = { fingerprint, at };
      triggerSync();
    }),
    reportCurrentKey: () => guarded(() => {
      const currentKey = currentServerKey();
      if (!currentKey) return;
      // 当前 Key 在窗口内已被准确上报或本入口同步过:不再重复请求。旧 Key 进程在当前 Key
      // 有效时会每轮失败,服务端每次都原样返回当前 Key,不单独记录就会每条消息都请求一次。
      const fingerprint = keyFingerprint(currentKey);
      const at = now();
      if (triggeredRecently(lastTriggered, fingerprint, at)) return;
      if (triggeredRecently(lastCurrentKeyTriggered, fingerprint, at)) return;
      lastCurrentKeyTriggered = { fingerprint, at };
      triggerSync();
    }),
  };
}

let installedReporter: GatewayKeyRejectionReporter | null = null;

/**
 * model-access/index.ts 初始化时安装进程内单例,只需提供凭据同步;其余依赖用本机默认实现。
 * 传 null 卸载(仅测试复位用)。
 */
export function installCindyGatewayKeyRejectionReporter(
  requestSync: (() => Promise<unknown>) | null,
): void {
  if (!requestSync) {
    installedReporter = null;
    return;
  }
  const log = createLogger('modelAccess');
  installedReporter = createGatewayKeyRejectionReporter({
    canUseCindyGateway: () => getAppCapabilities().canUseCindyGateway
      && !isProviderDisabled(readModelDisableOverrides(), 'xd'),
    isSessionBoundaryPending: isAppSessionBoundaryPending,
    getCredentialSource: () => getModelAccessCredentialsStore().getSource(),
    readCurrentKey: () => getProviderSecretStore().get('xd'),
    requestSync,
    log: {
      info: (msg) => log.info(msg),
      warn: (msg) => log.warn(msg),
    },
  });
}

/**
 * 上报一次 Cindy 网关 401。只在三条同时成立时调用:请求发往 Cindy 网关、带的是
 * Cindy AI Key、响应 401。`usedKey` 传本次请求实际携带的 Key。model-access 尚未
 * 初始化时(无凭据同步可触发)直接忽略。
 */
export function reportCindyGatewayKeyRejected(usedKey: string | null | undefined): void {
  installedReporter?.reportUsedKey(usedKey);
}

/**
 * 不知道请求实际用哪把 Key 时的上报(智能体回合因 Key 失效终止)。按本机当前 Key 判断,
 * 当前 Key 在窗口内已被任一入口触发过则跳过;触发同步但不占用准确上报的触发机会。
 */
export function reportCindyGatewayKeyRejectedForCurrentKey(): void {
  installedReporter?.reportCurrentKey();
}

/** 从请求头里取 `Authorization: Bearer <key>` 的 key;没有或格式不对返回 null。 */
export function bearerKeyFromHeaders(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  let value: string | null | undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    value = headers.get('authorization');
  } else if (Array.isArray(headers)) {
    value = headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  } else {
    const record = headers as Record<string, string | undefined>;
    const name = Object.keys(record).find((key) => key.toLowerCase() === 'authorization');
    value = name ? record[name] : undefined;
  }
  const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return match ? match[1].trim() || null : null;
}

/**
 * 给注入式 fetch 包一层:响应 401 时,用本次请求 Authorization 头里的 Bearer key 上报。
 * 只观察状态码,不读响应体、不改请求和响应;key 是否为 Cindy AI Key 由上报器按规则 A 判定。
 */
export function withCindyGatewayKeyRejectionReport(
  fetchImpl: typeof fetch,
  report: (usedKey: string | null) => void = reportCindyGatewayKeyRejected,
): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401) {
      const usedKey =
        bearerKeyFromHeaders(init?.headers)
        ?? (typeof Request !== 'undefined' && input instanceof Request
          ? bearerKeyFromHeaders(input.headers)
          : null);
      report(usedKey);
    }
    return response;
  };
  return wrapped as typeof fetch;
}
