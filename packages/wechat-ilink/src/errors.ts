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
  | "SEND_REJECTED"
  | "TIMEOUT"
  | "UNSUPPORTED";

/** Stable, secret-free error surfaced across the package boundary. */
export class WechatIlinkError extends Error {
  constructor(
    readonly code: WechatIlinkErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; ret?: number },
  ) {
    super(message, options);
    this.ret = options?.ret;
    this.name = "WechatIlinkError";
  }

  /** Numeric service response code, when iLink returned one. */
  readonly ret?: number;
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
