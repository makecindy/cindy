import { i18n } from '@/i18n';
import type { OutboxStorage } from './durableOutbox';

// 安卓 AsyncStorage 是带 6 MiB 上限的 SQLite 库:写满时报 SQLITE_FULL,与整机剩余空间无关。
const FULL_PATTERN = /SQLITE_FULL|database or disk is full/i;

export function isAsyncStorageFullError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return FULL_PATTERN.test(message);
}

/**
 * 写满时先把旧消息缓存迁出 AsyncStorage 腾出空间,再重试一次;仍然写不进就换成人话报错,
 * 让用户知道是手机本地存储满了,而不是电脑或整机磁盘。
 */
export function withAsyncStorageFullRecovery(
  storage: OutboxStorage,
  reclaim: () => Promise<void>,
): OutboxStorage {
  return {
    getAllKeys: () => storage.getAllKeys(),
    getItem: (key) => storage.getItem(key),
    removeItem: (key) => storage.removeItem(key),
    async setItem(key, value) {
      try {
        await storage.setItem(key, value);
        return;
      } catch (error) {
        if (!isAsyncStorageFullError(error)) throw error;
        await reclaim().catch(() => undefined);
      }
      try {
        await storage.setItem(key, value);
      } catch (error) {
        if (!isAsyncStorageFullError(error)) throw error;
        throw new Error(i18n.t('session.screen.localStorageFull'), { cause: error });
      }
    },
  };
}
