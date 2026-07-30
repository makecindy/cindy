/**
 * main/im/host.ts
 * ---------------------------------------------------------------------------
 * Compose the IM facade for this electron app: build the IMHost adapter
 * (secrets / ipc / paths) and instantiate one FeishuIM. Other channels would
 * be added to the `createIM([...])` array.
 *
 * @cindy/im is electron-free; this file is the *only* place that translates
 * between Electron APIs (safeStorage / ipcMain / BrowserWindow / app.getPath)
 * and the IMHost contract.
 */

import path from 'node:path';
import { app, ipcMain, BrowserWindow, net, shell } from 'electron';

import { createIM, createDiscordIM, createFeishuIM, type IMHost } from '@cindy/im';
import { TencentIlinkTransport } from '@cindy/wechat-ilink';

import { createLogger } from '../logger';
import { resolveSafe as resolveXdtImageUrl } from '../imageCacheStore';
import { resolveSafe as resolveCindyMediaUrl } from '../cindy-media/blobStore';
import {
  integrationCacheGet,
  integrationCacheKey,
  integrationCachePut,
} from '../cindy-media/integrationCache';
import { pinBlob } from '../cindy-media/ledger';
import { t } from '../i18n';
import { discordUiText } from './discord/uiText';
import { imHostAccountScope } from './accountScopeBridge';
import { ownerScopedImSecrets } from './ownerScopedStorage';
import { captureImAccountGeneration, isImAccountGenerationCurrent } from './accountBoundary';
import { getDbClient } from '../localDb/client/current';
import { WechatIM, WECHAT_AUTH_BASE_URL } from './wechat/WechatIM';
import {
  WECHAT_COMPATIBILITY_POLICY_PRODUCTION_CONFIG,
  WechatCompatibilityPolicyService,
} from './wechat/compatibilityPolicy';

const log = createLogger('im/host');

/** IM 托管媒体 URL → 绝对路径:媒体总仓 cindy-media 与历史 xdt-image 双协议。 */
function resolveManagedImageAbsPath(url: string): string {
  return url.startsWith('cindy-media://')
    ? resolveCindyMediaUrl(url).absPath
    : resolveXdtImageUrl(url).absPath;
}

const host: IMHost = {
  accountScope: imHostAccountScope,
  paths: {
    feishuMediaDir: path.join(app.getPath('userData'), 'cc-agent', 'feishu-media'),
    discordMediaDir: path.join(app.getPath('userData'), 'cc-agent', 'discord-media'),
  },
  // cindy-media 媒体总仓回调(规则 25):IM 入站图片按平台 token
  // 免重下、内容寻址去重、isCache=true 吃缓存回收策略;包侧只摸字节和字符串。
  media: {
    cacheImage: async ({ integration, token, buffer, mimeType }) => {
      const hit = await integrationCachePut({
        cacheKey: integrationCacheKey(integration, token),
        integration,
        buffer,
        mimeType,
        // IM 入站图是**用户附件**不是可再生缓存(review P1):discord CDN 地址
        // 限时签名,被缓存 LRU 逐出后无法重下 = 弄丢用户的图。isCache=false +
        // 落库挂 session-attachment 引用,与桌面粘贴附件同生命周期。
        isCache: false,
      });
      return { absPath: hit.absPath, url: hit.url };
    },
    getCachedImage: async (integration, token) => {
      const hit = await integrationCacheGet(integrationCacheKey(integration, token));
      if (!hit) return null;
      // 命中路径不走 cacheImage,但 IM 复用的可能是 MCP 侧 isCache=true 的缓存
      // blob(feishu 两边有意共用 `feishu:<token>` 命名空间)——IM 语义是用户
      // 附件,同 cacheImage 口径降级为非 cache(review P1);降级失败只警告,
      // 不阻断附件复用(消息落库挂账钩子的 pinBlob 是第二道自愈)。
      try {
        await pinBlob(hit.hash);
      } catch (err) {
        log.warn('im getCachedImage: pinBlob failed', {
          integration,
          hash: hit.hash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { absPath: hit.absPath, url: hit.url, mimeType: hit.mimeType };
    },
    resolveMediaUrl: (url) => {
      try {
        return url.startsWith('cindy-media://') ? resolveCindyMediaUrl(url).absPath : null;
      } catch {
        return null;
      }
    },
  },
  secrets: ownerScopedImSecrets,
  ipc: {
    handle(channel, handler) {
      ipcMain.handle(channel, (_e, payload) => handler(payload));
    },
    broadcast(channel, payload) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload);
      }
    },
  },
  async httpPostForm(url, form) {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: { error: text || `HTTP ${res.status}` } };
    }
  },
  createLogger,
};

export const feishuIm = createFeishuIM(host);
export const discordIm = createDiscordIM(host, {
  resolveImageUrl: resolveManagedImageAbsPath,
  expiredCardNotice: discordUiText.expiredCardNotice,
  ownerNoticeText: (phase) => t(`settings.discordBot.ownerNotice.${phase}`),
});
export const wechatCompatibilityPolicy = new WechatCompatibilityPolicyService({
  ...WECHAT_COMPATIBILITY_POLICY_PRODUCTION_CONFIG,
  cachePath: () =>
    path.join(
      app.getPath('userData'),
      'controlled-config',
      'wechat-compatibility-policy.v1.json',
    ),
  appVersion: () => app.getVersion(),
  fetch: (input, init) => net.fetch(input, init),
});
export const wechatIm = new WechatIM({
  host,
  getDbClient,
  createTransport: ({ credentials, onAuthorizationEvent }) =>
    new TencentIlinkTransport({
      baseUrl: credentials?.baseUrl ?? WECHAT_AUTH_BASE_URL,
      ...(credentials
        ? {
            token: credentials.botToken,
            appId: credentials.ilinkBotId,
          }
        : {}),
      botAgent: `Cindy/${app.getVersion()}`,
      fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
      ...(onAuthorizationEvent
        ? {
            authorizationObserver: {
              onEvent: onAuthorizationEvent,
            },
          }
        : {}),
    }),
  openAuthorizationUrl: (url) => shell.openExternal(url),
  captureAccountGeneration: captureImAccountGeneration,
  isAccountGenerationCurrent: isImAccountGenerationCurrent,
  isCompatibilityDisabled: () => wechatCompatibilityPolicy.isDisabled(),
});
wechatCompatibilityPolicy.subscribe((decision) => {
  void wechatIm.setCompatibilityDisabled(decision.disabled).catch(() => {
    log.warn('failed to apply personal WeChat compatibility policy');
  });
});
export const im = createIM([feishuIm, discordIm, wechatIm]);
