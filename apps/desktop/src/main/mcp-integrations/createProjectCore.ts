import { requireCanonicalProjectDirectory } from '../projectDirectoryValidation.js';
import { updateProjectInfo } from '../projectInfoCore.js';
import {
  validateLocalProjectDirectory,
  validateExistingLocalProjectDirectory,
} from '../projectDirectoryRoot.js';
export {
  validateLocalProjectDirectory,
  validateExistingLocalProjectDirectory,
} from '../projectDirectoryRoot.js';
import { withLocalProjectContext } from './localProjectContext.js';
export { withLocalProjectContext, type LocalProjectContext } from './localProjectContext.js';
import { upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirsCore.js';
import { restoreLocalProjectVisibility } from '../sidebarSettingsStoreCore.js';

const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });

/** Register an existing folder or use the same allocation/clone flow as the project form. */
export async function createProject({
  callerSessionId,
  workingDir,
  name,
  repositoryUrl,
  icon,
  directories,
}: {
  callerSessionId: string;
  workingDir?: string;
  name?: string;
  repositoryUrl?: string;
  icon?: string | null;
  directories?: Array<{ path: string; access: 'read' | 'write' }>;
}) {
  if (
    !workingDir ||
    repositoryUrl ||
    name !== undefined ||
    icon !== undefined ||
    directories !== undefined
  ) {
    return withLocalProjectContext(callerSessionId, async ({ owner, assertCurrent }) => {
      assertCurrent();
      const result = await updateProjectInfo(
        {
          ...owner,
          create: true,
          projectKey: `local:${workingDir ?? ''}`,
          repositoryUrl,
          field: 'profile',
          value: {
            ...(name !== undefined ? { name } : {}),
            ...(icon !== undefined ? { icon } : {}),
            ...(directories !== undefined ? { directories } : {}),
          },
        },
        { kind: 'host', assertCurrent },
      );
      if (!result.createdProjectKey?.startsWith('local:'))
        return fail('INTERNAL', 'Project creation result unavailable.');
      return { ok: true as const, workingDir: result.createdProjectKey.slice(6) };
    });
  }
  const directory = validateLocalProjectDirectory(workingDir);
  if (!directory.ok) return directory;
  return withLocalProjectContext(callerSessionId, async ({ client, owner, assertCurrent }) => {
    const physicalDirectory = await validateExistingLocalProjectDirectory(directory.workingDir);
    if (!physicalDirectory.ok) return physicalDirectory;
    requireCanonicalProjectDirectory(directory.workingDir, physicalDirectory.workingDir);
    assertCurrent();
    if (!(await upsertRecentWorkdir(directory.workingDir, Date.now(), process.platform, client))) {
      return fail('INTERNAL', 'Could not register the project directory.');
    }
    assertCurrent();
    await restoreLocalProjectVisibility(directory.workingDir, owner);
    assertCurrent();
    return directory;
  });
}
