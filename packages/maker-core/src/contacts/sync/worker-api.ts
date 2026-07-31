/**
 * Desktop contacts-sync worker 的窄入口。
 *
 * 不从 maker-core 根 barrel 引入，避免把 agent SDK 等与通讯录无关的运行时依赖
 * 拉进独立 worker bundle。
 */
export { MakerContactsStore } from '../store.js';
export { createContactsSyncDelta } from './merge.js';
export type { ContactsSyncState } from './types.js';
