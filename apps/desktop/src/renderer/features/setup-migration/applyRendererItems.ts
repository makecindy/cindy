/**
 * The renderer-owned part of a setup plan. Each item goes through the same API its settings
 * page already uses, so validation, queues and refreshes stay with those features:
 * providers and MCP without credentials, built-in tool switches, this computer's access
 * switches and interface preferences. One failure never stops the rest.
 */
import type { CustomProviderConfig } from '@cindy/model-providers';

import type { CustomMcpConfig } from '../../../shared/customMcp';
import type {
  SetupMigrationPlan,
  SetupMigrationProgress,
  SetupMigrationResult,
} from '../../../shared/setupMigration';
import { extractIpcError } from '@/utils/ipcError';

export interface RendererApplyApi {
  /** Still the account that previewed this plan; once false, nothing more is written. */
  isCurrent(): boolean;
  createProvider(config: CustomProviderConfig): Promise<{ ok: boolean }>;
  createMcpServer(config: CustomMcpConfig): Promise<unknown>;
  setBuiltinTool(id: string, enabled: boolean): Promise<unknown>;
  setRemoteControl(enabled: boolean): Promise<unknown>;
  setKeepAwake(enabled: boolean): Promise<unknown>;
  applyPrefs(values: Record<string, string>): number;
}

export function rendererApplyCount(plan: SetupMigrationPlan, keys: ReadonlySet<string>): number {
  return rendererApplyKeys(plan, keys).length;
}

function rendererApplyKeys(plan: SetupMigrationPlan, keys: ReadonlySet<string>): string[] {
  return [
    ...plan.providers.filter((item) => item.state === 'ready').map((item) => item.key),
    ...plan.mcpServers.filter((item) => item.state === 'ready').map((item) => item.key),
    ...plan.builtinTools.filter((item) => item.state === 'ready').map((item) => item.key),
    ...plan.access.filter((item) => item.state === 'ready').map((item) => item.key),
    ...(plan.rendererPrefs?.state === 'ready' ? [plan.rendererPrefs.key] : []),
  ].filter((key) => keys.has(key));
}

function failureCode(error: unknown): string {
  return extractIpcError(error)?.code ?? 'FAILED';
}

export async function applyRendererItems(
  plan: SetupMigrationPlan,
  keys: ReadonlySet<string>,
  api: RendererApplyApi,
  emit: (progress: SetupMigrationProgress) => void,
  offset: { completed: number; total: number },
): Promise<{ results: SetupMigrationResult[]; prefsChanged: boolean }> {
  const results: SetupMigrationResult[] = [];
  let completed = offset.completed;
  let prefsChanged = false;
  const run = async (key: string, task: () => Promise<'done' | 'skipped'>) => {
    if (!keys.has(key)) return;
    emit({ planId: plan.planId, key, phase: 'running', completed, total: offset.total });
    let result: SetupMigrationResult;
    if (!api.isCurrent()) {
      result = { key, outcome: 'failed', code: 'SETUP_PLAN_EXPIRED' };
    } else {
      try {
        result = { key, outcome: await task() };
      } catch (error) {
        result = { key, outcome: 'failed', code: failureCode(error) };
      }
    }
    completed += 1;
    results.push(result);
    emit({ planId: plan.planId, key, phase: result.outcome, completed, total: offset.total });
  };

  for (const item of plan.providers) {
    if (item.state !== 'ready') continue;
    await run(item.key, async () => {
      const outcome = await api.createProvider(item.provider.config as unknown as CustomProviderConfig);
      // Create answers with a confirmation request only when Codex is busy; leave it to Settings.
      return outcome.ok ? 'done' : 'skipped';
    });
  }
  for (const item of plan.mcpServers) {
    if (item.state !== 'ready') continue;
    await run(item.key, async () => {
      const { id, name, transport, url, headers } = item.server;
      await api.createMcpServer({ id, name, transport, url, headers });
      return 'done';
    });
  }
  for (const item of plan.builtinTools) {
    if (item.state !== 'ready') continue;
    await run(item.key, async () => {
      await api.setBuiltinTool(item.id, item.enabled);
      return 'done';
    });
  }
  for (const item of plan.access) {
    if (item.state !== 'ready') continue;
    await run(item.key, async () => {
      if (item.id === 'remote-control') await api.setRemoteControl(true);
      else await api.setKeepAwake(true);
      return 'done';
    });
  }
  if (plan.rendererPrefs?.state === 'ready') {
    const values = plan.rendererPrefs.values;
    await run(plan.rendererPrefs.key, async () => {
      const changed = api.applyPrefs(values);
      prefsChanged = changed > 0;
      return changed > 0 ? 'done' : 'skipped';
    });
  }
  return { results, prefsChanged };
}
