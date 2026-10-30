import { Folder, FolderOpen, type LucideIcon } from 'lucide-react';

// Compatibility entry point; file classification is shared with Mobile.
export { pickFileIcon } from '@/components/ui/file-type-icon';

export function pickFolderIcon(expanded: boolean): LucideIcon {
  return expanded ? FolderOpen : Folder;
}
