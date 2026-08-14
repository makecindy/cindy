export interface ReviewSourceIdentity {
  workingDir: string | null;
  workspaceKind: string | null;
  status: string;
}

/** A result belongs only to the exact active source workspace captured at launch. */
export function reviewSourceIdentityMatches(
  launched: ReviewSourceIdentity,
  current: ReviewSourceIdentity | null,
): boolean {
  return (
    current !== null &&
    current.status === 'active' &&
    current.workingDir === launched.workingDir &&
    current.workspaceKind === launched.workspaceKind
  );
}
