import { updateProjectInfo } from '../../desktop/src/main/projectInfoCore.js';
import type { ProjectInfoAuthorization } from '../../desktop/src/main/projectInfoAuthorization.js';
import { throwIpcError } from '../../desktop/src/main/utils/ipcValidate.js';
import type { createPlatformClientBridge } from './platform/client-bridge.js';

export function createHostProjectInfoUpdate(deps: {
  platform(): ReturnType<typeof createPlatformClientBridge> | null;
  profileHold(): string | null;
  changed(catalogChanged: boolean): void;
}) {
  const assertCurrent = () => {
    const held = deps.profileHold();
    if (held) throwIpcError('PRECONDITION_FAILED', held);
  };
  return async (input: unknown, source: { desktopRequest?: string; legacyDesktop?: boolean } = {}) => {
    const platform = deps.platform();
    let authorization: ProjectInfoAuthorization | undefined = { kind: 'host', assertCurrent };
    if (source.desktopRequest) {
      const requestId = source.desktopRequest;
      authorization = { kind: 'renderer', assertCurrent, async check(check) {
        if (!platform || !platform.status().attached) throw Error('Desktop project window unavailable');
        try {
          const answer = await platform.call({ method: 'project.check', requestId, check });
          if (answer !== true) throw Error('Project authorization unavailable');
        } catch (error) {
          if ((error as { code?: string }).code === 'MUTATION_CANCELLED') throw Error('[MUTATION_CANCELLED] Project action cancelled');
          throw error;
        }
      } };
    } else if (source.legacyDesktop) {
      // Legacy windows supply no project grants. Preserve that admission rule.
      authorization = undefined;
    }
    const result = await updateProjectInfo(input, authorization);
    deps.changed(!!result.createdProjectKey);
    return result;
  };
}
