/**
 * main 进程统一的服务端 API 客户端。
 *
 * - 复用 `authManager.getAccessToken()` 自动注入 Bearer Authorization
 * - 可恢复的 401 自动 refresh 一次再重试
 * - `ACCOUNT_UNAVAILABLE` 或刷新后仍被 401 拒绝时执行完整本地退登
 * - `baseUrl` **必传**:老主 server(apiBaseUrl)2026-07-18 退役后没有"默认
 *   业务 server"了,每个调用方显式指向自己的独立服务(device-link relay /
 *   model-access / oauth-broker / github-server / skillhub-server ...)。
 */

import { net } from 'electron';
import * as authManager from './authManager.js';
import { getResolvedMainLocale } from './i18n.desktop.js';
import { createLogger } from './logger.js';
import { createServerApiClient } from './serverApiClient.js';

export { ServerApiError } from './serverApiClient.js';
export type { ApiFetchOptions } from './serverApiClient.js';

export const serverApiFetch = createServerApiClient({
  fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
  auth: authManager,
  locale: () => getResolvedMainLocale(),
  log: createLogger('serverApiClient'),
});
