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
    description: "Create a new Cindy Bot teammate directly when the user asks for one. Do not write a template file or tell the user to create it manually. Use the official default model and an empty capability grant; the user can customize the profile later. Include a short natural first greeting in the user's language. The returned bot id is immediately usable as send_to_agent target_id; creation alone does not start hidden work.",
    inputShape: {
      name: z.string().min(1).max(200).describe('Display name for the new teammate.'),
      description: z.string().min(1).max(4000).describe('Short role and purpose.'),
      identity_source: z.string().min(1).max(12000).describe('Concise identity instructions for the teammate.'),
      welcome_message: z.string().min(1).max(4000).describe('Short first greeting in the user\'s language.'),
    },
    handler: async ({ name, description, identity_source, welcome_message }: {
      name: string;
      description: string;
      identity_source: string;
      welcome_message: string;
    }) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) {
        return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定 Cindy 伙伴任务。');
      }
      const result = await deps.callbacks.create({
        callerSessionId,
        name: name.trim(),
        description: description.trim(),
        identitySource: identity_source.trim(),
        welcomeMessage: welcome_message.trim(),
      });
      return result.ok
        ? okPayload({ action: 'created', bot: result.bot })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
