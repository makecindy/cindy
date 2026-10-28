/** Host-provided text is display-only; answers never enter snapshots or logs. */
export interface KeyboardInteractiveChallenge {
  host: { id: string; hostname: string; port: number; user: string };
  name: string;
  instructions: string;
  prompts: Array<{ prompt: string; echo: boolean }>;
}

export type KeyboardInteractiveHandler = (
  challenge: KeyboardInteractiveChallenge,
  signal: AbortSignal,
) => Promise<string[] | null>;

export const INTERACTIVE_AUTH_TIMEOUT_MS = 120_000;
export const INTERACTIVE_AUTH_MAX_ROUNDS = 6;
/** Network progress deadline before the first challenge and after each answer. */
export const SSH_READY_TIMEOUT_MS = 20_000;
export const INTERACTIVE_AUTH_MAX_PROMPTS = 16;
export const INTERACTIVE_AUTH_MAX_ANSWER_LENGTH = 4096;
export const SSH_INTERACTIVE_AUTH_FAILED_CODE = 'SSH_INTERACTIVE_AUTH_FAILED';
export const SSH_INTERACTIVE_CONNECTION_INTERRUPTED_MESSAGE = 'SSH connection interrupted.';

const messages = {
  required: 'SSH interactive authentication requires input on this computer.',
  cancelled: 'SSH interactive authentication was cancelled.',
  timeout: 'SSH interactive authentication timed out.',
  failed: 'SSH interactive authentication could not be completed.',
} as const;

export class InteractiveAuthenticationError extends Error {
  readonly code = SSH_INTERACTIVE_AUTH_FAILED_CODE;
  constructor(readonly reason: keyof typeof messages) {
    super(messages[reason]);
    this.name = 'InteractiveAuthenticationError';
  }
}

export function isInteractiveAuthenticationMessage(message: string): boolean {
  return interactiveAuthenticationReason(message) !== undefined;
}

export function interactiveAuthenticationReason(message: string): keyof typeof messages | undefined {
  return (Object.keys(messages) as Array<keyof typeof messages>).find(reason => messages[reason] === message);
}

export function validInteractiveChallenge(
  name: string,
  instructions: string,
  prompts: Array<{ prompt: string; echo?: boolean }>,
): boolean {
  return typeof name === 'string' && name.length <= 4096
    && typeof instructions === 'string' && instructions.length <= 8192
    && Array.isArray(prompts) && prompts.length <= INTERACTIVE_AUTH_MAX_PROMPTS
    && prompts.every(p => typeof p?.prompt === 'string' && p.prompt.length <= 4096
      && (p.echo === undefined || typeof p.echo === 'boolean'));
}
