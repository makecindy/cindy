import {
  ORCA_REMOTE_WORKER_CAPS_CHANNEL, ORCA_REMOTE_WORKER_MODELS_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_CHANNEL, ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
  type OrcaRemoteWorkerOpenRequest, type OrcaRemoteWorkerModelsResult,
} from '@cindy/device-link';
import { createOrcaRemoteWorkerHost } from '@cindy/orca-workflow/host/orcaRemoteWorkerHost';
import type { OrcaRemoteLead } from '@cindy/maker-shared/orca-remote-worker';
import type { ProviderView } from '@cindy/model-providers';
import type { InvocationContext } from '../contracts.js';
import type { TerminalTaskMeta, TerminalTaskStorage } from './storage.js';

export const REMOTE_WORKER_CHANNELS = [ORCA_REMOTE_WORKER_CAPS_CHANNEL, ORCA_REMOTE_WORKER_MODELS_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_CHANNEL, ORCA_REMOTE_WORKER_RELEASE_CHANNEL] as const;

export interface RemoteWorkerAssignment {
  leadDeviceId: string;
  leadSessionId: string;
  origin: { kind: 'orca'; senderLabel: string; displayText: string };
}

export async function assertRemoteWorkerAssignment(storage: TerminalTaskStorage, id: string, assignment: RemoteWorkerAssignment) {
  const row = await storage.get(id), lead = row?.orcaRemoteLead;
  if (!row || row.deleted || row.archived || !lead || lead.releasedAt !== undefined
    || lead.leadDeviceId !== assignment.leadDeviceId || lead.leadSessionId !== assignment.leadSessionId) {
    throw new Error('REMOTE_WORKER_RELEASED');
  }
}

export async function readRemoteWorkerAssignment(storage: TerminalTaskStorage, id: string, input: Record<string, unknown>, context: InvocationContext): Promise<RemoteWorkerAssignment | undefined> {
  if (!input.origin || typeof input.origin !== 'object' || (input.origin as { kind?: unknown }).kind !== 'orca') return;
  if (context.source !== 'remote' || !context.deviceId || !context.ownerId || !context.assertCurrent || context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
  const row = await storage.get(id), origin = input.origin as Record<string, unknown>;
  context.assertCurrent();
  if (!row?.orcaRemoteLead || row.orcaRemoteLead.leadDeviceId !== context.deviceId || typeof origin.displayText !== 'string') throw new Error('PERMISSION_DENIED');
  const assignment: RemoteWorkerAssignment = { leadDeviceId: context.deviceId, leadSessionId: row.orcaRemoteLead.leadSessionId,
    origin: { kind: 'orca', senderLabel: 'Lead', displayText: origin.displayText } };
  await assertRemoteWorkerAssignment(storage, id, assignment); context.assertCurrent();
  return assignment;
}

export interface RemoteWorkerPorts {
  storage: TerminalTaskStorage;
  deviceId?: string;
  workerBridge: boolean;
  guard(context: InvocationContext): void;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  providers(deviceId: string | null): Promise<ProviderView[]>;
  locations(): Promise<Array<{ agentDeviceId: string; name: string }>>;
  create(request: OrcaRemoteWorkerOpenRequest, lead: OrcaRemoteLead, guard: () => void): Promise<TerminalTaskMeta>;
  changed(row: TerminalTaskMeta): void;
}

/** The caller is captured per invocation; concurrent devices never share an ambient identity. */
export function createTerminalRemoteWorkerHost(ports: RemoteWorkerPorts) {
  const view = (row: TerminalTaskMeta) => ({
    status: row.deleted ? 'deleted' as const : row.archived ? 'archived' as const : 'active' as const,
    orcaRemoteLead: row.orcaRemoteLead ?? null, workingDir: row.workDir, model: row.model,
    agentKind: row.agentKind, effort: row.effort, fastMode: row.fastMode,
    agentDeviceId: row.agentDeviceId ?? null, providerId: row.providerId ?? null,
  });
  return async (channel: string, args: unknown[], context: InvocationContext): Promise<unknown> => {
    const guard = () => ports.guard(context);
    const host = createOrcaRemoteWorkerHost({
      workerBridge: ports.workerBridge,
      getCaller: () => context.source === 'remote' && context.deviceId && context.ownerId && context.assertCurrent
        ? { controllerDeviceId: context.deviceId, controllerName: context.sourceDevice?.name, sharedTask: context.sharedTask }
        : null,
      readSession: async id => { const row = await ports.storage.get(id); guard(); return row ? view(row) : null; },
      withSessionLock: (id, work) => ports.withLock(id, async () => { guard(); return work(); }),
      openSession: async (request, lead) => {
        const input = request.agentDeviceId === ports.deviceId ? { ...request, agentDeviceId: null } : request;
        const row = await ports.create(input, lead, guard); guard();
        return { workingDir: row.workDir, model: row.model, agentKind: row.agentKind, effort: row.effort, fastMode: row.fastMode,
          ...(request.agentDeviceId !== undefined ? { agentDeviceId: row.agentDeviceId ?? null, providerId: row.providerId ?? null } : {}) };
      },
      writeRemoteLead: async (id, lead) => {
        const row = await ports.storage.updateIf(id, () => true, { orcaRemoteLead: lead }, guard);
        guard(); if (row) ports.changed(row);
      },
      readModels: async request => {
        const deviceId = request.agentDeviceId === ports.deviceId ? null : request.agentDeviceId ?? null;
        const providers = await ports.providers(deviceId); guard();
        const result: OrcaRemoteWorkerModelsResult = { agentDeviceId: deviceId, locations: await ports.locations() };
        guard();
        for (const kind of request.agent ? [request.agent] : ['claude-code', 'codex', 'pi'] as const) {
          const models = new Map<string, NonNullable<OrcaRemoteWorkerModelsResult['pi']>[number]>();
          for (const provider of providers) {
            if (!provider.connected || provider.suspended) continue;
            for (const model of provider.models[kind] ?? []) {
              if (model.disabled) continue;
              const entry = models.get(model.id) ?? { id: model.id, label: model.name ?? model.id, providers: [], defaultProviderId: provider.id };
              entry.providers!.push({ id: provider.id, name: provider.name }); models.set(model.id, entry);
            }
          }
          result[kind === 'claude-code' ? 'claude_code' : kind] = [...models.values()];
        }
        return result;
      },
      now: Date.now,
    });
    guard();
    switch (channel) {
      case ORCA_REMOTE_WORKER_CAPS_CHANNEL: return host.caps();
      case ORCA_REMOTE_WORKER_MODELS_CHANNEL: return host.models(args[0]);
      case ORCA_REMOTE_WORKER_OPEN_CHANNEL: return host.open(args[0]);
      case ORCA_REMOTE_WORKER_RELEASE_CHANNEL: return host.release(args[0]);
      default: throw new Error('CHANNEL_NOT_ALLOWED');
    }
  };
}
