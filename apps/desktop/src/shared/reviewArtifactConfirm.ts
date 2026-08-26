export const REVIEW_ARTIFACT_CONFIRM_REQUEST_CHANNEL = 'maker:review:artifact-confirm-request';
export const REVIEW_ARTIFACT_CONFIRM_RESOLVE_CHANNEL = 'maker:review:artifact-confirm-resolve';

export interface ReviewArtifactConfirmItem {
  kind: 'external-path' | 'inline';
  label: string;
  path?: string;
  inlineLabel?: string;
}

/** Main-owned, sanitized consent copy rendered by the initiating Cindy window. */
export interface ReviewArtifactConfirmDialogModel {
  title: string;
  message: string;
  detail: string;
  items: ReviewArtifactConfirmItem[];
  allowText: string;
  cancelText: string;
}

export interface ReviewArtifactConfirmRequest extends ReviewArtifactConfirmDialogModel {
  requestId: string;
}
