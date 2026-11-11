/**
 * A teammate's project is its host-owned workspace folder,
 * `<userData>/owners/<owner>/bots/<teammate folder>/workspace`.
 * The layout is fixed by the host, so every client (and every remote computer's
 * paths) can recognise one from the path alone. Lists that let the user pick a
 * project skip these; the teammate's own entries reach its tasks.
 */

const TEAMMATE_PROJECT_PATH = /[\\/]owners[\\/][^\\/]+[\\/]bots[\\/]([^\\/]+)[\\/]workspace[\\/]*$/;

/** The teammate folder name for a project path, or null when it is an ordinary project. */
export function teammateFolderOfProjectPath(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null;
  return TEAMMATE_PROJECT_PATH.exec(projectPath)?.[1] ?? null;
}

export function isTeammateProjectPath(projectPath: string | null | undefined): boolean {
  return teammateFolderOfProjectPath(projectPath) !== null;
}

/** Folder name the host gives a teammate id; empty when the id cannot name a folder. */
export function teammateFolderName(botId: string): string {
  return botId.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
}
