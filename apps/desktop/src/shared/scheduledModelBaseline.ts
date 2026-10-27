import type { MakerAgentKindWire } from './agentKindConversion';

/** Only model preferences; native checkpoints and permission settings keep their own lifecycle. */
export interface ScheduledModelBaseline {
  scopeId: string;
  /** Permanent profile save not yet accepted by the runtime; survives pause/restart. */
  pendingBotProfileVersion?: number;
  agentKind: MakerAgentKindWire;
  model: string;
  providerId: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
  fastMode: boolean | 'ultrafast';
}

export function parseScheduledModelBaseline(value: unknown): ScheduledModelBaseline | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Omit<ScheduledModelBaseline, 'effort'> & {
      effort: ScheduledModelBaseline['effort'] | '';
    };
    // Older session rows used an empty string for models without adjustable effort.
    const effort = parsed?.effort === '' ? null : parsed?.effort;
    if (!parsed || typeof parsed.scopeId !== 'string' ||
      !['claude-code', 'codex', 'pi'].includes(parsed.agentKind) ||
      typeof parsed.model !== 'string' || !parsed.model ||
      (parsed.providerId !== null && typeof parsed.providerId !== 'string') ||
      (effort !== null && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) ||
      (typeof parsed.fastMode !== 'boolean' && parsed.fastMode !== 'ultrafast')) return null;
    return { ...parsed, effort };
  } catch {
    return null;
  }
}
