import path from 'node:path';
import type { ProjectDirectory } from '@cindy/maker-shared/project-alias-sync';
import type { DataOwnerPushStamp } from '../shared/dataOwnerPush.js';
import {
  consumeWritableDirectoryPickerGrants,
  WritableDirectoryPickerGrantError,
} from './maker-ipc/writableDirectoryPickerGrant.js';
import { throwIpcError } from './utils/ipcValidate.js';

/** Supplied by the transport/tool adapter, never deserialized from request data. */
export type ProjectInfoAuthorization =
  | { kind: 'host'; assertCurrent?: () => void }
  | { kind: 'renderer'; senderId: number; scope: unknown };

/** A form's picker evidence cannot survive an account switch, even in the same window. */
export function projectDirectoryGrantScope(owner: DataOwnerPushStamp, scope: unknown): string {
  if (typeof scope !== 'string' || !scope || scope.length > 128)
    throwIpcError(
      'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
      'Select the project directory again.',
    );
  return JSON.stringify(['project', owner.dataOwnerId, owner.ownerGeneration, scope]);
}

/** Compare access as well as paths: retaining read access cannot authorize a write upgrade. */
export async function authorizeProjectDirectoryChanges(input: {
  projectKey: string;
  requested: readonly ProjectDirectory[];
  previous: readonly ProjectDirectory[];
  owner: DataOwnerPushStamp;
  authorization?: ProjectInfoAuthorization;
}): Promise<void> {
  const remote = input.projectKey.startsWith('remote:');
  const paths = remote ? path.posix : path;
  const key = (value: string) => {
    const normalized = paths.normalize(value);
    return !remote && process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const additions = input.requested.filter(
    (next) =>
      !input.previous.some(
        (previous) =>
          key(previous.path) === key(next.path) &&
          (previous.access === 'write' || next.access === 'read'),
      ),
  );
  if (!additions.length) return;
  const authorization = input.authorization;
  if (!authorization)
    throwIpcError(
      'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
      'Project directory access was not authorized.',
    );
  if (authorization.kind === 'host') {
    authorization.assertCurrent?.();
    return;
  }
  // SSH directory browsing already runs through the configured host's authority.
  // Never interpret an SSH path as a local filesystem picker grant.
  if (remote) return;
  try {
    await consumeWritableDirectoryPickerGrants({
      scopeId: projectDirectoryGrantScope(input.owner, authorization.scope),
      senderId: authorization.senderId,
      requestedDirs: additions.map((item) => item.path),
      previousDirs: [],
    });
  } catch (error) {
    if (error instanceof WritableDirectoryPickerGrantError)
      throwIpcError(error.code, error.message);
    throw error;
  }
}
