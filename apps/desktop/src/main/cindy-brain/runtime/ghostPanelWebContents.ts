/** Host 登记的插件面板 Guest 身份；插件代码不能自报或修改。 */
export interface GhostPanelWebContentsContext {
  ghostId: string;
  hostWebContentsId: number;
}

const contexts = new Map<number, GhostPanelWebContentsContext>();

export function registerGhostPanelWebContents(
  guestWebContentsId: number,
  context: GhostPanelWebContentsContext,
): void {
  contexts.set(guestWebContentsId, { ...context });
}

export function unregisterGhostPanelWebContents(guestWebContentsId: number): void {
  contexts.delete(guestWebContentsId);
}

export function ghostPanelContextForWebContents(
  guestWebContentsId: number,
): GhostPanelWebContentsContext | null {
  const context = contexts.get(guestWebContentsId);
  return context ? { ...context } : null;
}
