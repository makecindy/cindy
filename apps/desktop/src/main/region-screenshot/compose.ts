import { ipcMain, type IpcMainInvokeEvent, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState';
import { getDbClient } from '../localDb/client/current';

import { ingestChatImageBuffer } from '../cindy-media/chatAttachments';
import { focusMainWindow, getDeepLinkMainWindow, sendMainWindowMessage } from '../deepLink';
import { createLogger } from '../logger';
import {
  REGION_SCREENSHOT_COMPOSE_CHANNEL,
  type RegionScreenshotAiAction,
  type RegionScreenshotComposeRequest,
} from '../../shared/regionScreenshot';

const log = createLogger('region-screenshot:compose');

/**
 * 截图交给新任务 (问 Cindy / 翻译 / 解释 / 提取文字)。
 *
 * main 只做两件事: 把图按粘贴图片同一条草稿入仓链路写入媒体仓 (blob + 账本行,
 * 不挂引用, 用户发送时随消息挂引用), 然后唤醒主窗口。草稿写入、提示词与是否
 * 自动发送都由主窗口 renderer 决定 (见 renderer/features/region-screenshot)。
 * 只保留最新一条待处理请求; 主窗口还没加载好时由它挂载后自己来取。
 */

let pending: RegionScreenshotComposeRequest | null = null;
let pendingExpiresAt = 0;
let pendingOwnerScope: string | null = null;
let requestGeneration = 0;
const REQUEST_TTL_MS = 30_000;

export async function handOffScreenshotToTask(
  image: NativeImage,
  action: RegionScreenshotAiAction,
  ownerScope = activeOwnerScopeKey(),
): Promise<void> {
  if (isAppSessionBoundaryPending() || ownerScope !== activeOwnerScopeKey()) return;
  const ownerStamp = getActiveDataOwnerPushStamp();
  const db = getDbClient().drizzle;
  const generation = ++requestGeneration;
  const expiresAt = Date.now() + REQUEST_TTL_MS;
  pending = null;
  const png = image.toPNG();
  const { url, filename } = await ingestChatImageBuffer({ buffer: png, mimeType: 'image/png' }, db);
  if (generation !== requestGeneration || Date.now() >= expiresAt
    || isAppSessionBoundaryPending() || ownerScope !== activeOwnerScopeKey()) return;
  const size = image.getSize();
  pending = {
    id: randomUUID(),
    ownerStamp,
    action,
    url,
    filename,
    bytes: png.byteLength,
    width: size.width,
    height: size.height,
  };
  pendingExpiresAt = expiresAt;
  pendingOwnerScope = ownerScope;
  log.info('screenshot handed to task', { action });
  focusMainWindow();
  sendMainWindowMessage(REGION_SCREENSHOT_COMPOSE_CHANNEL.WAKE, null);
}

function isMainWindowEvent(event: IpcMainInvokeEvent): boolean {
  const main = getDeepLinkMainWindow();
  return (
    !!main &&
    !main.isDestroyed() &&
    event.sender === main.webContents &&
    !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame
  );
}

export function registerScreenshotComposeIpc(): void {
  ipcMain.handle(REGION_SCREENSHOT_COMPOSE_CHANNEL.TAKE, (event) => {
    if (!isMainWindowEvent(event)) return null;
    const request = Date.now() < pendingExpiresAt && !isAppSessionBoundaryPending()
      && pendingOwnerScope === activeOwnerScopeKey() ? pending : null;
    pending = null;
    return request;
  });
}
