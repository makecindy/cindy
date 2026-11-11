let state = { pendingAppPermissions: [] as unknown[] };
const listeners = new Set<() => void>();
export function showApproval() {
  state = { pendingAppPermissions: ['first', 'second'].map(id => ({ requestId: id, toolName: 'MCP App: read_draft', title: 'Read a saved draft', suggestions: [{ destination: 'session' }], input: { draft: 'monthly-plan' }, mcpApp: { clientId: 'card', serverId: 'planner', title: 'Monthly planner', scope: 'session' } })) };
  listeners.forEach(listener => listener());
}
export const makerChatStore = {
  subscribe: (_id: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot: () => state,
  respondToPermission: (_id: string, decision: unknown, requestId: string) => {
    (window as any).pageApprovalAnswer = { requestId, decision };
    state = { pendingAppPermissions: state.pendingAppPermissions.filter((item: any) => item.requestId !== requestId) };
    listeners.forEach(listener => listener());
  },
};
