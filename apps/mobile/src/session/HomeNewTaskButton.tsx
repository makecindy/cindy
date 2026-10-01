import { SquarePen } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { iconSize, iconStroke, useTheme } from '@/theme';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { ComposerMorphSource } from './ComposerMorphSource';
import { useLiquidGlassAvailable } from './useLiquidGlassAvailable';
import { composerGeometry, type ComposerMorphOrigin } from './composerGeometry';

/** The circle and the compact composer pill are the same height, so the morph only stretches sideways. */
export const HOME_NEW_TASK_SIZE = composerGeometry.pillHeight;

/**
 * Shared home/detail floating action. It sits on the composer's resting line
 * (right edge = composer right inset, bottom = composer bottom), so on iOS the
 * circle stretches straight into the new task's composer pill.
 */
export function HomeNewTaskButton({ onPress, bottomInset, disabled = false, morph = false }: {
  onPress(origin?: ComposerMorphOrigin): void; bottomInset: number; disabled?: boolean;
  /** Only callers whose onPress hands the origin to the new-task route may morph. */
  morph?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  // Liquid Glass: the untinted system glass circle (like the header buttons and
  // the composer pill it grows into). Without it, keep the solid filled circle,
  // since a plain chrome button has no surface of its own.
  const glass = useLiquidGlassAvailable();
  // Without morph the native shield stays out of the way and the button presses normally.
  return <ComposerMorphSource disabled={disabled || !morph} onAction={onPress} style={{
    position: 'absolute', right: composerGeometry.horizontalInset, bottom: bottomInset + composerGeometry.restingGap,
    width: HOME_NEW_TASK_SIZE, height: HOME_NEW_TASK_SIZE,
  }}>
    <HomeHeaderGlassButton accessibilityLabel={t('devices.list.a11y.newRemoteConversation')}
      onPress={() => onPress()} disabled={disabled} prominent={!glass} size={HOME_NEW_TASK_SIZE} artworkSize={iconSize.xxl}
      testID="home.newChatButton">
      <SquarePen color={glass ? colors.textPrimary : colors.ctaText} size={iconSize.xxl} strokeWidth={iconStroke.regular} />
    </HomeHeaderGlassButton>
  </ComposerMorphSource>;
}
