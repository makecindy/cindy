import type { DataOwnerPushStamp } from '../../../shared/dataOwnerPush.js';

/** Host 登记的插件面板 Guest 身份；插件代码不能自报或修改。 */
export interface GhostPanelWebContentsContext {
  ghostId: string;
  hostWebContentsId: number;
  ownerStamp: DataOwnerPushStamp;
}

const contexts = new Map<number, GhostPanelWebContentsContext>();

export function registerGhostPanelWebContents(
  guestWebContentsId: number,
  context: GhostPanelWebContentsContext,
): void {
  contexts.set(guestWebContentsId, {
    ...context,
    ownerStamp: { ...context.ownerStamp },
  });
}

export function unregisterGhostPanelWebContents(guestWebContentsId: number): void {
  contexts.delete(guestWebContentsId);
}

export function ghostPanelContextForWebContents(
  guestWebContentsId: number,
  currentOwnerStamp?: DataOwnerPushStamp,
): GhostPanelWebContentsContext | null {
  const context = contexts.get(guestWebContentsId);
  if (
    context &&
    currentOwnerStamp &&
    (context.ownerStamp.dataOwnerId !== currentOwnerStamp.dataOwnerId ||
      context.ownerStamp.ownerGeneration !== currentOwnerStamp.ownerGeneration)
  ) {
    contexts.delete(guestWebContentsId);
    return null;
  }
  return context
    ? {
        ...context,
        ownerStamp: { ...context.ownerStamp },
      }
    : null;
}
