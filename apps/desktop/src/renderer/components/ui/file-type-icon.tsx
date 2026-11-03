import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileChartColumn,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideProps,
} from 'lucide-react';
import { FILE_VISUAL_GLYPHS, getFileVisualKind, type FileVisualInput } from '@cindy/maker-shared';

const glyphs = {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileChartColumn,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
};

export function pickFileIcon(name: string, mimeType?: string) {
  return glyphs[FILE_VISUAL_GLYPHS[getFileVisualKind({ name, mimeType })]];
}

/** Compact, decorative file identity. Inherits the surrounding semantic foreground. */
export function FileTypeIcon({
  name = '',
  mimeType,
  size = 14,
  ...props
}: FileVisualInput & LucideProps) {
  const Icon = pickFileIcon(name, mimeType);
  return <Icon size={size} {...props} strokeWidth={2} aria-hidden="true" focusable="false" />;
}
