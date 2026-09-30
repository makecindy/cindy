export const PI_IMAGE_INPUT_UNSUPPORTED_CODE = 'PI_IMAGE_INPUT_UNSUPPORTED';
export const PI_IMAGE_INPUT_UNSUPPORTED_MARKER = `[${PI_IMAGE_INPUT_UNSUPPORTED_CODE}]`;
export const PI_IMAGE_CAPABILITY_REFRESH_FAILED_CODE = 'PI_IMAGE_CAPABILITY_REFRESH_FAILED';
export const PI_IMAGE_CAPABILITY_REFRESH_FAILED_MARKER = `[${PI_IMAGE_CAPABILITY_REFRESH_FAILED_CODE}]`;

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

/** 图片能力已改但子进程还没加载（回合在跑 / 重载被拒），可重试。 */
export function isPiImageCapabilityRefreshFailedError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  const code =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { code?: unknown }).code
      : null;
  return (
    code === PI_IMAGE_CAPABILITY_REFRESH_FAILED_CODE ||
    message.includes(PI_IMAGE_CAPABILITY_REFRESH_FAILED_MARKER)
  );
}
