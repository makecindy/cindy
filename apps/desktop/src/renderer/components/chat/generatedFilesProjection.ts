import { collectGeneratedFiles, type GeneratedFileRef } from '@/lib/generatedFiles';
import { createMessageProjectionCache } from './messageProjectionCache';

type Messages = Parameters<typeof collectGeneratedFiles>[0];
const project = createMessageProjectionCache<Messages[number], GeneratedFileRef[]>();

/**
 * History snapshots use immutable message objects, but turn slices are fresh arrays.
 * Reuse expensive tool/result parsing across slices and view mounts. A changed row,
 * its order, or working directory invalidates the projection; file existence and
 * permissions are still checked by the card against the current host.
 */
export function collectCachedGeneratedFiles(messages: Messages, workingDir: string) {
  if (messages.length === 0) return [];
  return project(messages[0], [workingDir, messages.length, ...messages], () =>
    collectGeneratedFiles(messages, workingDir),
  );
}
