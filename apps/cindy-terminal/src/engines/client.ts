import { setTimeout as pause } from 'node:timers/promises';
import type { RemoteResource, RemoteCollectionListResponse } from '@cindy/device-link';
import type { TerminalClient } from '../contracts.js';
import { unwrap } from '../client-operations.js';
import { runResourceCommand } from '../resource-commands.js';
import type { Locale } from '../ui/i18n.js';
import type { EngineKind } from './types.js';
import type { EngineJob, EngineOperation, EngineResourceState } from './resources.js';

export function engineResourceState(resource: RemoteResource): EngineResourceState {
  const state = resource.blocks?.find(block => block.id === 'engine')?.data as EngineResourceState | undefined;
  if (!state || !['claude-code', 'codex', 'pi'].includes(state.kind)) throw new Error('ENGINE_STATUS_UNAVAILABLE');
  return state;
}
export async function listEngines(client: TerminalClient, locale: Locale, device?: string): Promise<EngineResourceState[]> {
  const page = unwrap(await runResourceCommand(client, { collection: 'engines', operation: 'list', locale, device })) as RemoteCollectionListResponse;
  return page.items.map(engineResourceState);
}
export async function operateEngine(client: TerminalClient, kind: EngineKind, operation: EngineOperation, locale: Locale, device?: string): Promise<EngineResourceState> {
  const response = unwrap(await runResourceCommand(client, { collection: 'engines', operation, id: kind, locale, device })) as { result: EngineJob };
  const id = response.result?.id;
  if (!id) throw new Error('ENGINE_OPERATION_OUTCOME_UNKNOWN');
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const resource = unwrap(await runResourceCommand(client, { collection: 'engines', operation: 'get', id: kind, locale, device })) as RemoteResource;
    const state = engineResourceState(resource);
    if (state.job?.id !== id) throw new Error('ENGINE_OPERATION_OUTCOME_UNKNOWN');
    if (state.job.state === 'completed') return state;
    if (state.job.state === 'failed') throw new Error(state.job.error ?? 'ENGINE_OPERATION_FAILED');
    if (Date.now() >= deadline) throw new Error('ENGINE_OPERATION_OUTCOME_UNKNOWN');
    await pause(1000);
  }
}
