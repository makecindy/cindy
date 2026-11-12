/** Keep the outgoing database alive if shared-task closure cannot be made durable. */
export async function closeSharedTasksBeforeAccountHandover(options: {
  closeSharedTasks(): Promise<void>;
  releaseOwnership(): Promise<void>;
  onClosureFailure(error: unknown): void;
  onReleaseFailure(error: unknown): void;
}): Promise<void> {
  try {
    await options.closeSharedTasks();
  } catch (error) {
    options.onClosureFailure(error);
    throw error;
  } finally {
    // Even a failed journal must not leave the outgoing relay accepting peers.
    // A release error retains the existing best-effort semantics, but must not
    // replace a closure error and turn it into a successful account handover.
    try {
      await options.releaseOwnership();
    } catch (error) {
      options.onReleaseFailure(error);
    }
  }
}
