import { isPluginEngineProviderIdShape } from './subscriptionAccounts';
import type { MakerAgentKindWire } from './agentKindConversion';

/** Only model preferences; native checkpoints and permission settings keep their own lifecycle. */
export interface ScheduledModelBaseline {
  scopeId: string;
  /** Permanent profile save not yet accepted by the runtime; survives pause/restart. */
  pendingBotProfileVersion?: number;
  agentKind: MakerAgentKindWire;
  agentDeviceId?: string | null;
  model: string;
  providerId: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
  fastMode: boolean | 'ultrafast';
}

type ProfileBaseline = ScheduledModelBaseline | (Omit<ScheduledModelBaseline, 'agentKind'> & { agentKind: 'acp' });

/** Profile saves also fence plugin routes, which are outside the built-in model catalog. */
export function parseProfileModelBaseline(value: unknown): ProfileBaseline | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Omit<ProfileBaseline, 'effort'> & {
      effort: ScheduledModelBaseline['effort'] | '';
    };
    // Older session rows used an empty string for models without adjustable effort.
    const effort = parsed?.effort === '' ? null : parsed?.effort;
    if (!parsed || typeof parsed.scopeId !== 'string' ||
      !['claude-code', 'codex', 'pi', 'acp'].includes(parsed.agentKind) ||
      (parsed.agentDeviceId !== undefined && parsed.agentDeviceId !== null && typeof parsed.agentDeviceId !== 'string') ||
      typeof parsed.model !== 'string' || !parsed.model ||
      (parsed.providerId !== null && typeof parsed.providerId !== 'string') ||
      (effort !== null && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) ||
      (typeof parsed.fastMode !== 'boolean' && parsed.fastMode !== 'ultrafast')) return null;
    // Older clients saved the built-in fallback alongside the actual plugin provider.
    if (parsed.agentKind === 'acp' || (parsed.agentKind === 'claude-code' && isPluginEngineProviderIdShape(parsed.providerId))) {
      return { ...parsed, agentKind: 'acp', effort };
    }
    return { ...parsed, agentKind: parsed.agentKind, effort };
  } catch {
    return null;
  }
}

export function parseScheduledModelBaseline(value: unknown): ScheduledModelBaseline | null {
  const baseline = parseProfileModelBaseline(value);
  return baseline?.agentKind === 'acp' ? null : baseline;
}
