export type CodexForkStage =
  | "source-prepare"
  | "host-create"
  | "host-start"
  | "thread-fork"
  | "thread-rollback"
  | "child-cleanup"
  | "host-retire"
  | "child-sanitize";

/** Carries the original fork failure and its phase through cleanup. */
export class CodexForkError extends Error {
  cleanupFailed = false;
  constructor(
    readonly stage: CodexForkStage,
    cause: unknown,
  ) {
    super(
      `Codex fork ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "CodexForkError";
  }
}
