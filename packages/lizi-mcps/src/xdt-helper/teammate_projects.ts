import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * A teammate's linked projects (context only). The host derives the teammate from the caller
 * session (any of its lanes on this computer) and never accepts a botId from the model.
 */
export type TeammateProjectsCallback = (params: {
  callerSessionId: string; projectId?: string; linked?: boolean; includeAvailable?: boolean;
}) => Promise<ControlResult<{ projects: Array<Record<string, unknown>> }, string>>;

export interface TeammateProjectToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  projects: TeammateProjectsCallback;
}

function missingSession() {
  return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴主任务。');
}

export function registerTeammateProjectTools(registry: XdtHelperToolRegistry, deps: TeammateProjectToolDeps): void {
  const callerSessionId = () => deps.getSessionContext().sessionId ?? null;
  const { projects } = deps;
  registry.register({
    name: 'list_teammate_projects', category: 'bots',
    description: 'List your linked projects with their computer, directory and availability. Read relevant project instructions and materials on demand with your file tools; keep project knowledge in its existing location, not your personal memory. Foreign-computer paths must not be read locally. include_available also lists local registered projects you can link. This does not read project contents, assign tasks, authorize repository changes or start background work.',
    inputShape: { include_available: z.boolean().optional() },
    handler: async ({ include_available }) => {
      const id = callerSessionId(); if (!id) return missingSession();
      const result = await projects({ callerSessionId: id, includeAvailable: include_available });
      return result.ok ? okPayload({ projects: result.projects }) : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: 'set_teammate_project', category: 'bots',
    description: 'Link or unlink one project in your own teammate settings when the owner requests it. Use the project_id from list_teammate_projects(include_available=true). Unlinking preserves files, project registration, memory and task history. Linking is context only, not authorization to edit a repository, contact tasks or scan in the background.',
    inputShape: { project_id: z.string().regex(/^[a-f0-9]{64}$/), linked: z.boolean() },
    handler: async ({ project_id, linked }) => {
      const id = callerSessionId(); if (!id) return missingSession();
      const result = await projects({ callerSessionId: id, projectId: project_id, linked });
      return result.ok ? okPayload({ projects: result.projects }) : errorPayload(result.errorCode, result.message);
    },
  });
}
