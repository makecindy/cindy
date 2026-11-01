import { z } from 'zod';
import type { XdtHelperToolRegistry, XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 代输入 (input handoff): the agent hands the fields on screen that only the
 * owner can type (sign-in name, password, verification code, text it cannot
 * know) to the owner. The owner types them from any of their devices; values
 * go straight to the host and are never returned here. A sign-in QR code is
 * handed to the owner to scan. Buttons and options stay with the agent.
 *
 * The model reaches this through `ask_owner` (kind fill / scan). The original
 * `request_input_handoff` name stays callable for saved calls but is no longer
 * listed, so the model sees one way to ask the owner.
 */

export interface InputHandoffToolRequest {
  purpose: string;
  note?: string;
  target: { app?: string; pid?: number; windowTitle?: string };
  completeWhen?: { windowClosed?: boolean; textAppears?: string; urlContains?: string };
  timeoutMinutes?: number;
}

/** A sign-in QR code the agent captured (a screenshot), not a window on this computer. */
export interface InputHandoffImageRequest {
  purpose: string;
  note?: string;
  /** A local image path (relative paths resolve against the task's folder) or a managed media URL. */
  image: string;
  timeoutMinutes?: number;
}

export type InputHandoffToolResult =
  | { ok: true; requestId: string }
  | { ok: false; errorCode: string; message: string };

export interface InputHandoffCallbacks {
  start(context: LiziMcpSessionContext, request: InputHandoffToolRequest): Promise<InputHandoffToolResult>;
  /** Scan from a picture: Cindy reads the code itself and shows the owner where it leads. */
  startImage?(context: LiziMcpSessionContext, request: InputHandoffImageRequest): Promise<InputHandoffToolResult>;
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

export const HANDOFF_PURPOSE = STRING(200);
export const HANDOFF_NOTE = STRING(500);
export const HANDOFF_TARGET = z.object({
  app: STRING(200).optional().describe('Application name or bundle id showing the step, e.g. "Google Chrome".'),
  pid: z.number().int().positive().optional(),
  window_title: STRING(300).optional().describe('Window title, when the app has several windows.'),
}).strict();
export const HANDOFF_COMPLETE_WHEN = z.object({
  window_closed: z.boolean().optional(),
  text_appears: STRING(200).optional(),
  url_contains: STRING(500).optional(),
}).strict();
export const HANDOFF_TIMEOUT = z.number().int().min(1).max(60);

export function toHandoffTarget(target: z.infer<typeof HANDOFF_TARGET>): InputHandoffToolRequest['target'] {
  return {
    ...(target.app ? { app: target.app } : {}),
    ...(target.pid ? { pid: target.pid } : {}),
    ...(target.window_title ? { windowTitle: target.window_title } : {}),
  };
}

export function toHandoffCompleteWhen(
  completeWhen: z.infer<typeof HANDOFF_COMPLETE_WHEN> | undefined,
): Pick<InputHandoffToolRequest, 'completeWhen'> {
  if (!completeWhen) return {};
  return {
    completeWhen: {
      ...(completeWhen.window_closed !== undefined ? { windowClosed: completeWhen.window_closed } : {}),
      ...(completeWhen.text_appears ? { textAppears: completeWhen.text_appears } : {}),
      ...(completeWhen.url_contains ? { urlContains: completeWhen.url_contains } : {}),
    },
  };
}

/**
 * Shared by `ask_owner` and the legacy name: the caller checks, the start, and
 * the receipt. Failures the host can see right away come back here, not later.
 */
export async function runInputHandoff(
  context: LiziMcpSessionContext,
  start: () => Promise<InputHandoffToolResult>,
): Promise<XdtHelperToolResult> {
  if (!context.sessionId || !context.sessionInstanceId)
    return errorPayload('NO_SESSION_CONTEXT', 'No current Cindy task for this handoff.');
  if (context.remoteHostId)
    return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Input handoff only works for windows on this computer.');
  if (context.mcpCallerKind === 'descendant')
    return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to request the input handoff.');
  let result: InputHandoffToolResult;
  try {
    result = await start();
  } catch {
    return errorPayload('HANDOFF_UNAVAILABLE', 'Cindy could not start the input handoff. Tell the owner what is needed instead.');
  }
  if (!result.ok) return errorPayload(result.errorCode, result.message);
  return okPayload({
    request_id: result.requestId,
    status: 'pending',
    next: 'End your turn or do unrelated work. Do not touch that window until "[Input handoff ended]" arrives.',
  });
}

export function registerInputHandoffTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext,
  callbacks: InputHandoffCallbacks,
): void {
  registry.register({
    name: 'request_input_handoff',
    category: 'auth',
    hidden: true,
    description: DESCRIPTION,
    inputShape: {
      purpose: HANDOFF_PURPOSE.describe('One short sentence for the owner, e.g. "Sign in to Example to continue setup".'),
      note: HANDOFF_NOTE.optional().describe('Optional extra context for the owner, e.g. "I do not know which sign-in option your organization uses". Shown labelled as from you.'),
      target: HANDOFF_TARGET.describe('The window that shows the step. Omit everything to use the frontmost app.'),
      complete_when: HANDOFF_COMPLETE_WHEN.optional().describe('Optional signs that the step is done. Cindy also detects completion itself.'),
      timeout_minutes: HANDOFF_TIMEOUT.optional(),
    },
    handler: async ({ purpose, note, target, complete_when, timeout_minutes }) => {
      const context = getContext();
      return runInputHandoff(context, () => callbacks.start(context, {
        purpose,
        ...(note ? { note } : {}),
        target: toHandoffTarget(target),
        ...toHandoffCompleteWhen(complete_when),
        ...(timeout_minutes ? { timeoutMinutes: timeout_minutes } : {}),
      }));
    },
  });
}
