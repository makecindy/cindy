export const PI_IMAGE_INPUT_UNSUPPORTED_MARKER = '[PI_IMAGE_INPUT_UNSUPPORTED]';

export function isPiImageInputUnsupportedProjectionError(error: string): boolean {
  return error.includes(PI_IMAGE_INPUT_UNSUPPORTED_MARKER);
}
