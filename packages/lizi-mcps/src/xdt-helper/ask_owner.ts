import type { Session } from '@cindy/maker-core';
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

/**
 * ask_owner: the one entry the model uses whenever the owner has to do something
 * before the agent can go on: pick an option, type what only they may, scan a
 * sign-in QR code, or connect an account. It replaces ask_user_question_async
 * (same choice cards, same lifecycle) and is the listed way to reach input
 * handoff and Grok sign-in; their old names stay callable but unlisted.
 *
 * It is a dedicated top-level tool, never an alias behind call_tool, so native
 * Claude can enforce root-only provenance before MCP dispatch.
 */

export const ASK_OWNER_TOOL_NAME = 'ask_owner';

export type AskUserQuestionAsyncCallback = (
  context: LiziMcpSessionContext,
  questions: Parameters<Session['askUserQuestionAsync']>[0],
) => string;

export type AskOwnerKind = 'choose' | 'fill' | 'scan' | 'connect';
const ALL_KINDS: readonly AskOwnerKind[] = ['choose', 'fill', 'scan', 'connect'];

export interface AskOwnerDeps {
  ask?: AskUserQuestionAsyncCallback;
  inputHandoff?: InputHandoffCallbacks;
  grokLogin?: GrokLoginCallbacks;
}

/** Which helper categories the current task may use (null: all). */
export type AskOwnerSurface = ReadonlySet<string> | null;

// Codex owns choices through its native protocol (request_user_input and async
// questions). Offering this second path there would give the same card two
// independent lifecycle owners.
export function supportsOwnerChoice(context: LiziMcpSessionContext): boolean {
  return context.agentKind === 'claude-code' || context.agentKind === 'pi';
}

/** Kinds this task can use right now: by harness, by its helper surface, and by what the host wired. */
export function askOwnerKinds(
  context: LiziMcpSessionContext,
  deps: AskOwnerDeps,
  surface: AskOwnerSurface,
): AskOwnerKind[] {
  const allowed = (category: string) => !surface || surface.has(category);
  return ALL_KINDS.filter((kind) => {
    if (kind === 'choose') return !!deps.ask && supportsOwnerChoice(context) && allowed('cindy');
    if (kind === 'connect') return !!deps.grokLogin && allowed('auth');
    // Handoff reads a window on this computer; an SSH workspace has none here.
    return !!deps.inputHandoff && allowed('auth') && !context.remoteHostId;
  });
}

const QUESTIONS = z.array(z.object({
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(256),
    description: z.string().max(1000).optional(),
  }).strict()).min(2).max(6).optional(),
}).strict()).min(1).max(3).refine(
  (questions) => new Set(questions.map((q) => q.question)).size === questions.length,
  'Questions must be distinct',
);

/** The input shape for the given kinds. Calls are always validated against the full shape. */
export function askOwnerInputShape(kinds: readonly AskOwnerKind[] = ALL_KINDS) {
  const choose = kinds.includes('choose');
  const handoff = kinds.includes('fill') || kinds.includes('scan');
  return {
    kind: z.enum(kinds as [AskOwnerKind, ...AskOwnerKind[]]).describe('What the owner should do.'),
    ...(choose ? {
      questions: QUESTIONS.optional().describe('choose: 1-3 questions, each with 2-6 options; put the recommended option first.'),
    } : {}),
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
    'Ask the owner (the person you work for) to do something you cannot do yourself, instead of asking in chat. '
      + 'Returns a receipt at once; the answer or outcome arrives later as a message in this task.',
  ];
  if (kinds.includes('choose')) {
    lines.push('- choose: they pick between options in a card while you keep working. Unanswered questions expire when '
      + 'your execution ends; never guess the choice. Use your synchronous question tool when work must wait for the answer. '
      + 'For a free-form answer, just ask in your reply.');
  } else if (context.agentKind === 'codex') {
    lines.push('- For choices between options, use your own question tool (request_user_input).');
  }
  if (kinds.includes('fill')) {
    lines.push('- fill: they type what only they may (a sign-in name, password, verification code, or personal details you do not know) '
      + 'into fields of a window on this computer (`target`). Cindy types it in and presses the page\'s own button; you never see the values. '
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
    lines.push('Never ask for passwords, codes or QR scans in chat or in a question. While a fill or scan is pending, '
      + 'do not touch that window. Terminal password prompts (sudo -A, ssh, git over HTTPS) ask the owner automatically.');
  }
  return lines.join('\n');
}

const missing = (kind: AskOwnerKind, field: string, hint: string) =>
  errorPayload('INVALID_ARGS', `kind="${kind}" needs \`${field}\`: ${hint}`);

type AskOwnerArgs = {
  kind: AskOwnerKind;
  questions?: z.infer<typeof QUESTIONS>;
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
    if (args.kind === 'choose' && !supportsOwnerChoice(context))
      return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Use your native question tool for choices.');
    if ((args.kind === 'fill' || args.kind === 'scan') && context.remoteHostId)
      return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Input handoff only works for windows on this computer. Tell the owner what is needed instead.');
    return errorPayload('CAPABILITY_NOT_AVAILABLE', `kind="${args.kind}" is not available in this task.`);
  }

  if (args.kind === 'choose') {
    if (!args.questions) return missing('choose', 'questions', '1-3 questions with 2-6 options each.');
    if (context.mcpCallerKind !== 'root' || context.mcpCallerAttested !== true) {
      return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to relay the question.');
    }
    try {
      const requestId = deps.ask!(context, args.questions);
      return okPayload({ request_id: requestId, status: 'pending' });
    } catch {
      return errorPayload('QUESTION_UNAVAILABLE', 'No active task with question UI and same-turn input support.');
    }
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
