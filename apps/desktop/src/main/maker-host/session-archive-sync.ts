import { createSessionArchiveSync as createSharedArchiveSync } from '@cindy/app-runtime/nativeSessionArchiveSync';
import { withSessionRouteLocks } from '../localDb/sessionRouteLock.js';
export { prepareArchiveSessions } from '@cindy/app-runtime/nativeSessionArchiveSync';
export type { ArchiveSessionRow } from '@cindy/app-runtime/nativeSessionArchiveSync';
export function createSessionArchiveSync(deps: Omit<Parameters<typeof createSharedArchiveSync>[0], 'withSessionRouteLocks'>) {
 return createSharedArchiveSync({ ...deps, withSessionRouteLocks: (...args) => withSessionRouteLocks(...args) });
}
