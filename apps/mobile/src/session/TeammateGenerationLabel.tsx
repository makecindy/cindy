import { readWorkingPhase } from '@cindy/maker-shared';
import type { RemoteResourceDisplay } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useTheme, typeScale } from '@/theme';
import { useCompanionGenerationCopy } from './useCompanionGenerationCopy';

export function TeammateGenerationLabel({ deviceId, botId, generation }: {
  deviceId: string; botId: string; generation: NonNullable<RemoteResourceDisplay['generation']>;
}) {
  const { colors } = useTheme();
  const label = useCompanionGenerationCopy({ deviceId, botId, phase: readWorkingPhase(generation.phase) ?? 'processing',
    active: true, turnId: String(generation.startedAt) });
  return <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: typeScale.footnote }}>{label}</Text>;
}
