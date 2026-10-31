import type { CreateSessionOptions, Maker, Session, UserMessage } from '@cindy/maker-core';

/** The desktop's existing task pipeline owns visible records and event persistence. */
export interface LocalAgentVisibleSessionHost {
  open(options: CreateSessionOptions): Promise<Session>;
  persistInput(
    sessionId: string,
    message: UserMessage,
    clientId: string,
    assertCurrent: () => void,
    source: { pluginId: string; name: string },
  ): Promise<void>;
  close(sessionId: string, session: Session): Promise<void>;
}

// IPC registration outlives account changes and uses a dynamic Maker facade.
// Each runtime instead binds the concrete Maker and owner present at its open.
let createHost: ((maker: Maker) => LocalAgentVisibleSessionHost) | undefined;

// Ownership is attached to the external runtime, not its self-reported app id.
// Keep failed closes registered: a subsequent Cindy input must retry the handoff,
// never reuse a partially closed external Session or resume its native history.
const externalRuntimes = new Map<string, (sendLockHeld: boolean) => Promise<void>>();

export function hasLocalAgentVisibleRuntime(sessionId: string): boolean {
  return externalRuntimes.has(sessionId);
}

export function registerLocalAgentVisibleRuntime(
  sessionId: string,
  close: (sendLockHeld: boolean) => Promise<void>,
): () => void {
  externalRuntimes.set(sessionId, close);
  return () => {
    if (externalRuntimes.get(sessionId) === close) externalRuntimes.delete(sessionId);
  };
}

/** Called before Cindy input/control, including callers holding an explicit send lease. */
export async function takeOverLocalAgentVisibleSession(
  sessionId: string,
  sendLockHeld = false,
): Promise<void> {
  await externalRuntimes.get(sessionId)?.(sendLockHeld);
}

export function installLocalAgentVisibleSessionHost(
  factory: (maker: Maker) => LocalAgentVisibleSessionHost,
): void {
  createHost = factory;
}

export function localAgentVisibleSessionHost(
  maker: Maker,
): LocalAgentVisibleSessionHost | undefined {
  return createHost?.(maker);
}
