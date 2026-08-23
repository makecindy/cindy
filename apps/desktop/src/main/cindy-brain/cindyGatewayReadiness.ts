/**
 * cindyGatewayReadiness.ts — cindy 槽向量 / 视频供应商的运行期就绪判据。
 *
 * XD 是向量与网关视频型号的执行来源；账号能力与随凭据成对下发的 endpoint
 * 必须同时存在，才能把 XD 型号投影进插件清单。订阅型视频来源由调用方按
 * 自己的 OAuth 就绪状态另行判断。
 */
import { getAppCapabilities } from '../appCapabilities.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';

export function isXdGatewayProviderReady(providerId: string): boolean {
  if (providerId !== 'xd') return true;
  return getAppCapabilities().canUseCindyGateway && effectiveXdGatewayBaseUrl().trim() !== '';
}
