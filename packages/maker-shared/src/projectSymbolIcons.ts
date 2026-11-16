import type { PROJECT_SYMBOLS } from "./projectIcons.js";
import { PROJECT_SYMBOL_NODES } from "./projectSymbolNodes.generated.js";

export type ProjectSymbolName = (typeof PROJECT_SYMBOLS)[number]["name"];

/** One SVG element of a symbol: tag name and attributes, as Lucide stores it. */
export type ProjectSymbolNode = readonly (readonly [tag: string, attrs: Readonly<Record<string, string>>])[];

/**
 * The drawing of every project symbol, shared by Desktop and Mobile so both
 * show the same set. Add a symbol to PROJECT_SYMBOLS and run
 * `pnpm generate:project-symbols`; a missing drawing fails this assignment.
 */
export const PROJECT_SYMBOL_ICON_NODES: Readonly<Record<ProjectSymbolName, ProjectSymbolNode>> =
  PROJECT_SYMBOL_NODES;
