import type { GithubReadMethod } from '@cindy/maker-shared';

/** One Host registration; MCP and scripts must not import the IPC registration graph. */
interface GithubReadRuntime {
  read(method: GithubReadMethod, args: unknown): Promise<Record<string, unknown>>;
  manage(
    sessionId: string,
    args: Record<string, unknown>,
    origin?: string,
  ): Promise<Record<string, unknown>>;
}
let runtime: GithubReadRuntime | undefined;
export function setGithubReadRuntime(value: GithubReadRuntime): void {
  runtime = value;
}
export function readGithub(
  method: GithubReadMethod,
  args: unknown,
): Promise<Record<string, unknown>> {
  if (!runtime) throw new Error('HOST_NOT_READY');
  return runtime.read(method, args);
}
export function manageGithubPrs(
  sessionId: string,
  args: Record<string, unknown>,
  origin?: string,
): Promise<Record<string, unknown>> {
  if (!runtime) throw new Error('HOST_NOT_READY');
  return runtime.manage(sessionId, args, origin);
}
