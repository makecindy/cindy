import {
  createLlamaCppRuntime,
  type LlamaCppService,
} from '@cindy/model-providers/local-runtime/llamaCppService';
import {
  downloadLlamaCppAsset,
  resolveHfRepository,
  resolveLlamaCppRelease,
} from './llamaCppDownloads.js';
import { readModelContextLimits } from '../maker-host/model-context-limit-store.js';
import { assertManagedLlamaCppProvider } from './managedLlamaCppProvider.js';
import { killProcessTree } from '../scheduler-host/proc-util.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import {
  startReviewOwnerLiveness,
  probeReviewOwnerLiveness,
} from '../reviewer/reviewOwnerLiveness.js';
export * from '@cindy/model-providers/local-runtime/llamaCppService';
export const { createLlamaCppService } = createLlamaCppRuntime({
  downloadLlamaCppAsset,
  resolveHfRepository,
  resolveLlamaCppRelease,
  killProcessTree,
  withCrossProcessLock,
  startReviewOwnerLiveness,
  probeReviewOwnerLiveness,
});
let current: LlamaCppService | undefined;
export function getManagedLlamaCppService(userDataDir: string): LlamaCppService {
  return (current ??= createLlamaCppService(
    userDataDir,
    readModelContextLimits,
    assertManagedLlamaCppProvider,
  ));
}
/** Deletion must not create a runtime merely to stop it. */
export async function stopManagedLlamaCppService(
  deleteConnection: () => Promise<void>,
): Promise<void> {
  if (!current) throw new Error('BUSY');
  await current.remove(deleteConnection);
}
