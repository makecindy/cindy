export const WDA_ERROR_CODES = [
  "INVALID_CONFIGURATION",
  "CHECKOUT_NOT_FOUND",
  "REVISION_MISMATCH",
  "SCHEME_NOT_FOUND",
  "UNREACHABLE",
  "HTTP_ERROR",
  "PROTOCOL_ERROR",
  "ORIENTATION_UNSUPPORTED",
  "RESPONSE_TOO_LARGE",
  "STREAM_ERROR",
  "BUILD_FAILED",
  "LAUNCH_FAILED",
  "START_TIMEOUT",
  "START_CANCELLED",
  "TERMINATION_FAILED",
] as const;

export type WdaErrorCode = (typeof WDA_ERROR_CODES)[number];

/** Stable WDA adapter failure. Raw upstream responses never cross the driver boundary. */
export class WdaError extends Error {
  readonly code: WdaErrorCode;
  readonly statusCode: number | null;

  constructor(
    code: WdaErrorCode,
    message: string,
    statusCode: number | null = null,
  ) {
    super(message);
    this.name = "WdaError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
