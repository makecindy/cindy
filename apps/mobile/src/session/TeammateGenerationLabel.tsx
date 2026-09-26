import { readWorkingPhase } from '@cindy/maker-shared';
import type { RemoteResourceDisplay } from '@cindy/device-link';
import { useTheme, typeScale, lineHeight, fontWeight } from '@/theme';
import { useCompanionGenerationCopy } from './useCompanionGenerationCopy';
import { WorkingStatusText } from './WorkingStatusText';

/** Lists consume the composer's public phase and host copy cache, in the preview line's rhythm. */
export function TeammateGenerationLabel({ deviceId, botId, generation }: {
  deviceId: string; botId: string; generation: NonNullable<RemoteResourceDisplay['generation']>;
}) {
  const { colors } = useTheme();
  const label = useCompanionGenerationCopy({ deviceId, botId, phase: readWorkingPhase(generation.phase) ?? 'processing',
    active: true, turnId: String(generation.startedAt) });
  // A transient process note stays tertiary and italic so it never outranks a real new reply.
  return <WorkingStatusText key={generation.startedAt} text={label ?? ''} style={{ color: colors.textTertiary,
    fontSize: typeScale.code, fontStyle: 'italic', fontWeight: fontWeight.regular, lineHeight: lineHeight.subtitle }} />;
}
