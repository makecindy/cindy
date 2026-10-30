import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 代输入 (input handoff): the agent hands the fields on screen that only the
 * owner can type (sign-in name, password, verification code, text it cannot
 * know) to the owner. The owner types them from any of their devices; values
 * go straight to the host and are never returned here. A sign-in QR code is
 * handed to the owner to scan. Buttons and options stay with the agent.
 */

export interface InputHandoffToolRequest {
  purpose: string;
  note?: string;
  target: { app?: string; pid?: number; windowTitle?: string };
  completeWhen?: { windowClosed?: boolean; textAppears?: string; urlContains?: string };
  timeoutMinutes?: number;
}

export type InputHandoffToolResult =
  | { ok: true; requestId: string }
  | { ok: false; errorCode: string; message: string };

export interface InputHandoffCallbacks {
  start(context: LiziMcpSessionContext, request: InputHandoffToolRequest): Promise<InputHandoffToolResult>;
}

const DESCRIPTION =
  'Ask the owner to type what only they can into fields on this computer\'s screen: '
  + 'a sign-in name, password, verification code, or other text you cannot know. '
  + 'Cindy shows the owner just those fields on their phone or another computer, types the answer in and confirms with the page\'s own main button; '
  + 'it follows the flow across windows and browsers while fields keep appearing. '
  + 'A sign-in QR code on screen is handed to the owner to scan, and the task continues once they are signed in. '
  + 'Buttons, options and consent pages are yours to handle: a screen with neither a field to type nor a sign-in QR code ends at once with failure nothing_to_fill. '
  + 'Do not type, click or read secrets in that window yourself while it is pending. '
  + 'Returns a pending receipt; a hidden "[Input handoff ended]" message continues this task later. '
  + 'Values the owner enters are never shared with you. One pending handoff per task. '
  + 'Not needed for terminal password prompts on macOS and Linux: in this task\'s shell, sudo (run it as `sudo -A`), '
  + 'ssh and git over HTTPS ask the owner automatically and your command simply continues.';

const STRING = (max: number) => z.string().trim().min(1).max(max);

export function registerInputHandoffTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  callbacks: InputHandoffCallbacks,
): void {
  registry.register({
    name: 'request_input_handoff',
    category: 'auth',
    description: DESCRIPTION,
    inputShape: {
      purpose: STRING(200).describe('One short sentence for the owner, e.g. "Sign in to Example to continue setup".'),
      note: STRING(500).optional().describe('Optional extra context for the owner, e.g. "I do not know which sign-in option your organization uses". Shown labelled as from you.'),
      target: z.object({
        app: STRING(200).optional().describe('Application name or bundle id showing the step, e.g. "Google Chrome".'),
        pid: z.number().int().positive().optional(),
        window_title: STRING(300).optional().describe('Window title, when the app has several windows.'),
      }).strict().describe('The window that shows the step. Omit everything to use the frontmost app.'),
      complete_when: z.object({
        window_closed: z.boolean().optional(),
        text_appears: STRING(200).optional(),
        url_contains: STRING(500).optional(),
      }).strict().optional().describe('Optional signs that the step is done. Cindy also detects completion itself.'),
      timeout_minutes: z.number().int().min(1).max(60).optional(),
    },
    handler: async ({ purpose, note, target, complete_when, timeout_minutes }) => {
      const context = getContext();
      if (!context.sessionId || !context.sessionInstanceId)
        return errorPayload('NO_SESSION_CONTEXT', 'No current Cindy task for this handoff.');
      if (context.remoteHostId)
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Input handoff only works for windows on this computer.');
      if (context.mcpCallerKind === 'descendant')
        return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to request the input handoff.');
      const request: InputHandoffToolRequest = {
        purpose,
        ...(note ? { note } : {}),
        target: {
          ...(target.app ? { app: target.app } : {}),
          ...(target.pid ? { pid: target.pid } : {}),
          ...(target.window_title ? { windowTitle: target.window_title } : {}),
        },
        ...(complete_when ? {
          completeWhen: {
            ...(complete_when.window_closed !== undefined ? { windowClosed: complete_when.window_closed } : {}),
            ...(complete_when.text_appears ? { textAppears: complete_when.text_appears } : {}),
            ...(complete_when.url_contains ? { urlContains: complete_when.url_contains } : {}),
          },
        } : {}),
        ...(timeout_minutes ? { timeoutMinutes: timeout_minutes } : {}),
      };
      let result: InputHandoffToolResult;
      try {
        result = await callbacks.start(context, request);
      } catch {
        return errorPayload('HANDOFF_UNAVAILABLE', 'Cindy could not start the input handoff. Tell the owner what is needed instead.');
      }
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({
        request_id: result.requestId,
        status: 'pending',
        next: 'End your turn or do unrelated work. Do not touch that window until "[Input handoff ended]" arrives.',
      });
    },
  });
}
