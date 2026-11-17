/**
 * 电脑端的卡片归档任务按钮状态(data-ghost-task-archive,见 ghostCardPrStatus)。约定与状态机在
 * maker-shared 的 ghostCardTaskArchive 里,与手机端共用;这里是电脑端自己的一份实例。
 */
import { createGhostCardTaskAutoArchive, type GhostCardTaskAutoArchiveState } from '@cindy/maker-shared/ghost-card-task-archive';

export type { GhostCardTaskAutoArchiveState };

const store = createGhostCardTaskAutoArchive();

export const requestGhostCardTaskArchive = store.requestArchive;
export const onGhostCardTaskArchiveRequest = store.onArchiveRequest;
export const onGhostCardTaskAutoArchiveChange = store.onChange;
export const enableGhostCardTaskAutoArchive = store.enable;
export const setGhostCardTaskAutoArchiveArmed = store.setArmed;
export const getGhostCardTaskAutoArchiveState = store.getState;
export const isGhostCardTaskAutoArchivePending = store.isPending;
export const cancelGhostCardTaskAutoArchive = store.cancel;
export const cancelPendingGhostCardTaskAutoArchive = store.cancelPending;
export const noteGhostCardTaskUserMessage = store.noteUserMessage;
export const markGhostCardTaskSeen = store.markSeen;
export const takeGhostCardTaskSeen = store.takeSeen;
