import os from 'node:os';
import {
  MANAGED_LLAMACPP_PROVIDER_ID,
  validLlamaCppFile,
  validLlamaCppRepo,
} from '../../shared/llamaCpp.js';
import type { IpcHandlerRegistry } from '../maker-ipc/ipcHandlerRegistry.js';
import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { onQuit } from '../lifecycle.js';
import type { LocalModelHandlerDeps } from './ipc.js';
import { getManagedLlamaCppService, type LlamaCppService } from './llamaCppService.js';
import { resolveHfRepository, selectGgufShards } from './llamaCppDownloads.js';
import { ensureManagedLlamaCppProvider } from './managedLlamaCppProvider.js';
import { resolveLlamaCppCatalog, resolveLlamaCppModelLists } from '../../shared/llamaCppCatalog.js';
import { getActiveCatalog, getActiveLocalModelCatalog } from '../maker-host/active-catalog.js';
import { customProviderExists } from '../maker-host/custom-provider-store.js';

export function registerLlamaCppHandlers(
  registry: IpcHandlerRegistry,
  deps: Pick<
    LocalModelHandlerDeps,
    'assertTrustedSender' | 'refreshCatalog' | 'broadcastChanged' | 'currentOwnerSession'
  > & { userDataDir: string; service?: LlamaCppService; getLocalCatalog?: () => unknown },
) {
  const service = deps.service ?? getManagedLlamaCppService(deps.userDataDir);
  onQuit('llamacpp-sidecar', () => service.dispose(), 'async');
  const handle = (channel: string, fn: (...args: unknown[]) => unknown | Promise<unknown>) =>
    registry.handle(channel, async (event, ...args) => {
      deps.assertTrustedSender(event);
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError')
          throwIpcError('PRECONDITION_FAILED', 'OPERATION_CANCELLED');
        const message = error instanceof Error ? error.message : '';
        const known = [
          'BUSY',
          'RUNTIME_OWNED_ELSEWHERE',
          'DISK_SPACE',
          'UNSUPPORTED',
          'INVALID_MODEL',
          'MODEL_NOT_FOUND',
          'MODEL_INCOMPLETE',
          'DOWNLOAD_CHECKSUM',
          'RELEASE_UNAVAILABLE',
          'PORT_CONFLICT',
          'NOT_INSTALLED',
          'START_FAILED',
          'START_TIMEOUT',
          'STOP_TIMEOUT',
          'PROVIDER_CONFLICT',
          'OWNER_CHANGED',
        ];
        throwIpcError(
          message === 'INVALID_MODEL' ? 'INVALID_PARAMS' : 'PRECONDITION_FAILED',
          known.includes(message) ? message : 'LLAMACPP_OPERATION_FAILED',
        );
      }
    });
  const captureOwner = () => {
    const owner = deps.currentOwnerSession?.();
    return () => {
      const now = deps.currentOwnerSession?.();
      return now?.dataOwnerId === owner?.dataOwnerId && now?.generation === owner?.generation;
    };
  };
  const publishModels = async (active: () => boolean) => {
    await ensureManagedLlamaCppProvider(
      (await service.snapshot()).models,
      active,
      resolveLlamaCppCatalog((deps.getLocalCatalog ?? getActiveLocalModelCatalog)()),
    );
    await deps.refreshCatalog();
    deps.broadcastChanged();
  };
  handle(MAKER_INVOKE.LLAMACPP_ENSURE, async () => {
    const active = captureOwner();
    await ensureManagedLlamaCppProvider(undefined, active);
    await deps.refreshCatalog();
    deps.broadcastChanged();
  });
  handle(MAKER_INVOKE.LLAMACPP_STATUS, async () => {
    const active = captureOwner();
    const snapshot = await service.snapshot();
    // Installed files are device-wide; repair only an existing current-owner
    // connection after account switches or a missed completion notification.
    const changed = await ensureManagedLlamaCppProvider(
      snapshot.models,
      active,
      resolveLlamaCppCatalog((deps.getLocalCatalog ?? getActiveLocalModelCatalog)()),
    );
    if (!active()) throw new Error('OWNER_CHANGED');
    // A failed catalog refresh clears its in-memory custom providers even when
    // persistence succeeded. Reconcile that absence on the existing poll, using
    // current state rather than a separate dirty flag or retry lifecycle.
    const missingFromCatalog = !getActiveCatalog().providers.some(
      (provider) => provider.id === MANAGED_LLAMACPP_PROVIDER_ID,
    );
    if (
      changed ||
      (missingFromCatalog && (await customProviderExists(MANAGED_LLAMACPP_PROVIDER_ID)))
    ) {
      if (!active()) throw new Error('OWNER_CHANGED');
      await deps.refreshCatalog();
      if (!active()) throw new Error('OWNER_CHANGED');
      deps.broadcastChanged();
    }
    const lists = resolveLlamaCppModelLists(
      { platform: process.platform, arch: process.arch, totalmemBytes: os.totalmem() },
      (deps.getLocalCatalog ?? getActiveLocalModelCatalog)(),
    );
    return {
      ...snapshot,
      ...lists,
      recommendation: { ...lists.recommendation, chip: os.cpus()[0]?.model },
    };
  });
  handle(MAKER_INVOKE.LLAMACPP_INSTALL, () => service.install());
  handle(MAKER_INVOKE.LLAMACPP_FILES, async (repo) => {
    if (!validLlamaCppRepo(repo)) throw new Error('INVALID_MODEL');
    const result = await resolveHfRepository(repo, AbortSignal.timeout(30_000));
    return result.files
      .filter(
        (f) => !/-\d{5}-of-\d{5}\.gguf$/.test(f.name) || /-00001-of-\d{5}\.gguf$/.test(f.name),
      )
      .map(({ name }) => ({
        name,
        size: selectGgufShards(result.files, name).reduce((sum, shard) => sum + shard.size, 0),
      }));
  });
  handle(MAKER_INVOKE.LLAMACPP_DOWNLOAD, async (input) => {
    const value = input as { repo?: unknown; file?: unknown } | null;
    if (!value || !validLlamaCppRepo(value.repo) || !validLlamaCppFile(value.file))
      throw new Error('INVALID_MODEL');
    const active = captureOwner();
    await service.download({ repo: value.repo, file: value.file });
    // Publish immediately, like Ollama. A running router applies new models only
    // after an explicit restart; downloading must not interrupt another task.
    await publishModels(active);
  });
  handle(MAKER_INVOKE.LLAMACPP_START, async () => {
    const active = captureOwner();
    await service.start(true);
    await publishModels(active);
  });
  handle(MAKER_INVOKE.LLAMACPP_STOP, () => service.stop());
  handle(MAKER_INVOKE.LLAMACPP_CANCEL, (action = 'cancel') => {
    if (action === 'pause') return service.pause();
    if (action === 'resume') return service.resume();
    if (action === 'cancel') return service.cancel();
    throw new Error('INVALID_MODEL');
  });
}
