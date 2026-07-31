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

import {
  createIM,
  createDiscordIM,
  createDingTalkIM,
  createFeishuIM,
  createTelegramIM,
  type IMHost,
} from '@cindy/im';
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
import { telegramUiText } from './telegram/uiText';
import {
  patchTelegramBehavior,
  patchTelegramPersona,
  readTelegramBehavior,
  readTelegramPersona,
  setTelegramGroupActivation,
} from './telegram/behaviorStore';
import { listTelegramKnownGroups } from './telegram/groupWindow';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { imHostAccountScope } from './accountScopeBridge';
import { ownerScopedImSecrets } from './ownerScopedStorage';
import { captureImAccountGeneration, isImAccountGenerationCurrent } from './accountBoundary';
import { getDbClient } from '../localDb/client/current';
import { WechatIM, WECHAT_AUTH_BASE_URL } from './wechat/WechatIM';
import {
  WECHAT_COMPATIBILITY_POLICY_PRODUCTION_CONFIG,
  WechatCompatibilityPolicyService,
} from './wechat/compatibilityPolicy';
import { fetchPublicImageBytes } from './publicImageFetch';

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
    telegramMediaDir: path.join(app.getPath('userData'), 'cc-agent', 'telegram-media'),
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
    fetchRemoteImage: (url, maxBytes) => fetchPublicImageBytes(url, maxBytes),
  },
  secrets: ownerScopedImSecrets,
  ipc: {
    handle(channel, handler) {
      // IM 凭证/配置通道(set-config/get-status/disconnect 等)全部是敏感面:
      // 统一在适配器入口验可信 app renderer, 包侧 handler 拿不到 event 也
      // 不会漏鉴权(review P1 — 不受信 WebContents 不得读 owner id/换 token)。
      ipcMain.handle(channel, (e, payload) => {
        assertTrustedAppRendererEvent(e);
        return handler(payload);
      });
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
export const telegramIm = createTelegramIM(host, {
  resolveImageUrl: resolveManagedImageAbsPath,
  expiredCardNotice: telegramUiText.expiredCardNotice,
  ownerNoticeText: (phase) => t(`settings.telegramBot.ownerNotice.${phase}`),
  // 行为配置 getter: transport 每次使用时现读 → 设置卡改动即生效。
  behavior: readTelegramBehavior,
  // owner 私聊的 "/" 命令菜单(BotCommandScopeChat 只发 owner, 其他人不可见)。
  commandMenu: ['start', 'new', 'help', 'stop', 'session', 'project', 'model', 'permission', 'ctr', 'exctr'].map(
    (command) => ({
      command,
      description: t(`settings.telegramBot.commandMenu.${command}`),
    }),
  ),
});
export const dingtalkIm = createDingTalkIM(host, {
  fetcher: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
});
/**
 * Telegram 个人 bot 的行为/人格/群参与配置 IPC(设置卡数据通道)。
 * 必须由 bootstrap 显式调用(与 im.registerIpc() 同期) — 不能放模块顶层:
 * host.ts 被 mock 掉 electron 的单测传递 import 时, 顶层 ipcMain.handle
 * 会在收集期炸掉(2026-07-30 全量门禁 device-link TEST_COLLECT_FAILED 教训)。
 * payload 在 store 内白名单校验, 未知字段/非法值一律丢弃。
 */
export function registerTelegramBotConfigIpc(): void {
  // 每个 handler 先验事件来自可信 app renderer(与 bootstrap 内敏感通道同口径):
  // 共享的 host.ipc.handle 适配器会丢弃 event, 所以这组通道直接走 ipcMain。
  ipcMain.handle('telegramBot:get-behavior', (e) => {
    assertTrustedAppRendererEvent(e);
    return readTelegramBehavior();
  });
  ipcMain.handle('telegramBot:set-behavior', (e, patch) => {
    assertTrustedAppRendererEvent(e);
    return patchTelegramBehavior((patch ?? {}) as Parameters<typeof patchTelegramBehavior>[0]);
  });
  // 群聊节: 已知群列表(窗口表 distinct chat)+ per-chat 参与模式读写。
  ipcMain.handle('telegramBot:list-groups', async (e) => {
    assertTrustedAppRendererEvent(e);
    const groups = await listTelegramKnownGroups(telegramIm.botContextId);
    const activation = readTelegramBehavior().groupActivation ?? {};
    return {
      groups: groups.map((g) => ({
        chatId: g.chatId,
        chatName: g.chatName,
        activation: activation[g.chatId] ?? 'mention',
      })),
    };
  });
  ipcMain.handle('telegramBot:set-group-activation', (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const p = (payload ?? {}) as { chatId?: string; mode?: string };
    const chatId = typeof p.chatId === 'string' && /^-?\d+$/.test(p.chatId) ? p.chatId : null;
    const mode = p.mode === 'always' ? 'always' : 'mention';
    if (!chatId) return readTelegramBehavior();
    return setTelegramGroupActivation(chatId, mode);
  });
  // 人格配置(soul + 名字); 保存后可选把名字同步到 Telegram 资料页(setMyName)。
  ipcMain.handle('telegramBot:get-persona', (e) => {
    assertTrustedAppRendererEvent(e);
    return readTelegramPersona();
  });
  ipcMain.handle('telegramBot:set-persona', async (e, payload) => {
    assertTrustedAppRendererEvent(e);
    const p = (payload ?? {}) as { botName?: string; soul?: string; syncProfile?: boolean };
    const persona = patchTelegramPersona({
      ...(typeof p.botName === 'string' ? { botName: p.botName } : {}),
      ...(typeof p.soul === 'string' ? { soul: p.soul } : {}),
    });
    let profileSynced: boolean | undefined;
    if (p.syncProfile === true) {
      profileSynced = await telegramIm.syncBotProfileName(persona.botName);
    }
    return { persona, ...(profileSynced !== undefined ? { profileSynced } : {}) };
  });
}

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
export const im = createIM([feishuIm, discordIm, wechatIm, telegramIm, dingtalkIm]);
