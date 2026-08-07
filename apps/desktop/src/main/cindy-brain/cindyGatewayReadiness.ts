/**
 * cindyGatewayReadiness.ts — cindy 槽向量 / 视频供应商的运行期就绪判据。
 *
 * XD 是这两个类目当前唯一的网关执行来源；账号能力与随凭据成对下发的
 * endpoint 必须同时存在，才能把 XD 型号投影进插件清单。
 */
import { getAppCapabilities } from '../appCapabilities.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';

export function isXdGatewayProviderReady(providerId: string): boolean {
  if (providerId !== 'xd') return true;
  return getAppCapabilities().canUseCindyGateway && effectiveXdGatewayBaseUrl().trim() !== '';
}
