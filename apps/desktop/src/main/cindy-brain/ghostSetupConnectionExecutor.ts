import { parsePluginConnectionInput, type PluginConnectionInput } from '@cindy/device-link';
import type { GhostManifest, GhostSetupAssessment } from '../../shared/ghost.js';
import type { GhostConnectionManager } from './ghostConnections.js';
import { getRemoteOauthContext } from '../plugin-oauth/context.js';

export interface GhostSetupConnectionExecutorDeps {
  getManifest(ghostId: string): GhostManifest | null;
  getAssessment(ghostId: string): GhostSetupAssessment;
  manager: Pick<GhostConnectionManager, 'upsert'>;
  emitChange(ghostId: string, key: string): void;
}
/** Dedicated authenticated form. Never accepts a caller-selected vault key or inject header. */
export function executeGhostSetupConnectionSubmission(
  deps: GhostSetupConnectionExecutorDeps,
  args: {
    ghostId: string;
    actionId: string;
    expectedManifest: string;
    value: PluginConnectionInput;
    /** Main-only callback bound to the still-current card, before revision broadcasts. */
    onCommitted?(): void;
  },
): boolean {
  const remote = getRemoteOauthContext();
  if (!remote?.submitConnection) return false;
  remote.assertCurrent();
  const value = parsePluginConnectionInput(args.value);
  const manifest = deps.getManifest(args.ghostId);
  if (!manifest || JSON.stringify(manifest) !== args.expectedManifest) return false;
  const assessment = deps.getAssessment(args.ghostId);
  // The signed bridge already requires a live exact-revision action card. Its
  // explicit reconnect may legitimately target an existing connection.
  const item = assessment.groups
    .flatMap((g) => g.items)
    .find(
      (i) =>
        i.kind === 'connection' &&
        i.actions.some((a) => a.kind === 'manage_connection' && a.id === args.actionId),
    );
  if (!item?.ref.startsWith('connection:')) return false;
  const key = item.ref.slice('connection:'.length);
  const decl = manifest.network?.connections?.find((c) => c.key === key);
  if (!decl || args.actionId !== `manage_connection:connection:${key}`) return false;
  // User typed this exact host in the trusted Desktop form. The plugin iframe
  // cannot submit this channel. Its existing settings confirmation stays intact.
  remote.assertCurrent();
  const result = deps.manager.upsert(args.ghostId, key, {
    ...value,
    max: decl.maxConnections ?? 8,
  });
  if (!result.ok) return false;
  // Synchronous vault write completed under the same owner/card fence. Mark only
  // configuration saved; a subsequent real provider call proves account access.
  remote.finish(true);
  args.onCommitted?.();
  deps.emitChange(args.ghostId, key);
  return true;
}
