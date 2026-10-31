/**
 * New computer, keys and SSH step (docs/product-rules/new-device-setup-migration.md).
 *
 * One request to the other computer (a person there allows it), then every copied value goes
 * through this computer's own creators and stores: connections and MCP are created with their keys
 * in Main, built-in and plugin keys are written only where this computer has none yet, and SSH
 * servers are added with this computer's new key and checked. Anything that did not arrive stays
 * for the window's ordinary steps or on the one-time checklist.
 */
import type {
  SetupSecretBundle,
  SetupSnapshot,
  SetupSnapshotSshHost,
  SetupTransferSecretsRequest,
  SetupTransferSshResult,
} from '@cindy/device-link';

import type { CustomMcpConfig } from '../../shared/customMcp.js';
import {
  SETUP_MIGRATION_SECRETS_KEY,
  type SetupMigrationChecklistItem,
  type SetupMigrationPlan,
} from '../../shared/setupMigration.js';
import type { SetupTransferOutcome } from './transfer.js';

export interface SetupTransferApplyDeps {
  /** Asks the other computer; `onCode` runs before it is asked. */
  transfer(input: {
    secrets: SetupTransferSecretsRequest | null;
    ssh: { publicKey: string; hosts: string[] } | null;
    onCode(code: string): void;
  }): Promise<SetupTransferOutcome>;
  createProvider(config: Record<string, unknown>, keys: Record<string, string>): Promise<'done' | 'skipped'>;
  createMcpServer(config: CustomMcpConfig, token: string | null): Promise<void>;
  hasBuiltinKey(id: string): boolean;
  storeBuiltinKey(id: string, value: string): boolean;
  /** Installed plugin instance here for the other computer's plugin, or null. */
  pluginInstanceKey(ghostId: string, namespace: string | null): string | null;
  /** Writes declared keys not saved here yet; returns how many were written. */
  storePluginSecrets(instanceKey: string, values: Record<string, string>): number;
  generateSshKey(): Promise<{ privateKeyPath: string; publicKey: string }>;
  addSshHost(host: SetupSnapshotSshHost, identityFile: string): Promise<{ outcome: 'done' } | { outcome: 'failed'; code: string }>;
}

type Run = (key: string, task: () => Promise<'done' | 'skipped'>) => Promise<{ outcome: string; code?: string }>;

export interface SetupTransferStepResult {
  handledKeys: string[];
  checklist: SetupMigrationChecklistItem[];
}

class StepError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function codeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  return /\b(SETUP_[A-Z_]+|SSH_[A-Z_]+)\b/.exec(message)?.[1] ?? fallback;
}

export function setupTransferKeys(plan: SetupMigrationPlan, keys: ReadonlySet<string>): string[] {
  return [
    ...(plan.secrets?.state === 'ready' && keys.has(SETUP_MIGRATION_SECRETS_KEY) ? [SETUP_MIGRATION_SECRETS_KEY] : []),
    ...plan.sshHosts.filter((item) => item.state === 'ready' && keys.has(item.key)).map((item) => item.key),
  ];
}

function sshChecklist(host: { id: string; displayName: string }): SetupMigrationChecklistItem {
  return { id: `ssh-host:${host.id}`, kind: 'ssh-host', label: host.displayName, ref: host.id };
}

