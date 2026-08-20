import {
  normalizeOllamaPullName,
  type LocalInstalledModel,
  type LocalModelPullProgress,
  type LocalRuntimeInstallProgress,
  type LocalRuntimeStatus,
  type RecommendedLocalModel,
} from '../../shared/localModelRuntime.js';
import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import type { IpcHandlerRegistry } from '../maker-ipc/ipcHandlerRegistry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  createLocalModelService,
  OwnerChangedError,
  PullAbortedError,
  PullBusyError,
  type LocalModelOwnerScope,
  type LocalModelService,
} from './service.js';
import { onQuit } from '../lifecycle.js';
import { markManagedOllamaRemoved, type ManagedEnsureResult } from './managedOllamaProvider.js';
import { registerManagedSidecarQuitHook } from './ollamaSidecar.js';

function requirePullName(name: unknown): string {
  const pullName = typeof name === 'string' ? normalizeOllamaPullName(name) : null;
  if (!pullName) throwIpcError('INVALID_PARAMS', 'invalid ollama model name');
  return pullName;
}

export interface LocalModelHandlerDeps {
  assertTrustedSender: (event: unknown) => void;
  refreshCatalog: () => Promise<void>;
  broadcastChanged: () => void;
  broadcastStatus: (status: LocalRuntimeStatus) => void;
  broadcastPullProgress: (progress: LocalModelPullProgress) => void;
  broadcastInstallProgress: (progress: LocalRuntimeInstallProgress) => void;
  currentOwnerSession?: () => LocalModelOwnerScope;
  service?: LocalModelService;
  userDataDir?: string;
}

function throwManagedResult(result: ManagedEnsureResult): { ok: true; created: boolean } {
  if (!result.ok) {
    if (result.code === 'OWNER_CHANGED') {
      throwIpcError('PRECONDITION_FAILED', 'active account changed during local model write');
    }
    throwIpcError(
      'PRECONDITION_FAILED',
      `managed provider id '${result.existing.id}' already exists with a different shape`,
    );
  }
  return { ok: true, created: result.created };
}

