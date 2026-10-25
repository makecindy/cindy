import {
  createGatewayKeyRejectionReporter,
  type GatewayKeyRejectionReporter,
} from '@cindy/model-providers/model-access/gatewayKeyRejection';
export {
  createGatewayKeyRejectionReporter,
  CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS,
} from '@cindy/model-providers/model-access/gatewayKeyRejection';
export type {
  GatewayKeyRejectionDeps,
  GatewayKeyRejectionReporter,
} from '@cindy/model-providers/model-access/gatewayKeyRejection';

import { getAppCapabilities } from '../appCapabilities.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
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
    canUseCindyGateway: () => getAppCapabilities().canUseCindyGateway,
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

export {bearerKeyFromHeaders} from '@cindy/model-providers/model-access/gatewayKeyRejectionFetch';
import {withCindyGatewayKeyRejectionReport as withReport} from '@cindy/model-providers/model-access/gatewayKeyRejectionFetch';
export function withCindyGatewayKeyRejectionReport(fetchImpl:typeof fetch,report:(usedKey:string|null)=>void=reportCindyGatewayKeyRejected):typeof fetch {return withReport(fetchImpl,report);}
