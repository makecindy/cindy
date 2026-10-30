import { AskpassHost, type AskpassHostDeps } from './host.js';

let host: AskpassHost | null = null;

export function initInputHandoffAskpass(deps: AskpassHostDeps): AskpassHost {
  host = new AskpassHost(deps);
  void host.prepare().catch((error) => {
    deps.logger?.warn('input handoff askpass unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return host;
}

/** `AgentRuntimeConfig.taskShellEnv` for all three harnesses. Empty until ready or when unsupported. */
export function inputHandoffTaskShellEnv(ctx: { sessionId: string }): Record<string, string> {
  return host?.envFor(ctx.sessionId) ?? {};
}

export async function closeInputHandoffAskpass(): Promise<void> {
  await host?.close();
}
