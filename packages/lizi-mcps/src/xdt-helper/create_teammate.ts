import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';

import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface CreateTeammateCallbacks {
  create(params: {
    callerSessionId: string;
    callerSessionInstanceId?: string;
    name: string;
    description: string;
    identitySource: string;
    welcomeMessage: string;
    avatar?: string;
    avatarColor?: string;
    gender?: 'female' | 'male';
    userContextSource?: string;
  }): Promise<ControlResult<{ bot: { id: string; name: string; description: string } }, string>>;
  setAvatar?(params: {
    callerSessionId: string;
    callerSessionInstanceId?: string;
    expectedVersion: number;
    avatar: string;
  }): Promise<ControlResult<{ effective: 'next-turn' }, string>>;
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
      avatar: z.string().min(1).max(2048).optional().describe('A single emoji, built-in cindy://avatar/ preset, local image path, managed image reference, or public HTTPS image URL.'),
      avatar_color: z.enum(['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink', 'graphite']).optional(),
      gender: z.enum(['female', 'male']).optional(),
      user_context_source: z.string().max(12000).optional().describe('What the user explicitly wants this teammate to know about them.'),
    },
    handler: async ({ name, description, identity_source, avatar, avatar_color, gender, user_context_source }: {
      name: string;
      description?: string;
      identity_source?: string;
      welcome_message?: string;
      avatar?: string;
      avatar_color?: string;
      gender?: 'female' | 'male';
      user_context_source?: string;
    }) => {
      const { sessionId: callerSessionId, sessionInstanceId: callerSessionInstanceId } = deps.getSessionContext();
      if (!callerSessionId) {
        return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定 Cindy 伙伴任务。');
      }
      const result = await deps.callbacks.create({
        callerSessionId,
        ...(callerSessionInstanceId ? { callerSessionInstanceId } : {}),
        name: name.trim(),
        description: description?.trim() ?? '',
        identitySource: identity_source?.trim() ?? '',
        welcomeMessage: '',
        ...(avatar !== undefined ? { avatar } : {}),
        ...(avatar_color !== undefined ? { avatarColor: avatar_color } : {}),
        ...(gender !== undefined ? { gender } : {}),
        ...(user_context_source !== undefined ? { userContextSource: user_context_source } : {}),
      });
      return result.ok
        ? okPayload({ action: 'created', bot: result.bot })
        : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.setAvatar) registry.register({
    name: 'set_teammate_avatar',
    category: 'bots',
    description: 'Change your own teammate avatar to a single emoji, built-in cindy://avatar/ preset, local image path, managed image reference, or public HTTPS image URL. Read get_teammate_state first for the current profile version. Images are copied into Cindy media storage; this cannot change another teammate.',
    inputShape: {
      expectedVersion: z.number().int().positive(),
      avatar: z.string().min(1).max(2048),
    },
    handler: async ({ expectedVersion, avatar }) => {
      const { sessionId: callerSessionId, sessionInstanceId: callerSessionInstanceId } = deps.getSessionContext();
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定 Cindy 伙伴任务。');
      const result = await deps.callbacks.setAvatar!({ callerSessionId,
        ...(callerSessionInstanceId ? { callerSessionInstanceId } : {}), expectedVersion, avatar });
      return result.ok ? okPayload({ effective: result.effective }) : errorPayload(result.errorCode, result.message);
    },
  });
}
