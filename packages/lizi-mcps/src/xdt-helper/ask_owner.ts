import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry, XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';
import type { GrokLoginCallbacks } from './grok_login.js';
import {
  HANDOFF_COMPLETE_WHEN,
  HANDOFF_NOTE,
  HANDOFF_PURPOSE,
  HANDOFF_TARGET,
  HANDOFF_TIMEOUT,
  runInputHandoff,
  toHandoffCompleteWhen,
  toHandoffTarget,
  type InputHandoffCallbacks,
} from './input_handoff.js';

/** User-operated sign-in, secret input, QR scans and account connections.
 * Ordinary questions use ask_user_question_async or the harness's synchronous tool.
 */
export const ASK_OWNER_TOOL_NAME = 'ask_owner';

export type AskOwnerKind = 'fill' | 'scan' | 'connect';
const ALL_KINDS: readonly AskOwnerKind[] = ['fill', 'scan', 'connect'];

export interface AskOwnerDeps {
  inputHandoff?: InputHandoffCallbacks;
  grokLogin?: GrokLoginCallbacks;
}

/** Which helper categories the current task may use (null: all). */
export type AskOwnerSurface = ReadonlySet<string> | null;

/** Kinds this task can use right now: by harness, by its helper surface, and by what the host wired. */
export function askOwnerKinds(
  context: LiziMcpSessionContext,
  deps: AskOwnerDeps,
  surface: AskOwnerSurface,
): AskOwnerKind[] {
  const allowed = (category: string) => !surface || surface.has(category);
  return ALL_KINDS.filter((kind) => {
    if (kind === 'connect') return !!deps.grokLogin && allowed('auth');
    // Handoff reads a window on this computer; an SSH workspace has none here.
    return !!deps.inputHandoff && allowed('auth') && !context.remoteHostId;
  });
}

/** The input shape for the given kinds. Calls are always validated against the full shape. */
export function askOwnerInputShape(kinds: readonly AskOwnerKind[] = ALL_KINDS) {
  const handoff = kinds.includes('fill') || kinds.includes('scan');
  return {
    kind: z.enum(kinds as [AskOwnerKind, ...AskOwnerKind[]]).describe('What the user should do.'),
    ...(handoff ? {
      title: HANDOFF_PURPOSE.optional().describe('fill / scan: one short sentence for the owner, e.g. "Sign in to Feishu to continue testing".'),
      note: HANDOFF_NOTE.optional().describe('fill / scan: optional extra context for the owner, shown labelled as from you.'),
      target: HANDOFF_TARGET.optional().describe('fill / scan: the window on this computer that shows the step.'),
      complete_when: HANDOFF_COMPLETE_WHEN.optional().describe('fill / scan: optional signs that the step is done. Cindy also detects completion itself.'),
      timeout_minutes: HANDOFF_TIMEOUT.optional(),
    } : {}),
    ...(kinds.includes('scan') ? {
      image: z.string().trim().min(1).max(4096).optional().describe(
        'scan: a screenshot that shows the QR code (an image file path, relative to the task folder or absolute, or a cindy-media:// URL). Use it when the code is not in a window on this computer.',
      ),
    } : {}),
    ...(kinds.includes('connect') ? {
      service: z.enum(['grok']).optional().describe('connect: the account to connect.'),
    } : {}),
  };
}

export function askOwnerDescription(kinds: readonly AskOwnerKind[], context: Pick<LiziMcpSessionContext, 'agentKind'>): string {
  const lines = [
    'Ask the user to complete a sign-in, enter a secret, scan a sign-in QR code or connect an account. Ordinary questions belong in your question tools. '
      + 'Returns a receipt at once; the answer or outcome arrives later as a message in this task.',
  ];
  if (context.agentKind === 'codex') {
    lines.push('- For questions, use your native question tools.');
  } else {
    lines.push('- For optional questions, use ask_user_question_async; use your synchronous question tool when work must wait.');
  }
  if (kinds.includes('fill')) {
    lines.push('- fill: only for what you must never see, in a window on this computer (`target`): a sign-in, or a password, API key, token or verification code. '
      + 'The owner does a sign-in on the window itself; other secret fields get a form, and Cindy types the answer in. You never see the values. '
      + 'Anything else the owner can tell you (an email address, a name, a street address) is not for fill: ask in your reply and enter it yourself. '
      + 'Buttons, options and consent pages are yours to handle.');
  }
  if (kinds.includes('scan')) {
    lines.push('- scan: they scan a sign-in QR code. Pass `target` when the code is in a window on this computer, or `image` '
      + '(a screenshot) when it is not, for example a device simulator shown inside Cindy. Take the screenshot right before asking; codes expire.');
  }
  if (kinds.includes('connect')) {
    lines.push('- connect: they connect an account (`service`). Plugin accounts connect through connect_account on the cindy server.');
  }
  if (kinds.includes('fill') || kinds.includes('scan')) {
    lines.push('Never ask for passwords, keys, codes or QR scans in chat or in a question. While a fill or scan is pending, '
      + 'do not touch that window. Terminal password prompts (sudo -A, ssh, git over HTTPS) ask the owner automatically.');
  }
  return lines.join('\n');
}

