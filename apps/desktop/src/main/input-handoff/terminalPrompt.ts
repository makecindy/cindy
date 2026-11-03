import {
  validateInputHandoffSubmissionForStep,
  type InputHandoffContentType,
  type InputHandoffControl,
  type InputHandoffDecision,
  type InputHandoffHolder,
  type InputHandoffPhase,
  type InputHandoffSnapshot,
  type InputHandoffSource,
  type InputHandoffSubmission,
} from '@cindy/device-link';
import { classifyOrigin } from './originPolicy.js';
import type { HandoffEndReason, HandoffResult } from './session.js';

/**
 * 代输入 for a password prompt from a terminal program (sudo, ssh, git over
 * HTTPS). The program asked through Cindy's askpass helper; the owner's answer
 * goes straight back to that program and never to the agent, whose command is
 * still running and simply continues.
 */

export type TerminalProgram = 'sudo' | 'ssh' | 'ssh-add' | 'git';

export interface TerminalPromptStep {
  purpose: string;
  source: InputHandoffSource;
  /** One field; whatever the owner types goes back to the program as the answer. */
  controls: [Extract<InputHandoffControl, { kind: 'text' }>];
}

const FIELD_ID = 'answer';

const PROMPT_MAX = 300;
const URL_IN_PROMPT = /\bhttps?:\/\/[^\s'"]+/i;

function contentTypeFor(prompt: string, program: TerminalProgram): InputHandoffContentType {
  if (/verification code|one[- ]time|\botp\b|authenticator|token code|验证码/i.test(prompt)) return 'one-time-code';
  if (/^\s*username\b|\buser ?name for\b|^\s*login:/i.test(prompt)) return 'username';
  if (/pass(word|phrase)|\bpin\b|密码|口令/i.test(prompt) || program === 'sudo') return 'password';
  // Anything else a terminal program asks through askpass is treated as secret.
  return 'password';
}

export function buildTerminalPromptStep(rawPrompt: string, program: TerminalProgram): TerminalPromptStep {
  const prompt = rawPrompt.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, PROMPT_MAX)
    || (program === 'sudo' ? 'Password:' : 'Input:');
  const url = prompt.match(URL_IN_PROMPT)?.[0];
  const { origin, warning } = url ? classifyOrigin(url, true) : {};
  const source: InputHandoffSource = {
    app: program,
    ...(origin ? { origin } : {}),
    ...(warning ? { warning } : {}),
  };
  // ssh asks to trust an unknown host key with a typed yes/no (or the fingerprint); it is not a secret.
  const confirm = /\(yes\/no(\/\[fingerprint\])?\)\??\s*$/i.test(prompt);
  return {
    purpose: prompt,
    source,
    controls: [{
      id: FIELD_ID,
      kind: 'text',
      label: '',
      contentType: confirm ? 'text' : contentTypeFor(prompt, program),
      ...(confirm ? { placeholder: 'yes / no' } : {}),
    }],
  };
}

export interface TerminalPromptSessionOptions {
  requestId: string;
  prompt: string;
  program: TerminalProgram;
  command: string;
  requester?: string;
  timeoutMs: number;
  remoteInput: boolean;
  publish(snapshot: InputHandoffSnapshot): void;
  finish(result: HandoffResult): void;
  /** Delivers the answer to the waiting program; null makes it fail. Called once. */
  answer(value: string | null): void;
}

function sameHolder(a: InputHandoffHolder, b: InputHandoffHolder): boolean {
  return a.local === true ? b.local === true : b.local !== true && a.deviceId === b.deviceId;
}

export class TerminalPromptSession {
  private revision = 0;
  private unheldClaimFrom: number | null = null;
  private phase: InputHandoffPhase = 'ready';
  private holder: InputHandoffHolder | undefined;
  private answeredOn: InputHandoffHolder | undefined;
  private answered = false;
  private failure: HandoffResult['failure'];
  private ended = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly step: TerminalPromptStep;

  constructor(private readonly options: TerminalPromptSessionOptions) {
    this.step = buildTerminalPromptStep(options.prompt, options.program);
  }

  get requestId(): string {
    return this.options.requestId;
  }

