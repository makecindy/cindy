import { ghostPermissionItems } from '../../../src/shared/ghost';
const manifest = { schemaVersion: 3, id: 'planner', name: 'Planner', version: '1.0.0', network: { hosts: ['planner.example'] },
  tools: [{ name: 'refresh_metrics', description: 'Refresh metrics', inputSchema: { type: 'object' } }, { name: 'save_plan', description: 'Save the plan', inputSchema: { type: 'object' } }],
  mcpApps: { ui: { resources: [{
            uri: "ui://planner",
            file: 'ui/planner.html',
            csp: { connectDomains: ['https://planner.example'] }
        }], tools: { refresh_metrics: { resourceUri: "ui://planner" }, save_plan: { visibility: ['app'] } } } },
};
let approved = false;
export async function hasPluginManagement() { return true; }
export async function invokePluginManagement(_device: string, action: string, input: { operationId?: string; confirmed?: boolean } = {}) {
  if (action === 'snapshot') return { version: 1, uiCapabilityApproval: true, market: { items: [] }, ghosts: [{ manifest, instanceKey: 'planner', enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' }, uiCapabilityApproved: approved }] };
  if (action === 'answer') approved = input.confirmed === true;
  if (action === 'operation' && !approved) return { operationId: input.operationId, phase: 'confirmation', consent: {
    requestId: 'page-consent', trust: 'unverified', purpose: 'ui-capability', initiator: 'user', origin: 'local-file',
    facts: { kind: 'update', ghostId: 'planner', name: 'Planner', version: '1.0.0', previousVersion: '1.0.0', removed: [], unchangedCount: 0, added: ghostPermissionItems(manifest as never).filter(item => item.key === 'ui:pages') },
  } };
  return { operationId: input.operationId, phase: approved ? 'succeeded' : 'running' };
}
export const parsePluginManagementSnapshot = (value: unknown) => value;
export const parsePluginManagementReceipt = (value: unknown) => value;
