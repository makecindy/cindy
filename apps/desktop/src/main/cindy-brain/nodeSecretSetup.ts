import type { GhostManifest } from '../../shared/ghost.js';
import { GhostSetupCoordinator } from './ghostSetupCoordinator.js';
import type { GhostSetupChangeBus } from './ghostSetupChangeBus.js';
import type { GhostSetupInteractionBridge } from './ghostSetupInteractionBridge.js';
import { executeGhostSetupInlineSubmission } from './ghostSetupInlineExecutor.js';
import { evaluateGhostSetupAssessment } from './ghostSetupStatus.js';

export interface NodeSecretSetupInput {
  ghostId: string;
  entry: string;
  method: string;
  sessionId: string;
  signal: AbortSignal;
  force: boolean;
  /** Captures the exact live call, owner, package and runtime generation. */
  assertCurrent(): void;
}

export interface NodeSecretSetupDeps {
  bridge: GhostSetupInteractionBridge;
  changeBus: GhostSetupChangeBus;
  getManifest(ghostId: string): GhostManifest | null;
  secretSaved(ghostId: string, key: string): boolean;
  storeSecret(ghostId: string, key: string, value: string): boolean;
}

/**
 * On-demand configuration of the exact Node RPC's declared manual credentials.
 * Reuses the existing password card, signed remote bridge and vault executor.
 * The temporary assessment never changes the plugin's ordinary setup policy;
 * existing CLI logins and unrelated tools therefore remain usable.
 */
export async function requestNodeSecretSetup(
  deps: NodeSecretSetupDeps,
  input: NodeSecretSetupInput,
): Promise<boolean> {
  const submitted = new Set<string>();
  const currentManifest = (): GhostManifest => {
    input.assertCurrent();
    if (input.signal.aborted) throw new Error('NODE_SECRET_INPUT_CANCELLED');
    const manifest = deps.getManifest(input.ghostId);
    if (!manifest?.node) throw new Error('NODE_SECRET_TARGET_UNAVAILABLE');
    return manifest;
  };
  const assess = () => {
    const manifest = currentManifest();
    const bindings =
      manifest.node!.secretBindings?.filter(
        (binding) =>
          !binding.oauthSecret &&
          binding.methods.includes(input.method) &&
          (binding.entry ?? manifest.node!.entry) === input.entry,
      ) ?? [];
    if (bindings.length === 0) throw new Error('NODE_SECRET_BINDING_UNAVAILABLE');
    return evaluateGhostSetupAssessment(
      {
        ...manifest,
        setup: {
          requires: bindings.map((binding) => ({
            anyOf: [{ kind: 'secret' as const, key: binding.key }],
          })),
        },
      },
      {
        secretSaved: (key) =>
          (!input.force || submitted.has(key)) && deps.secretSaved(input.ghostId, key),
        oauthStatus: () => ({ clientConfigured: false, connected: 0, expired: 0 }),
        connectionCount: () => 0,
        kvValue: () => undefined,
      },
      { revision: deps.changeBus.currentRevision(input.ghostId), strict: true },
    );
  };
  const coordinator = new GhostSetupCoordinator({
    bridge: deps.bridge,
    changeBus: deps.changeBus,
    assess,
    validateTarget: () => {
      try {
        currentManifest();
        return { ok: true };
      } catch {
        return {
          ok: false,
          errorCode: 'GHOST_NOT_FOUND',
          message: 'Plugin credential input is no longer active',
        };
      }
    },
    getGhostIdentity: () => {
      const manifest = currentManifest();
      return { id: manifest.id, name: manifest.name };
    },
    executeAction: async () => ({ ok: false, errorCode: 'ACTION_STALE' }),
    executeInlineAction: async (args) =>
      executeGhostSetupInlineSubmission(
        {
          getManifest: currentManifest,
          getAssessment: assess,
          storeSecret: (ghostId, key, value) => {
            currentManifest();
            const saved = deps.storeSecret(ghostId, key, value);
            // Seal a forced replacement before synchronous change listeners run.
            // Cancellation / failed writes keep the previous credential untouched.
            if (saved) submitted.add(key);
            return saved;
          },
          emitChange: (ghostId, key) => {
            deps.changeBus.emit(ghostId, { source: 'secret', ref: key });
          },
        },
        args,
      ),
  });
  const result = await coordinator.ensureReady({
    sessionId: input.sessionId,
    ghostId: input.ghostId,
    signal: input.signal,
  });
  if (!result.ok) return false;
  currentManifest();
  return true;
}
