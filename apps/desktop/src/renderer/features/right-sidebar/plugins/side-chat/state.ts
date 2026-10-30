export interface SideChatState {
  sessionId: string | null;
  deviceId: string | null;
}

/** Keep the execution host in history even before the remote mirror reaches disk. */
export function sideChatTaskRoute(sessionId: string, deviceId?: string | null): string {
  return `/cc-agent/${encodeURIComponent(sessionId)}${deviceId ? `?device=${encodeURIComponent(deviceId)}` : ''}`;
}

export function hydrateSideChatState(raw: unknown): SideChatState {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null,
    deviceId: typeof value.deviceId === 'string' && value.deviceId ? value.deviceId : null,
  };
}
