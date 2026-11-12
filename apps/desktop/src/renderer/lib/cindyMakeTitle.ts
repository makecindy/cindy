/** The managed task directory is named after its run, on both Windows and POSIX. */
export function cindyMakeWorktreeName(workingDir: string | null | undefined): string | undefined {
  return workingDir?.match(/(?:^|[\\/])(?:merge-)?worktrees[\\/]([A-Za-z0-9-]{1,64})[\\/]?$/i)?.[1];
}

/** Replace the legacy feature tag and keep the worktree tag stable across renames/reloads. */
export function formatCindyMakeTitle(title: string, worktreeName?: string | null): string {
  const text = title.replace(/^\[Cindy(?:-| )Make\]\s*/i, '');
  if (!worktreeName) return text;
  const tag = `[${worktreeName.slice(0, 4)}]`;
  const body = text.startsWith(tag) ? text.slice(tag.length).trimStart() : text;
  return body ? `${tag} ${body}` : tag;
}
