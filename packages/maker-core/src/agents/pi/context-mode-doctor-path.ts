/**
 * context-mode's Pi doctor still claims hooks live at
 * ~/.pi/extensions/context-mode/. Cindy never installs there — packages are
 * snapshotted into the session managed-packages tree and passed as explicit
 * --extension/--skill args. Rewrite that stale path in user-visible doctor
 * output so Cindy users are not sent looking at a directory that does not exist.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONTEXT_MODE_STALE_EXTENSION_PATH = '~/.pi/extensions/context-mode';
export const CONTEXT_MODE_DOCTOR_TOOL_NAME = 'ctx_doctor';
export const CONTEXT_MODE_DOCTOR_COMMAND_NAME = 'ctx-doctor';

export function isContextModeDoctorToolName(toolName: string): boolean {
  return toolName === CONTEXT_MODE_DOCTOR_TOOL_NAME;
}

export function isContextModeDoctorCommandName(commandName: string | null | undefined): boolean {
  return commandName === CONTEXT_MODE_DOCTOR_COMMAND_NAME;
}

const DOCTOR_UI_EVENT_KEYS = ['command', 'commandName', 'name', 'toolName'] as const;

/** True when a Pi extension UI event itself identifies ctx_doctor / ctx-doctor. */
export function isContextModeDoctorUiEvent(event: Record<string, unknown> | undefined): boolean {
  if (!event) return false;
  for (const key of DOCTOR_UI_EVENT_KEYS) {
    const value = event[key];
    if (typeof value !== 'string') continue;
    const name = value.trim().replace(/^\//, '');
    if (isContextModeDoctorCommandName(name) || isContextModeDoctorToolName(name)) return true;
  }
  return false;
}

/** Real /ctx-doctor notify text from context-mode, not a generic stale-path mention. */
export function isContextModeDoctorNotifyMessage(message: string): boolean {
  if (!message.includes(CONTEXT_MODE_STALE_EXTENSION_PATH)) return false;
  return /(?:^|\n)## ctx-doctor\b/.test(message)
    || /(?:^|\n)context-mode doctor\b/.test(message)
    || /Hook support:\s+Pi hooks are wired via the context-mode Pi extension/.test(message);
}

/** Rewrite doctor notify when the event is identified, or when /ctx-doctor is active and the body is doctor output. */
export function shouldRewriteContextModeDoctorNotification(
  message: string,
  event: Record<string, unknown> | undefined,
  doctorCommandActive: boolean,
): boolean {
  if (isContextModeDoctorUiEvent(event)) return true;
  return doctorCommandActive && isContextModeDoctorNotifyMessage(message);
}

/** Refcount of in-flight /ctx-doctor commands so overlapping send/steer cannot clobber a boolean. */
export class DoctorCommandActivity {
  #count = 0;

  get active(): boolean {
    return this.#count > 0;
  }

  enter(isDoctor: boolean): void {
    if (isDoctor) this.#count += 1;
  }

  leave(isDoctor: boolean): void {
    if (isDoctor && this.#count > 0) this.#count -= 1;
  }
}

function isContextModePackageRoot(dir: string): boolean {
  try {
    const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object'
      && parsed !== null
      && 'name' in parsed
      && (parsed as { name?: unknown }).name === 'context-mode';
  } catch {
    return false;
  }
}

/** Resolve the context-mode package directory from Cindy-owned package roots. */
export function findContextModePackageRoot(packageRoots: readonly string[]): string | undefined {
  for (const root of packageRoots) {
    if (!root) continue;
    if (isContextModePackageRoot(root)) return root;
    const nested = path.join(root, 'node_modules', 'context-mode');
    if (existsSync(nested) && isContextModePackageRoot(nested)) return nested;
  }
  return undefined;
}

/**
 * Replace context-mode's hardcoded ~/.pi/extensions/context-mode path with the
 * Cindy-managed package root. No-op when the stale path is absent or Cindy
 * did not load context-mode — never invent a path.
 */
export function rewriteContextModeDoctorPath(
  text: string,
  actualRoot: string | undefined,
): string {
  if (!actualRoot || !text.includes(CONTEXT_MODE_STALE_EXTENSION_PATH)) return text;
  const replacement = actualRoot.replace(/[/\\]+$/, '');
  // Function replacement keeps dollar sequences in custom data dirs literal.
  return text
    .replaceAll(`${CONTEXT_MODE_STALE_EXTENSION_PATH}/`, () => `${replacement}/`)
    .replaceAll(CONTEXT_MODE_STALE_EXTENSION_PATH, () => replacement);
}