const missing = (kind: AskOwnerKind, field: string, hint: string) =>
  errorPayload('INVALID_ARGS', `kind="${kind}" needs \`${field}\`: ${hint}`);

type AskOwnerArgs = {
  kind: AskOwnerKind;
  title?: string;
  note?: string;
  target?: z.infer<typeof HANDOFF_TARGET>;
  complete_when?: z.infer<typeof HANDOFF_COMPLETE_WHEN>;
  timeout_minutes?: number;
  image?: string;
  service?: 'grok';
};

export async function handleAskOwner(
  args: AskOwnerArgs,
  context: LiziMcpSessionContext | undefined,
  deps: AskOwnerDeps,
  surface: AskOwnerSurface,
): Promise<XdtHelperToolResult> {
  if (!context?.sessionId || !context.sessionInstanceId) {
    return errorPayload('NO_SESSION_CONTEXT', 'No current task instance for this request.');
  }
  const kinds = askOwnerKinds(context, deps, surface);
  if (!kinds.includes(args.kind)) {
    if ((args.kind === 'fill' || args.kind === 'scan') && context.remoteHostId)
      return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Input handoff only works for windows on this computer. Tell the owner what is needed instead.');
    return errorPayload('CAPABILITY_NOT_AVAILABLE', `kind="${args.kind}" is not available in this task.`);
  }

  if (args.kind === 'connect') {
    if (!args.service) return missing('connect', 'service', 'the account to connect, e.g. "grok".');
    if (context.mcpCallerKind === 'descendant')
      return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to request the connection.');
    try {
      const state = await deps.grokLogin!.start(context);
      return okPayload({
        ...state,
        ...(state.status === 'pending' ? {
          next: 'Show the owner the sign-in page and the short code; they enter the code there. '
            + 'Check the outcome later with get_grok_login_status (call_tool).',
        } : {}),
      });
    } catch {
      return errorPayload('AUTH_FAILED', 'Could not start the Grok sign-in. Try again later.');
    }
  }

  if (!args.title) {
    return missing(args.kind, 'title', 'one short sentence telling the owner what to do and why.');
  }
  const handoff = deps.inputHandoff!;
  const common = {
    purpose: args.title,
    ...(args.note ? { note: args.note } : {}),
    ...(args.timeout_minutes ? { timeoutMinutes: args.timeout_minutes } : {}),
  };
  if (args.kind === 'scan' && args.image) {
    if (args.target) return errorPayload('INVALID_ARGS', 'Pass either `image` or `target` for kind="scan", not both.');
    if (!handoff.startImage)
      return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Scanning from a picture is not available here; pass the window as `target`.');
    return runInputHandoff(context, () => handoff.startImage!(context, { ...common, image: args.image! }));
  }
  if (!args.target) {
    return missing(args.kind, 'target', args.kind === 'scan'
      ? 'the window showing the QR code, or `image` with a screenshot of it.'
      : 'the window showing the fields, e.g. {"app":"Google Chrome"}.');
  }
  return runInputHandoff(context, () => handoff.start(context, {
    ...common,
    target: toHandoffTarget(args.target!),
    ...toHandoffCompleteWhen(args.complete_when),
  }));
}

/** Registers the validating definition (all kinds); the server lists the per-task variant. */
export function registerAskOwnerTool(
  registry: XdtHelperToolRegistry,
  getContext: () => LiziMcpSessionContext | undefined,
  deps: AskOwnerDeps,
  getSurface: () => Promise<AskOwnerSurface>,
): void {
  registry.register({
    name: ASK_OWNER_TOOL_NAME,
    category: 'cindy',
    description: askOwnerDescription(ALL_KINDS, { agentKind: 'claude-code' }),
    inputShape: askOwnerInputShape(),
    handler: async (args) => handleAskOwner(args as AskOwnerArgs, getContext(), deps, await getSurface()),
  });
}
