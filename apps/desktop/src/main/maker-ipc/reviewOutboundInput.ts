import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { parseAttachmentOssRef, parsePeerAttachmentRef } from '@cindy/device-link';
import { isReviewSensitiveCredentialPath } from '@cindy/maker-core';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  assertReviewExplicitPathGranted,
  assertReviewInlineAttachmentGranted,
  authorizeReviewExplicitArtifacts,
  ReviewArtifactAuthorizationError,
  type ReviewArtifactConfirmationItem,
} from '../reviewer/reviewArtifactAuthorization.js';
import { materializeReviewArtifactSnapshots } from '../reviewer/reviewArtifactSnapshot.js';
import type { ReviewRunOwner } from '../../shared/reviewRun.js';
import type { StartReviewRequest } from './reviewStartHandler.js';

type Confirm = (items: ReviewArtifactConfirmationItem[]) => Promise<boolean>;
interface PreparationDeps {
  owner: ReviewRunOwner;
  ensureOwnerReady(): Promise<void>;
  resolvePath: Parameters<typeof authorizeReviewExplicitArtifacts>[0]['resolvePath'];
}
let preparationDeps: PreparationDeps | undefined;
const confirmationContext = new AsyncLocalStorage<Confirm>();

export function configureOutboundReviewPreparation(deps: PreparationDeps): void {
  preparationDeps = deps;
}

/** The callback comes only from the trusted local IPC event, never the payload. */
export function withOutboundReviewConfirmation<T>(confirm: Confirm, operation: () => Promise<T>): Promise<T> {
  return confirmationContext.run(confirm, operation);
}

/** Grant and snapshot controller files before uploads erase their original provenance. */
export async function withPreparedOutboundReview<T>(
  request: StartReviewRequest,
  upload: (request: StartReviewRequest) => Promise<T>,
  deps = preparationDeps,
): Promise<T> {
  if (!request.attachments.length) return upload(request);
  // Reject the whole batch before staging can erase filenames or path provenance.
  // Cached/inline bytes may have a harmless storage path but a sensitive label.
  for (const file of request.attachments) {
    const refs = [file.url, file.path].filter((ref): ref is string => Boolean(ref));
    const names = refs.map((ref) => (parseAttachmentOssRef(ref) ?? parsePeerAttachmentRef(ref))?.originalName);
    if ([file.name, file.originalName, ...refs, ...names].some(
      (candidate) => candidate && isReviewSensitiveCredentialPath(candidate),
    )) {
      throwIpcError('PERMISSION_DENIED', 'Review refused a credential or key attachment');
    }
  }
  if (!deps) throwIpcError('PERMISSION_DENIED', 'Review attachment authorization is unavailable');
  const local = request.attachments.filter((file) => {
    const ref = file.url || file.path || '';
    return Boolean(file.base64) || !(parseAttachmentOssRef(ref) || parsePeerAttachmentRef(ref));
  });
  if (!local.length) return upload(request);
  // A remote workspace never grants access to similarly named controller paths.
  const resolvePath: PreparationDeps['resolvePath'] = async (raw, workingDir) => {
    if (!path.isAbsolute(raw) && !raw.startsWith('xdt-image://') && !raw.startsWith('cindy-media://')) return null;
    return deps.resolvePath(raw, workingDir);
  };
  const grant = await authorizeReviewExplicitArtifacts({
    workingDir: null, attachments: local, resolvePath,
    confirm: confirmationContext.getStore() ?? (async () => false),
  });
  await deps.ensureOwnerReady();
  const snapshot = await materializeReviewArtifactSnapshots({ workingDir: null, grant, owner: deps.owner });
  try {
    const attachments = await Promise.all(request.attachments.map(async (file) => {
      if (!local.includes(file)) return file;
      for (const raw of [file.url, file.path]) {
        if (!raw) continue;
        const resolved = await resolvePath(raw, '');
        if (resolved) {
          return { ...file, url: undefined, base64: undefined, path: assertReviewExplicitPathGranted(resolved.absPath, snapshot.grant) };
        }
      }
      if (file.base64) {
        assertReviewInlineAttachmentGranted(file, snapshot.grant);
        return { ...file, path: undefined, url: undefined };
      }
      throw new ReviewArtifactAuthorizationError('Review attachment has no authorized source');
    }));
    return await upload({ ...request, attachments });
  } finally {
    await snapshot.cleanup();
  }
}
