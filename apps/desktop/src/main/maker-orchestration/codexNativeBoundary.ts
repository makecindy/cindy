export interface ParsedAgentSwitchBoundary {
  fromAgentKind: 'cc' | 'codex' | 'pi' | 'acp';
  fromAgentDeviceId?: string | null;
  toAgentKind?: 'cc' | 'codex' | 'pi' | 'acp';
  fromModel: string | null;
  fromProviderId?: string | null;
  toProviderId?: string | null;
  fromSdkSessionId: string | null;
  handoff?: string;
}

export interface CodexNativeBoundaryRow {
  role: string;
  content: string;
  agentMeta: string | null;
  createdAt: number;
}

export function parseAgentSwitchBoundary(content: string): ParsedAgentSwitchBoundary | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed.fromAgentKind !== 'cc' &&
      parsed.fromAgentKind !== 'codex' &&
      parsed.fromAgentKind !== 'pi' &&
      parsed.fromAgentKind !== 'acp'
    )
      return null;
    const toAgentKind =
      parsed.toAgentKind === 'cc' ||
      parsed.toAgentKind === 'codex' ||
      parsed.toAgentKind === 'pi' ||
      parsed.toAgentKind === 'acp'
        ? parsed.toAgentKind
        : undefined;
    return {
      fromAgentKind: parsed.fromAgentKind,
      ...(Object.hasOwn(parsed, 'fromAgentDeviceId')
        ? { fromAgentDeviceId: typeof parsed.fromAgentDeviceId === 'string' ? parsed.fromAgentDeviceId : null }
        : {}),
      toAgentKind,
      fromModel: typeof parsed.fromModel === 'string' ? parsed.fromModel : null,
      ...(Object.hasOwn(parsed, 'fromProviderId')
        ? {
            fromProviderId:
              typeof parsed.fromProviderId === 'string' ? parsed.fromProviderId : null,
          }
        : {}),
      ...(Object.hasOwn(parsed, 'toProviderId')
        ? {
            toProviderId: typeof parsed.toProviderId === 'string' ? parsed.toProviderId : null,
          }
        : {}),
      fromSdkSessionId:
        typeof parsed.fromSdkSessionId === 'string' && parsed.fromSdkSessionId
          ? parsed.fromSdkSessionId
          : null,
      handoff: typeof parsed.handoff === 'string' && parsed.handoff ? parsed.handoff : undefined,
    };
  } catch {
    return null;
  }
}

export function parseCodexNativeForkAnchor(raw: string | null): {
  sdkSessionId: string;
  turnId: string;
} | null {
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (meta.turnCompleted !== true) return null;
    const anchor = meta.nativeForkAnchor;
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
    const candidate = anchor as Record<string, unknown>;
    if (
      candidate.agentKind !== 'codex' ||
      candidate.kind !== 'turn' ||
      typeof candidate.sdkSessionId !== 'string' ||
      !candidate.sdkSessionId ||
      typeof candidate.id !== 'string' ||
      !candidate.id
    ) {
      return null;
    }
    return { sdkSessionId: candidate.sdkSessionId, turnId: candidate.id };
  } catch {
    return null;
  }
}

export function resolveCodexTurnAnchor(
  rows: CodexNativeBoundaryRow[],
  sourceSdkSessionId: string,
): string | undefined {
  let timelineSdkSessionId: string | null = sourceSdkSessionId;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.role === 'context_rebuild') {
      return undefined;
    }
    if (row.role === 'agent_switch') {
      timelineSdkSessionId = parseAgentSwitchBoundary(row.content)?.fromSdkSessionId ?? null;
      continue;
    }
    if (row.role === 'user' && timelineSdkSessionId === sourceSdkSessionId) {
      return undefined;
    }
    if (row.role !== 'assistant' || timelineSdkSessionId !== sourceSdkSessionId) continue;
    const anchor = parseCodexNativeForkAnchor(row.agentMeta);
    return anchor?.sdkSessionId === sourceSdkSessionId ? anchor.turnId : undefined;
  }
  return undefined;
}

export function resolveCodexForkEventTimestamp(rows: CodexNativeBoundaryRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.role === 'agent_switch' || row.role === 'context_rebuild' || row.role === 'user') return undefined;
    if (['assistant', 'tool_use', 'tool_result', 'thinking'].includes(row.role)) {
      return row.createdAt;
    }
  }
  return undefined;
}

export function isCodexNativeThreadStart(
  rows: CodexNativeBoundaryRow[],
  sourceSdkSessionId: string,
): boolean {
  let timelineSdkSessionId: string | null = sourceSdkSessionId;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.role === 'context_rebuild') {
      break;
    }
    if (row.role === 'agent_switch') {
      const owner = parseAgentSwitchBoundary(row.content)?.fromSdkSessionId;
      if (!owner) return false;
      timelineSdkSessionId = owner;
      continue;
    }
    if (row.role === 'user' && timelineSdkSessionId === sourceSdkSessionId) return false;
  }
  return true;
}