export function registerLocalModelHandlers(
  registry: IpcHandlerRegistry,
  deps: LocalModelHandlerDeps,
): LocalModelService {
  const service =
    deps.service ??
    createLocalModelService({
      onStatus: deps.broadcastStatus,
      onPullProgress: deps.broadcastPullProgress,
      onInstallProgress: deps.broadcastInstallProgress,
      userDataDir: deps.userDataDir,
    });
  registerManagedSidecarQuitHook((stop) => onQuit('ollama-sidecar', stop, 'sync'));

  const ownerMatches = (owner: LocalModelOwnerScope | undefined): boolean => {
    if (!deps.currentOwnerSession || !owner) return true;
    const current = deps.currentOwnerSession();
    return current.dataOwnerId === owner.dataOwnerId && current.generation === owner.generation;
  };

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_STATUS, async (event) => {
    deps.assertTrustedSender(event);
    return service.status();
  });

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_START, async (event) => {
    deps.assertTrustedSender(event);
    return service.start();
  });

  registry.handle(
    MAKER_INVOKE.LOCAL_MODEL_LIST,
    async (
      event,
    ): Promise<{
      status: LocalRuntimeStatus;
      models: LocalInstalledModel[];
      recommended: RecommendedLocalModel | null;
      catalog: import('../../shared/localModelRuntime.js').CuratedOllamaModel[];
      featured: import('../../shared/localModelRuntime.js').CuratedOllamaModel[];
      memoryGb: number;
      recommendReason: import('../../shared/localModelRuntime.js').LocalRecommendReason;
      appleSilicon: boolean;
      pull: LocalModelPullProgress | null;
      pulls: LocalModelPullProgress[];
      pausedPull: LocalModelPullProgress | null;
      detectedLocalPresetIds: string[];
    }> => {
      deps.assertTrustedSender(event);
      const owner = deps.currentOwnerSession?.();
      const result = await service.list({
        owner,
        ownerStillActive: () => ownerMatches(owner),
      });
      if (result.catalogDirty) {
        await deps.refreshCatalog();
        deps.broadcastChanged();
      }
      return result;
    },
  );

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_PULL, async (event, name: unknown) => {
    deps.assertTrustedSender(event);
    const pullName = requirePullName(name);
    const owner = deps.currentOwnerSession?.();
    const status = await service.status();
    if (status.kind !== 'ready' && status.kind !== 'pulling') {
      throwIpcError('PRECONDITION_FAILED', 'ollama is not ready');
    }
    try {
      await service.pull(pullName, {
        owner,
        ownerStillActive: () => ownerMatches(owner),
      });
    } catch (error) {
      if (error instanceof PullAbortedError) {
        return { ok: true as const, stopped: error.reason };
      }
      if (error instanceof PullBusyError) {
        throwIpcError('SESSION_RUNNING', error.message);
      }
      if (error instanceof OwnerChangedError) {
        throwIpcError('INTERNAL', error.message);
      }
      if (error instanceof Error && error.message === 'MANAGED_ID_CONFLICT') {
        throwIpcError('PRECONDITION_FAILED', 'managed provider id conflict');
      }
      throw error;
    }
    if (!ownerMatches(owner)) {
      throwIpcError('INTERNAL', 'active account changed during local model download');
    }
    await deps.refreshCatalog();
    deps.broadcastChanged();
    return { ok: true as const };
  });

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_ABORT, async (event, reason: unknown, name: unknown) => {
    deps.assertTrustedSender(event);
    if (reason !== 'pause' && reason !== 'cancel') {
      throwIpcError('INVALID_PARAMS', 'reason must be pause or cancel');
    }
    return service.abortPull(reason, requirePullName(name));
  });

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_INSTALL, async (event, input: unknown) => {
    deps.assertTrustedSender(event);
    if (!input || typeof input !== 'object' || (input as { consent?: unknown }).consent !== true) {
      throwIpcError('INVALID_PARAMS', 'consent is required');
    }
    try {
      const owner = deps.currentOwnerSession?.();
      const status = await service.installRuntime();
      if (status.kind === 'ready') {
        const result = throwManagedResult(
          await service.ensureProvider({
            owner,
            ownerStillActive: () => ownerMatches(owner),
          }),
        );
        await deps.refreshCatalog();
        deps.broadcastChanged();
        return { ok: true as const, status, created: result.created };
      }
      return { ok: true as const, status };
    } catch (error) {
      if (error instanceof PullAbortedError) {
        return { ok: true as const, stopped: 'cancel' as const };
      }
      throw error;
    }
  });

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_INSTALL_ABORT, async (event) => {
    deps.assertTrustedSender(event);
    return service.abortInstall();
  });

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_ENSURE, async (event) => {
    deps.assertTrustedSender(event);
    const status = await service.status();
    if (status.kind !== 'ready' && status.kind !== 'pulling') {
      throwIpcError('PRECONDITION_FAILED', 'ollama is not ready');
    }
    const owner = deps.currentOwnerSession?.();
    const result = throwManagedResult(
      await service.ensureProvider({
        owner,
        ownerStillActive: () => ownerMatches(owner),
      }),
    );
    await deps.refreshCatalog();
    deps.broadcastChanged();
    return result;
  });

  registry.handle(
    MAKER_INVOKE.LOCAL_MODEL_SET_IN_PICKER,
    async (event, name: unknown, enabled: unknown) => {
      deps.assertTrustedSender(event);
      const pullName = requirePullName(name);
      if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled must be boolean');
      const owner = deps.currentOwnerSession?.();
      const result = throwManagedResult(
        await service.setModelInPicker(pullName, enabled, {
          owner,
          ownerStillActive: () => ownerMatches(owner),
        }),
      );
      await deps.refreshCatalog();
      deps.broadcastChanged();
      return result;
    },
  );

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_DISCARD_PAUSED, async (event, name: unknown) => {
    deps.assertTrustedSender(event);
    await service.discardPaused(requirePullName(name));
    await deps.refreshCatalog();
    deps.broadcastChanged();
    return { ok: true as const };
  });

  registry.handle(MAKER_INVOKE.LOCAL_MODEL_DELETE, async (event, name: unknown) => {
    deps.assertTrustedSender(event);
    const pullName = requirePullName(name);
    const status = await service.status();
    if (status.kind !== 'ready' && status.kind !== 'pulling') {
      throwIpcError('PRECONDITION_FAILED', 'ollama is not ready');
    }
    try {
      const owner = deps.currentOwnerSession?.();
      const result = throwManagedResult(
        await service.deleteInstalled(pullName, {
          owner,
          ownerStillActive: () => ownerMatches(owner),
        }),
      );
      await deps.refreshCatalog();
      deps.broadcastChanged();
      return result;
    } catch (error) {
      if (error instanceof PullBusyError) {
        throwIpcError('SESSION_RUNNING', error.message);
      }
      throw error;
    }
  });

  return service;
}

export function notifyManagedOllamaRemoved(): void {
  markManagedOllamaRemoved();
}
