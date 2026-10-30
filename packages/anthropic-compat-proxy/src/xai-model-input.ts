/** Compatibility implementation is owned by the shared package; preserve this import contract. */
export {
  looksLikeXaiResponsesModel,
  xaiBareModelId,
  supportsXaiReasoningModel,
  sanitizeXaiModelInputBody,
  sanitizeXaiModelInputFromBody,
  createXaiModelInputSanitizeTransform,
  createXaiModelInputRecoveryRule
} from '@cindy/model-compat';
export type {
  SanitizeXaiModelInputOptions,
  XaiModelInputCompatOptions
} from '@cindy/model-compat';
