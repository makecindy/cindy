import type { SessionRuntimePendingProjection, SessionRuntimeProfileProjection } from '@/lib/ccAgent.types';

type Profile = SessionRuntimeProfileProjection;

/** Keep every displayed axis on one authoritative snapshot, including explicit null/false. */
export function resolveComposerModelSelection(input: {
  current: Profile;
  effective?: Profile;
  pending?: SessionRuntimePendingProjection | null;
  intent?: { target: Profile['agentKind']; model: string; providerId: string | null; effort?: Profile['effort']; fastMode?: boolean } | null;
  optimistic?: { model: string; providerId: string | null; effort: Profile['effort']; fastMode: boolean } | null;
}) {
  const current = input.effective ?? input.current;
  const next = input.intent
    ? { agentKind: input.intent.target, model: input.intent.model, providerId: input.intent.providerId,
        effort: input.intent.effort ?? null, fastMode: input.intent.fastMode ?? false }
    : input.optimistic ? { ...input.optimistic, agentKind: current.agentKind } : input.pending?.profile ?? null;
  return { current, display: next ?? current, pending: next !== null };
}
