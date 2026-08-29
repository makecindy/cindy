/**
 * Review artifact consent windows are isolated, independently disposable
 * renderers. Their local lifecycle fails the pending grant closed, so a crash
 * must not escalate into the main application's fatal renderer shutdown path.
 * WebContents ids are not reused within one Electron process; keeping this
 * registry add-only also covers the gone/closed event ordering race.
 */

const reviewArtifactConfirmWebContentsIds = new Set<number>();

export function markReviewArtifactConfirmWebContentsId(id: number): void {
  reviewArtifactConfirmWebContentsIds.add(id);
}

export function isReviewArtifactConfirmWebContentsId(id: number): boolean {
  return reviewArtifactConfirmWebContentsIds.has(id);
}
