/** Main-only page approvals. No Agent rule store and no persistence. */
type Grant = {
  sessionId: string;
  serverId: string;
  tool: string;
  revision: string;
  clearedAt: unknown;
};
export class PagePermissionGrants {
  private owner: unknown;
  private grants: Grant[] = [];
  private bind(owner: unknown) {
    if (this.owner !== owner) {
      this.owner = owner;
      this.grants = [];
    }
  }
  has(owner: unknown, grant: Grant): boolean {
    this.bind(owner);
    this.grants = this.grants.filter(
      (g) =>
        !(g.sessionId === grant.sessionId && g.clearedAt !== grant.clearedAt) &&
        !(g.serverId === grant.serverId && g.revision !== grant.revision),
    );
    return this.grants.some(
      (g) =>
        g.sessionId === grant.sessionId && g.serverId === grant.serverId && g.tool === grant.tool,
    );
  }
  allow(owner: unknown, grant: Grant) {
    if (!this.has(owner, grant)) this.grants.push(grant);
  }
  clearSession(sessionId: string) {
    this.grants = this.grants.filter((g) => g.sessionId !== sessionId);
  }
  clearServers(ids?: ReadonlySet<string>) {
    this.grants = ids ? this.grants.filter((g) => !ids.has(g.serverId)) : [];
  }
}
export const pagePermissionGrants = new PagePermissionGrants();
const listeners = new Set<(sessionId: string, patch: Record<string, unknown>) => void>();
export function onPagePermissionSessionChanged(
  listener: (sessionId: string, patch: Record<string, unknown>) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Called only after the ordinary session mutation commits, with its owner fence intact. */
export function pagePermissionSessionChanged(sessionId: string, patch: Record<string, unknown>) {
  if ('planModeEnabled' in patch || 'clearedAt' in patch || ('status' in patch && patch.status !== 'active'))
    pagePermissionGrants.clearSession(sessionId);
  for (const listener of listeners) listener(sessionId, patch);
}
