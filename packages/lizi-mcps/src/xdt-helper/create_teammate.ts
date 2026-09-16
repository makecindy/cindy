import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';

import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface CreateTeammateCallbacks {
  create(params: {
    callerSessionId: string;
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
    description: "Create a new Cindy Bot teammate directly when the user asks for one. Do not write a template file or tell the user to create it manually. Only a name is required. Follow the user’s Cindy default model chain and shared Bot baseline. Leave unspecified identity details open; the new teammate speaks for itself using its own runtime and memory. The returned bot id is immediately usable as send_to_agent target_id; creation alone does not start hidden work.",
    inputShape: {
      name: z.string().min(1).max(200).describe('Display name for the new teammate.'),
      description: z.string().max(4000).optional().describe('Role or purpose, only if the user supplied it.'),
      identity_source: z.string().max(12000).optional().describe('Identity details explicitly requested by the user.'),
      welcome_message: z.string().max(4000).optional().describe('Legacy field; ignored. The new teammate generates its own greeting.'),
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
      const result = await deps.callbacks.create({
        callerSessionId,
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
