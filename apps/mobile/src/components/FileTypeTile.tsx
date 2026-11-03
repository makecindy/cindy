import { FILE_VISUAL_LABELS, getFileVisualKind, type FileVisualInput } from '@cindy/maker-shared';
import { View } from 'react-native';
import { Text } from '@/components/AppText';
import { iconSize, iconStroke, lineHeight, spacing, typeScale, useTheme } from '@/theme';
import { FileTypeIcon } from './FileTypeIcon';

/** Large fallback only; real image/document previews remain owned by their callers.
 *  The glyph matches the file-browser folder glyph: thin absolute stroke (it must not
 *  scale with the 64pt size) on the same light border tone. */
export function FileTypeTile({ name, mimeType }: FileVisualInput) {
  const { colors } = useTheme();
  const label = FILE_VISUAL_LABELS[getFileVisualKind({ name, mimeType })];
  return (
    <View accessible={false} style={{ alignItems: 'center', gap: spacing.xs }}>
      <FileTypeIcon
        name={name}
        mimeType={mimeType}
        size={iconSize.glyph}
        color={colors.borderStrong}
        strokeWidth={iconStroke.thin}
        absoluteStrokeWidth
      />
      {label ? <Text style={{ color: colors.textPrimary, fontSize: typeScale.micro, lineHeight: lineHeight.micro }}>{label}</Text> : null}
    </View>
  );
}