  snapshot(): InputHandoffSnapshot {
    return {
      kind: 'input_handoff',
      requestId: this.options.requestId,
      revision: this.revision,
      phase: this.phase,
      purpose: this.step.purpose,
      ...(this.holder ? { holder: { ...this.holder } } : {}),
      ...(this.options.requester ? { requester: this.options.requester } : {}),
      command: this.options.command,
      source: this.step.source,
      stepNumber: 1,
      controls: this.phase === 'ready' ? this.step.controls : [],
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.options.remoteInput && !this.ended ? { remoteInput: true as const } : {}),
      ...(this.ended ? { terminal: true as const } : {}),
    };
  }

  isActionable(revision: number): boolean {
    return !this.ended && this.phase === 'ready' && this.acceptsRevision(revision);
  }

  /** The current revision, or the one just before this screen was taken while nobody held it (see `decide`). */
  private acceptsRevision(revision: number): boolean {
    return revision === this.revision || (this.unheldClaimFrom !== null && revision === this.unheldClaimFrom && this.revision === revision + 1);
  }

  async start(): Promise<void> {
    this.publish('ready');
    this.expiryTimer = setTimeout(() => this.end('expired', 'timeout', 'timeout'), this.options.timeoutMs);
    this.expiryTimer.unref?.();
  }

  async submit(submission: InputHandoffSubmission, actor?: InputHandoffHolder): Promise<boolean> {
    if (!this.isActionable(submission.expectedRevision)) return false;
    // The revision before a quiet claim is good only for the device that claimed.
    if (submission.expectedRevision !== this.revision && !(actor && this.holder && sameHolder(actor, this.holder))) return false;
    if (!validateInputHandoffSubmissionForStep({ ...this.snapshot(), revision: submission.expectedRevision }, submission)) return false;
    let value: string | undefined;
    try {
      value = submission.values[FIELD_ID];
      if (typeof value !== 'string' || submission.action.kind !== 'submit') return false;
      this.answeredOn = actor ?? { local: true };
      this.deliver(value);
    } finally {
      for (const key of Object.keys(submission.values)) delete submission.values[key];
      value = undefined;
    }
    this.end('succeeded', 'owner');
    return true;
  }

  async decide(decision: InputHandoffDecision, actor?: InputHandoffHolder): Promise<boolean> {
    if (this.ended || decision.expectedRevision !== this.revision) return false;
    switch (decision.action) {
      case 'cancel':
      case 'done':
        this.end('cancelled', 'cancelled');
        return true;
      case 'claim': {
        if (!actor) return false;
        if (this.holder && sameHolder(this.holder, actor)) return true;
        const unheld = this.holder ? null : this.revision;
        this.holder = actor;
        this.publish(this.phase);
        this.unheldClaimFrom = unheld;
        return true;
      }
      case 'refresh':
        this.publish(this.phase);
        return true;
      default:
        return false;
    }
  }

  cancel(reason: HandoffEndReason = 'cancelled'): void {
    this.end('cancelled', reason);
  }

  /** The asking program went away (finished, killed or timed out on its side). */
  abandon(): void {
    this.answered = true;
    this.end('failed', 'failure', 'target_gone');
  }

  private deliver(value: string | null): void {
    if (this.answered) return;
    this.answered = true;
    this.options.answer(value);
  }

  private publish(phase: InputHandoffPhase): void {
    this.phase = phase;
    this.revision++;
    this.options.publish(this.snapshot());
  }

  private end(status: HandoffResult['status'], reason: HandoffEndReason, failure?: HandoffResult['failure']): void {
    if (this.ended) return;
    this.ended = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.failure = failure;
    this.deliver(null);
    const phase: InputHandoffPhase = status === 'succeeded' ? 'succeeded' : status === 'expired' ? 'expired'
      : status === 'cancelled' ? 'cancelled' : 'failed';
    this.publish(phase);
    this.options.finish({
      status,
      reason,
      steps: status === 'succeeded' ? 1 : 0,
      ...(failure ? { failure } : {}),
      finalApp: this.options.program,
      ...(this.step.source.origin ? { finalOrigin: this.step.source.origin } : {}),
      ...(this.answeredOn ? { answeredOn: { ...this.answeredOn } } : {}),
    });
  }
}
