export const PI_IMAGE_INPUT_UNSUPPORTED_CODE = 'PI_IMAGE_INPUT_UNSUPPORTED';
export const PI_IMAGE_INPUT_UNSUPPORTED_MARKER = `[${PI_IMAGE_INPUT_UNSUPPORTED_CODE}]`;
export const MODEL_IMAGE_INPUT_UNSUPPORTED_CODE = 'MODEL_IMAGE_INPUT_UNSUPPORTED';
export const MODEL_IMAGE_INPUT_UNSUPPORTED_MARKER = `[${MODEL_IMAGE_INPUT_UNSUPPORTED_CODE}]`;
export const MODEL_IMAGE_INPUT_UNSUPPORTED_RECOVERY_CODE =
  'MODEL_IMAGE_INPUT_UNSUPPORTED_RECOVERY';
export const MODEL_IMAGE_INPUT_UNSUPPORTED_RECOVERY_MARKER =
  `[${MODEL_IMAGE_INPUT_UNSUPPORTED_RECOVERY_CODE}]`;

/** Generic image-capability marker used by provider bridges outside Pi. */
export function isModelImageInputUnsupportedError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const code =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { code?: unknown }).code
      : null;
  return (
    code === MODEL_IMAGE_INPUT_UNSUPPORTED_CODE ||
    message.includes(MODEL_IMAGE_INPUT_UNSUPPORTED_MARKER)
  );
}

/** Stable Desktop main -> renderer/device-link marker; presentation localizes at display time. */
export function isPiImageInputUnsupportedError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const code =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { code?: unknown }).code
      : null;
  return (
    code === PI_IMAGE_INPUT_UNSUPPORTED_CODE || message.includes(PI_IMAGE_INPUT_UNSUPPORTED_MARKER)
  );
}
