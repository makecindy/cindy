/**
 * Teammate linked projects and the task-source rule shared by main and renderer. The file name is
 * kept from the V1 workbench; the store itself is `workbench.json` in the teammate home.
 */

/** Project references provide context, never task responsibility or execution permission. */
export interface BotLinkedProject {
  path: string;
  addedAt: string;
  /** Missing means this computer; a foreign path must never be opened locally. */
  deviceId?: string;
}

export interface BotProjectOption {
  id: string;
  name: string;
  path: string;
  deviceId?: string;
  linked: boolean;
  available: boolean;
}

/**
 * Sessions that count as the owner's ordinary tasks (including tasks plugins create for a project
 * and tasks imported from local tools, all stored as desktop). IM channels, learning, review and a
 * teammate's own chats do not. A missing source is desktop for older rows.
 */
export function isWorkbenchTaskSource(source: string | null | undefined): boolean {
  return source == null || source === 'desktop' || source === 'plugin';
}
