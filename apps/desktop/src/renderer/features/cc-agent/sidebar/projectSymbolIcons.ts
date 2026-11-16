import { createLucideIcon, type IconNode, type LucideIcon } from 'lucide-react';
import {
  PROJECT_SYMBOL_ICON_NODES,
  type ProjectSymbolName,
} from '@cindy/maker-shared/project-symbol-icons';

/**
 * Components for the project symbols. The list and drawings are shared with
 * Mobile (PROJECT_SYMBOLS in maker-shared); nothing here is per symbol.
 */
export const projectSymbolIcons = Object.fromEntries(
  Object.entries(PROJECT_SYMBOL_ICON_NODES).map(([name, node]) => [
    name,
    createLucideIcon(name, node as unknown as IconNode),
  ]),
) as Record<ProjectSymbolName, LucideIcon>;
