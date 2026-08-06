export const GIT_REVIEW_CHANNELS = {
  BRANCH_DIFF: "git-review:branch-diff",
  COMMIT: "git-review:commit",
  COMMIT_DIFF: "git-review:commit-diff",
  COMMITS: "git-review:commits",
  DISCARD_ALL: "git-review:discard-all",
  DISCARD_FILE: "git-review:discard-file",
  DISCARD_HUNK: "git-review:discard-hunk",
  FILE_DIFF: "git-review:file-diff",
  GET: "git-review:get",
  IMAGE_PREVIEW: "git-review:image-preview",
  MARKDOWN_PREVIEW: "git-review:markdown-preview",
  OPEN_FILE: "git-review:open-file",
  PUSH: "git-review:push",
  STAGE_ALL: "git-review:stage-all",
  STAGE_FILE: "git-review:stage-file",
  STAGE_HUNK: "git-review:stage-hunk",
  SUMMARY: "git-review:summary",
  UNSTAGE_ALL: "git-review:unstage-all",
  UNSTAGE_FILE: "git-review:unstage-file",
  UNSTAGE_HUNK: "git-review:unstage-hunk",
} as const;

export type GIT_REVIEWChannel = typeof GIT_REVIEW_CHANNELS[keyof typeof GIT_REVIEW_CHANNELS];
