import {
  createLucideIcon,
  type IconNode,
  type LucideIcon,
} from "lucide-react-native";
import {
  PROJECT_SYMBOL_ICON_NODES,
  type ProjectSymbolName,
} from "@cindy/maker-shared";

/**
 * Components for the project symbols. The list and drawings are shared with
 * Desktop (PROJECT_SYMBOLS in maker-shared); nothing here is per symbol.
 */
export const projectSymbolIcons = Object.fromEntries(
  Object.entries(PROJECT_SYMBOL_ICON_NODES).map(([name, node]) => [
    name,
    createLucideIcon(name, node as unknown as IconNode),
  ]),
) as Record<ProjectSymbolName, LucideIcon>;
