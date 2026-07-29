export type WechatIlinkErrorCode =
  | "ABORTED"
  | "AUTH_EXPIRED"
  | "AUTH_ALREADY_BOUND"
  | "AUTH_REPLACED"
  | "AUTH_TIMEOUT"
  | "BAD_RESPONSE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "UNSUPPORTED";

/** Stable, secret-free error surfaced across the package boundary. */
export class WechatIlinkError extends Error {
  constructor(
    readonly code: WechatIlinkErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WechatIlinkError";
  }
}

export function asWechatIlinkError(error: unknown): WechatIlinkError {
  if (error instanceof WechatIlinkError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new WechatIlinkError(
      "ABORTED",
      "The iLink operation was cancelled.",
      true,
      {
        cause: error,
      },
    );
  }
  return new WechatIlinkError(
    "NETWORK_ERROR",
    "The iLink request failed.",
    true,
    {
      cause: error,
    },
  );
}
