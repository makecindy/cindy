// The account ledger-currency store lives in accountCurrencyStoreCore.ts (shared with the Node
// Host). This module builds the single Desktop instance; its port resolves Electron when called,
// never when this module loads.
import { app } from 'electron';

import { createAccountCurrencyStore } from './accountCurrencyStoreCore.js';

const desktopAccountCurrencyStore = createAccountCurrencyStore({
  app: { getPath: (name) => app.getPath(name) },
});
type Instance = typeof desktopAccountCurrencyStore;

export function rememberAccountCurrency(...args: Parameters<Instance['rememberAccountCurrency']>): ReturnType<Instance['rememberAccountCurrency']> {
  return desktopAccountCurrencyStore.rememberAccountCurrency(...args);
}

export function noteActiveAccount(...args: Parameters<Instance['noteActiveAccount']>): ReturnType<Instance['noteActiveAccount']> {
  return desktopAccountCurrencyStore.noteActiveAccount(...args);
}

export function hydrateAccountCurrency(...args: Parameters<Instance['hydrateAccountCurrency']>): ReturnType<Instance['hydrateAccountCurrency']> {
  return desktopAccountCurrencyStore.hydrateAccountCurrency(...args);
}

/** 仅测试：丢掉内存快照，强制下次重读磁盘。 */
export function __resetAccountCurrencyStoreForTesting(): void {
  desktopAccountCurrencyStore.__resetAccountCurrencyStoreForTesting();
}

/** 仅测试：等待 fire-and-forget 的串行写链完成，避免用固定延时猜测磁盘时序。 */
export function __flushAccountCurrencyStoreForTesting(): Promise<void> {
  return desktopAccountCurrencyStore.__flushAccountCurrencyStoreForTesting();
}
