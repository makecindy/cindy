/**
 * im/desktopConfirmNoticeWiring.ts — desktopConfirmNotice 的生产接线(#926)。
 *
 * 与纯逻辑分开放的原因:
 * - architecture-invariants §2 要求 main 进程依赖一律顶层静态 import,禁止运行时
 *   动态 import()(codex review P1)。host / binding 本来就在 main 的静态依赖图里
 *   (bootstrap-electron → im/index → host),这里静态引不引入新的加载时机。
 * - desktopConfirmNotice.ts 被单测直接引入,必须保持零 electron 依赖;
 *   host.ts 顶层 import electron,静态依赖只能落在这个不进单测图的接线文件里。
 */

import { eq } from 'drizzle-orm';

import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { bindingStore } from './binding.js';
import { feishuIm } from './host.js';
import {
  createDesktopConfirmNotifier,
  resolveFeishuNoticeTarget,
} from './desktopConfirmNotice.js';

const log = createLogger('im-desktop-confirm-notice');

/** 生产接线:接管绑定 / sessions 行反查 feishuOpenId + 复用 im/host 的 feishuIm 实例。 */
export function createFeishuDesktopConfirmNotifier(): (sessionId: string, what: string) => void {
  return createDesktopConfirmNotifier({
    async getFeishuOpenId(sessionId) {
      return resolveFeishuNoticeTarget(
        {
          findBinding: (id) => bindingStore.findByTarget(id),
          getSessionOpenId: async (id) => {
            const db = getDbClient().drizzle;
            const [row] = await db
              .select({ openId: sessions.feishuOpenId })
              .from(sessions)
              .where(eq(sessions.id, id))
              .limit(1);
            const openId = row?.openId?.trim();
            return openId ? openId : null;
          },
        },
        sessionId,
      );
    },
    async sendFeishuText(openId, markdown) {
      return feishuIm.sendMarkdownText(openId, markdown);
    },
    logWarn: (m) => log.warn(m),
  });
}