export async function applySetupTransferStep(
  input: {
    plan: SetupMigrationPlan;
    snapshot: SetupSnapshot;
    keys: ReadonlySet<string>;
    onCode(key: string, code: string): void;
  },
  deps: SetupTransferApplyDeps,
  run: Run,
): Promise<SetupTransferStepResult> {
  const { plan, snapshot, keys } = input;
  const wantSecrets = plan.secrets?.state === 'ready' && keys.has(SETUP_MIGRATION_SECRETS_KEY);
  const hosts = plan.sshHosts.filter((item) => item.state === 'ready' && keys.has(item.key));
  const handledKeys: string[] = [];
  const checklist: SetupMigrationChecklistItem[] = [];
  if (!wantSecrets && hosts.length === 0) return { handledKeys, checklist };

  const providers = plan.providers.filter(
    (item) => item.state === 'ready' && keys.has(item.key) && item.provider.auth !== 'oauth' && item.provider.auth !== 'native',
  );
  const mcpServers = plan.mcpServers.filter((item) => item.state === 'ready' && keys.has(item.key));
  const secretsRequest: SetupTransferSecretsRequest | null = wantSecrets
    ? {
        providers: providers.map((item) => item.provider.id),
        mcpServers: mcpServers.map((item) => item.server.id),
        builtinKeys: plan.secrets!.items.filter((item) => item.kind === 'builtin').map((item) => item.ref),
        plugins: plan.secrets!.items
          .filter((item) => item.kind === 'plugin')
          .flatMap((item) => {
            const plugin = plan.plugins.find((candidate) => candidate.key === item.ref);
            return plugin ? [{ ghostId: plugin.ghostId, namespace: plugin.namespace }] : [];
          }),
      }
    : null;

  // SSH key first: the other computer is asked once, for keys and servers together.
  let sshKey: { privateKeyPath: string; publicKey: string } | null = null;
  let sshKeyError: string | null = null;
  if (hosts.length > 0) {
    try {
      sshKey = await deps.generateSshKey();
    } catch (error) {
      sshKeyError = codeOf(error, 'SSH_KEYGEN_FAILED');
    }
  }

  const codeKey = wantSecrets ? SETUP_MIGRATION_SECRETS_KEY : hosts[0]?.key;
  let outcome: SetupTransferOutcome | null = null;
  let transferError: string | null = null;
  if (secretsRequest || sshKey) {
    try {
      outcome = await deps.transfer({
        secrets: secretsRequest,
        ssh: sshKey ? { publicKey: sshKey.publicKey, hosts: hosts.map((item) => item.id) } : null,
        onCode: (code) => {
          if (codeKey) input.onCode(codeKey, code);
        },
      });
    } catch (error) {
      transferError = codeOf(error, 'SETUP_SOURCE_UNAVAILABLE');
    }
  }

  if (wantSecrets) {
    await run(SETUP_MIGRATION_SECRETS_KEY, async () => {
      if (transferError) throw new StepError(transferError);
      const bundle = outcome?.secrets;
      if (!bundle) return 'skipped';
      return (await writeSecrets(bundle, { providers, mcpServers }, deps, handledKeys)) ? 'done' : 'skipped';
    });
    // Connections created here with their keys report like the window's own items.
    for (const key of handledKeys) await run(key, async () => 'done');
  }

  for (const item of hosts) {
    const result = await run(item.key, async () => {
      const failure = sshKeyError ?? transferError;
      if (failure || !sshKey) throw new StepError(failure ?? 'SSH_KEYGEN_FAILED');
      const answer: SetupTransferSshResult | undefined = outcome?.ssh?.find((entry) => entry.host === item.id);
      if (!answer || answer.outcome === 'failed') throw new StepError(answer?.code ?? 'SSH_AUTHORIZE_FAILED');
      const source = snapshot.sshHosts.find((host) => host.id === item.id);
      if (!source) throw new StepError('SSH_HOST_NOT_FOUND');
      const added = await deps.addSshHost(source, sshKey.privateKeyPath);
      if (added.outcome === 'failed') throw new StepError(added.code);
      return 'done';
    });
    if (result.outcome === 'failed') checklist.push(sshChecklist(item));
  }
  return { handledKeys, checklist };
}

async function writeSecrets(
  bundle: SetupSecretBundle,
  selected: {
    providers: SetupMigrationPlan['providers'];
    mcpServers: SetupMigrationPlan['mcpServers'];
  },
  deps: SetupTransferApplyDeps,
  handledKeys: string[],
): Promise<boolean> {
  let wrote = false;
  for (const item of selected.providers) {
    const copied = bundle.providers.find((entry) => entry.id === item.provider.id);
    if (!copied) continue;
    try {
      // A refusal (e.g. Codex busy) or error leaves the item to the window's ordinary step.
      if ((await deps.createProvider(copied.config, copied.keys)) === 'done') {
        handledKeys.push(item.key);
        wrote = true;
      }
    } catch {
      // Same as above: created without keys by the window, keys stay on the checklist.
    }
  }
  for (const item of selected.mcpServers) {
    const copied = bundle.mcpServers.find((entry) => entry.id === item.server.id);
    if (!copied) continue;
    try {
      await deps.createMcpServer(
        { id: item.server.id, name: item.server.name, transport: item.server.transport, url: copied.url, headers: copied.headers },
        copied.token,
      );
      handledKeys.push(item.key);
      wrote = true;
    } catch {
      // The window creates it without credentials instead.
    }
  }
  for (const entry of bundle.builtinKeys) {
    if (deps.hasBuiltinKey(entry.id)) continue;
    if (deps.storeBuiltinKey(entry.id, entry.value)) wrote = true;
  }
  for (const entry of bundle.plugins) {
    const instanceKey = deps.pluginInstanceKey(entry.ghostId, entry.namespace);
    if (!instanceKey) continue;
    if (deps.storePluginSecrets(instanceKey, entry.secrets) > 0) wrote = true;
  }
  return wrote;
}
