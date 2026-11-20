import { sameProjectDirectory } from './projectDirectoryValidation.js';
import type { ProjectDirectory } from '@cindy/maker-shared/project-alias-sync';
import type { DataOwnerPushStamp } from '../shared/dataOwnerPush.js';
import {
  consumeWritableDirectoryPickerGrants,
  WritableDirectoryPickerGrantError,
} from './maker-ipc/writableDirectoryPickerGrant.js';
import { throwIpcError } from './utils/ipcValidate.js';

export type ProjectConfirmation =
  | { kind: 'repository'; url: string; directory: string }
  | { kind: 'ssh'; host: string; project: string; directories: readonly ProjectDirectory[] };

export interface ProjectPickerSelection {
  requestedDirs: string[];
  projectPaths: string[];
  checkOnly?: boolean;
}

export type ProjectRendererCheck =
  { kind: 'picker'; selection: ProjectPickerSelection } | ProjectConfirmation;

/** Supplied by the transport/tool adapter, never deserialized from request data. */
export type ProjectInfoAuthorization =
  | { kind: 'host'; assertCurrent?: () => void }
  | {
      kind: 'renderer';
      assertCurrent?: () => void;
      check: (request: ProjectRendererCheck, signal?: AbortSignal) => Promise<void>;
    };

/** A form's picker evidence cannot survive an account switch, even in the same window. */
export function projectDirectoryGrantScope(owner: DataOwnerPushStamp, scope: unknown): string {
  if (typeof scope !== 'string' || !scope || scope.length > 128)
    throwIpcError(
      'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
      'Select the project directory again.',
    );
  return JSON.stringify(['project', owner.dataOwnerId, owner.ownerGeneration, scope]);
}

/** A retained read grant does not cover a write upgrade. */
export function newProjectDirectoryAccess(
  requested: readonly ProjectDirectory[],
  previous: readonly ProjectDirectory[],
  remote: boolean,
): ProjectDirectory[] {
  return requested.filter(
    (next) =>
      !previous.some(
        (prior) =>
          sameProjectDirectory(prior.path, next.path, remote) &&
          (prior.access === 'write' || next.access === 'read'),
      ),
  );
}

export async function authorizeProjectDirectoryChanges(input: {
  projectKey: string;
  requested: readonly ProjectDirectory[];
  previous: readonly ProjectDirectory[];
  authorization?: ProjectInfoAuthorization;
  confirmedSsh?: readonly ProjectDirectory[];
  checkOnly?: boolean;
}): Promise<void> {
  const remote = input.projectKey.startsWith('remote:');
  const additions = newProjectDirectoryAccess(input.requested, input.previous, remote);
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
  if (remote) {
    if (newProjectDirectoryAccess(additions, input.confirmedSsh ?? [], true).length)
      throwIpcError(
        'WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED',
        'Confirm the remote project directories again.',
      );
    return;
  }
  await authorization.check({
    kind: 'picker',
    selection: {
      requestedDirs: additions.map((item) => item.path),
      projectPaths: [
        ...(input.projectKey === 'local:' ? [] : [input.projectKey.slice(6)]),
        ...input.requested.map((item) => item.path),
      ],
      checkOnly: input.checkOnly,
    },
  });
}

/** Only Main has the window identity, the native picker ledger and the native sheet. */
export function projectRendererAuthorization(
  senderId: number,
  scope: unknown,
  owner: DataOwnerPushStamp,
  confirm: (intent: ProjectConfirmation, signal?: AbortSignal) => Promise<void>,
  assertCurrent: () => void,
): Extract<ProjectInfoAuthorization, { kind: 'renderer' }> {
  return {
    kind: 'renderer',
    assertCurrent,
    async check(request, signal) {
      signal?.throwIfAborted();
      assertCurrent();
      if (request.kind === 'picker') {
        try {
          await consumeWritableDirectoryPickerGrants({
            ...request.selection,
            previousDirs: [],
            senderId,
            scopeId: projectDirectoryGrantScope(owner, scope),
          });
        } catch (error) {
          if (error instanceof WritableDirectoryPickerGrantError)
            throwIpcError(error.code, error.message);
          throw error;
        }
      } else {
        await confirm(request, signal);
      }
      signal?.throwIfAborted();
      assertCurrent();
    },
  };
}
