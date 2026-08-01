export const GIT_CONTEXT_CHANNELS = {
  CHANGED: "git-context:changed",
  GET: "git-context:get",
  GET_FOR_SESSION: "git-context:get-for-session",
  PR_REFS_CHANGED: "git-context:pr-refs-changed",
  PR_REFS_LIST: "git-context:pr-refs:list",
  PR_REFS_LIST_ALL: "git-context:pr-refs:list-all",
  PR_STATUS: "git-context:pr-status",
  UNWATCH: "git-context:unwatch",
  WATCH: "git-context:watch",
} as const;

export type GIT_CONTEXTChannel = typeof GIT_CONTEXT_CHANNELS[keyof typeof GIT_CONTEXT_CHANNELS];
