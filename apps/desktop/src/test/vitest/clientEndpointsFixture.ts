/**
 * 单测用的端点清单 fixture(2026-07 端点清单重构后,shared/endpoints.ts 的
 * 烘焙端点常量全部退役,测试不再从那里拿"真值"当 fixture)。
 *
 * 用法:
 *  - 只需要一个 URL 当输入/预期:直接引 TEST_* 常量;
 *  - 被测代码内部会调 getClientEndpoint():beforeEach 里
 *    `resetClientEndpointsForTest(TEST_CLIENT_ENDPOINTS)` 注入整份清单
 *    (init 前调用 getClientEndpoint 会抛错——这是刻意的启动时序守卫)。
 *
 * 值全部是 .invalid 保留域名(RFC 2606),不会撞 check-endpoint-literals 的
 * 生产域名门禁,也不可能被真实网络解析。
 */
import type { ClientEndpointMap } from '@cindy/maker-shared/client-endpoints';

/**
 * XD 网关测试值:清单已不承载网关端点(2026-07-17 退役 xdGatewayBaseUrl),
 * 运行期一律来自 model-access server 下发(effectiveXdGatewayBaseUrl)。测试里
 * 需要网关 URL 时,mock `model-access/effectiveEndpoint.js` 返回本常量。
 */
export const TEST_XD_GATEWAY_BASE_URL = 'https://gateway.test.invalid';
export const TEST_CDN_BASE_URL = 'https://cdn.test.invalid/app';

export const TEST_CLIENT_ENDPOINTS: ClientEndpointMap = {
  authApiBaseUrl: 'https://auth.test.invalid',
  deviceLinkApiBaseUrl: 'https://device.test.invalid',
  oauthBrokerApiBaseUrl: 'https://oauth.test.invalid',
  ossApiBaseUrl: 'https://oss.test.invalid',
  heartbeatUrl: 'https://heartbeat.test.invalid',
  telegramHookWsUrl: 'wss://telegram-hook.test.invalid',
  slackHookWsUrl: 'wss://slack-hook.test.invalid',
  websiteUrl: 'https://website.test.invalid',
  modelAccessApiBaseUrl: 'https://model-access.test.invalid',
  voiceApiBaseUrl: 'https://voice.test.invalid',
  moderationSignApiBaseUrl: 'https://moderation-sign.test.invalid',
  moderationSignTestApiBaseUrl: 'https://moderation-sign-dev.test.invalid',
  githubApiBaseUrl: 'https://github-api.test.invalid',
  skillhubApiBaseUrl: 'https://skillhub.test.invalid',
  cdnBaseUrl: TEST_CDN_BASE_URL,
  mobileUpdateBaseUrl: 'https://mobile-update.test.invalid',
};
