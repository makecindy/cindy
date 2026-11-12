import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';

import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface CreateTeammateCallbacks {
  create(params: {
    callerSessionId: string;
    /** This turn's runtime instance; lets the host check who started the turn on IM lanes. */
    callerSessionInstanceId?: string;
    name: string;
    description: string;
    identitySource: string;
    welcomeMessage: string;
  }): Promise<ControlResult<{ bot: { id: string; name: string; description: string } }, string>>;
}

export function registerCreateTeammateTool(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    callbacks: CreateTeammateCallbacks;
  },
): void {
  registry.register({
    name: 'create_teammate',
    category: 'bots',
    description: "Create a new Cindy Bot buddy directly when the user asks for one. Do not write a template file or tell the user to create it manually. Only a name is required. Follow the user’s Cindy default model chain and shared Bot baseline. Leave unspecified identity details open; the new buddy speaks for itself using its own runtime and memory. To message it, take its main chat session_id from list_agents and use send_to_session; creation alone does not start hidden work.",
    inputShape: {
      name: z.string().min(1).max(200).describe('Display name for the new buddy.'),
      description: z.string().max(4000).optional().describe('Role or purpose, only if the user supplied it.'),
      identity_source: z.string().max(12000).optional().describe('Identity details explicitly requested by the user.'),
      welcome_message: z.string().max(4000).optional().describe('Legacy field; ignored. The new buddy generates its own greeting.'),
    },
    handler: async ({ name, description, identity_source }: {
      name: string;
      description?: string;
      identity_source?: string;
      welcome_message?: string;
    }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) {
        return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定 Cindy 伙伴任务。');
      }
      const callerSessionInstanceId = deps.getSessionContext().sessionInstanceId;
      const result = await deps.callbacks.create({
        callerSessionId,
        ...(callerSessionInstanceId ? { callerSessionInstanceId } : {}),
        name: name.trim(),
        description: description?.trim() ?? '',
        identitySource: identity_source?.trim() ?? '',
        welcomeMessage: '',
      });
      return result.ok
        ? okPayload({ action: 'created', bot: result.bot })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
