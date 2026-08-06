export const WORKTREE_CHANNELS = {
  CHANGED: "worktree:changed",
  CREATE: "worktree:create",
  DETECT_CWD: "worktree:detect-cwd",
  DISCARD_PRECREATED: "worktree:discard-precreated",
  GET_FOR_SESSION: "worktree:get-for-session",
  LIST_ALL: "worktree:list-all",
  LIST_BRANCHES: "worktree:list-branches",
  REMOVAL_PREVIEW: "worktree:removal-preview",
  RESTORE_FOR_SESSION: "worktree:restore-for-session",
  RESTORE_STATUS: "worktree:restore-status",
  REVEAL: "worktree:reveal",
  SUGGEST_NAME: "worktree:suggest-name",
} as const;

export type WORKTREEChannel = typeof WORKTREE_CHANNELS[keyof typeof WORKTREE_CHANNELS];
