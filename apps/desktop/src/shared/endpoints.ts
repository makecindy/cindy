/**
 * Desktop 端点适配层。
 *
 * 2026-07 端点清单重构后,运行期业务端点(api / auth / device-link / oauth broker /
 * heartbeat / slack hook / website / 网关 / 更新链 CDN)**全部**来自启动阻断式
 * 解析的端点清单(main 走 getClientEndpoint(),renderer 走
 * electronAPI.clientEndpoints)——本文件不再提供任何业务端点烘焙常量。
 *
 * 仅存的烘焙注入是本区与对端的两份清单自举基址(构建脚本分别读取
 * config/endpoint*.json 的 cdnBaseUrl);本文件只提供类型化出口,不保存任何
 * 生产地址。空值表示当前构建未配置,消费方(clientEndpointsService)会阻断暴露。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

function injectedEndpoint(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

/**
 * 当前构建区域端点清单(endpoint.json)的自举拉取基址。另一物理区域使用下方
 * PEER 基址；其余业务端点(含更新链 CDN base)全部来自清单解析结果。
 */
export const ENDPOINT_MANIFEST_BASE_URL = injectedEndpoint(
  import.meta.env.VITE_ENDPOINT_MANIFEST_BASE_URL,
);

/** 另一物理区域的端点清单基址；与本区基址共同构成受信任的双区地址表。 */
export const ENDPOINT_MANIFEST_PEER_BASE_URL = injectedEndpoint(
  import.meta.env.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL,
);

/**
 * TapDB 埋点上报端点,按构建区域二选一;第三方固定协议地址不属于生产端点私有配置。
 *
 * 与 TapDB 项目(appId)必须同区配对——global 构建报进国内采集端曾导致国际项目
 * 缺失全部客户端行为数据,进而让服务端充值事件因 user_id 无效不计入收入统计。
 * 配对关系的唯一消费点是 renderer/analytics/tapdbClient.ts 的 TAPDB_PROJECT_BY_REGION。
 *
 * dev 是内部构建身份,行为语义归 cn 系(region-and-editions.md §1.1),复用国内端点。
 * Record 按 CindyRegion 穷举:新增区域时编译期强制在此决定采集端归属。
 */
export const TAPDB_EVENT_URL_BY_REGION: Readonly<Record<CindyRegion, string>> = Object.freeze({
  cn: 'https://e.tapdb.com/event',
  global: 'https://e.tapdb.ap-sg.tapapis.com/event',
  dev: 'https://e.tapdb.com/event',
});
