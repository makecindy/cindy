import { Database, File, FileArchive, FileAudio, FileChartColumn, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, type LucideProps } from 'lucide-react-native';
import { FILE_VISUAL_GLYPHS, getFileVisualKind, type FileVisualInput } from '@cindy/maker-shared';
import { iconSize, iconStroke, useTheme } from '@/theme';

const glyphs = { Database, File, FileArchive, FileAudio, FileChartColumn, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo };

export function pickFileIcon(name: string, mimeType?: string) {
  return glyphs[FILE_VISUAL_GLYPHS[getFileVisualKind({ name, mimeType })]];
}

export function FileTypeIcon({ name = '', mimeType, size = iconSize.sm, color, ...props }: FileVisualInput & LucideProps) {
  const { colors } = useTheme();
  const Icon = pickFileIcon(name, mimeType);
  return <Icon size={size} color={color ?? colors.textSecondary} {...props} strokeWidth={iconStroke.regular} accessible={false} />;
}
