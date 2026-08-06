export const REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS = {
  LIST: "remote-precreated-worktree-ledger:list",
  REGISTER: "remote-precreated-worktree-ledger:register",
  FORGET: "remote-precreated-worktree-ledger:forget",
} as const;

export type REMOTE_PRECREATED_WORKTREE_LEDGERChannel =
  typeof REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS[keyof typeof REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS];
