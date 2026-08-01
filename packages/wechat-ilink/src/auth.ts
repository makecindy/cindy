import { randomUUID } from "node:crypto";
import {
  IlinkApiClient,
  type QrStatusResponse,
  validateTencentIlinkBaseUrl,
} from "./apiClient.js";
import { WechatIlinkError } from "./errors.js";
import type {
  WechatAuthChallenge,
  WechatAuthorizationObserver,
  WechatCredentials,
} from "./types.js";

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new WechatIlinkError("BAD_RESPONSE", `iLink omitted ${field}.`, false);
}

function requiredTencentQrUrl(value: unknown): string {
  const raw = requiredString(value, "qrcode_img_content");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink returned an invalid QR URL.",
      false,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(
      url.hostname === "weixin.qq.com" ||
      url.hostname.endsWith(".weixin.qq.com")
    )
  ) {
    throw new WechatIlinkError(
      "BAD_RESPONSE",
      "iLink returned an invalid QR URL.",
      false,
    );
  }
  return url.toString();
}

interface ActiveAuthorization {
  qrCode: string;
  pollBaseUrl: string;
  localTokens: string[];
  createdAt: number;
}

const AUTHORIZATION_TTL_MS = 5 * 60_000;

/** QR authorization state machine with host-injected verification-code UX. */
export class IlinkAuthorization {
  private readonly active = new Map<string, ActiveAuthorization>();

  constructor(
    private readonly api: IlinkApiClient,
    private readonly observer: WechatAuthorizationObserver = {},
  ) {}

  async begin(
    localTokens: string[],
    signal: AbortSignal,
  ): Promise<WechatAuthChallenge> {
    const response = await this.api.beginQr(localTokens, signal);
    const challenge = {
      id: randomUUID(),
      qrCodeUrl: requiredTencentQrUrl(response.qrcode_img_content),
      createdAt: Date.now(),
    };
    this.active.set(challenge.id, {
      qrCode: requiredString(response.qrcode, "qrcode"),
      pollBaseUrl: "https://ilinkai.weixin.qq.com",
      localTokens: [...localTokens],
      createdAt: challenge.createdAt,
    });
    return challenge;
  }

  async wait(
    challenge: WechatAuthChallenge,
    signal: AbortSignal,
  ): Promise<WechatCredentials> {
    const active = this.active.get(challenge.id);
    if (!active) {
      throw new WechatIlinkError(
        "AUTH_EXPIRED",
        "The WeChat authorization challenge is no longer active.",
        true,
      );
    }
    let verificationCode: string | undefined;
    let currentChallenge = { ...challenge };
    let refreshCount = 0;
    try {
      while (!signal.aborted) {
        if (Date.now() - active.createdAt > AUTHORIZATION_TTL_MS) {
          throw new WechatIlinkError(
            "AUTH_TIMEOUT",
            "The WeChat authorization timed out.",
            true,
          );
        }
        const status = (await this.api.pollQr(
          active.qrCode,
          verificationCode,
          signal,
          active.pollBaseUrl,
        )) as QrStatusResponse;
        switch (status.status) {
          case "wait":
            await this.observer.onEvent?.({ status: "waiting" });
            break;
          case "scaned":
            verificationCode = undefined;
            await this.observer.onEvent?.({ status: "scanned" });
            break;
          case "need_verifycode":
            if (!this.observer.requestVerificationCode) {
              throw new WechatIlinkError(
                "PROTOCOL_ERROR",
                "A WeChat verification code is required.",
                true,
              );
            }
            await this.observer.onEvent?.({
              status: "verification-required",
              retry: verificationCode !== undefined,
            });
            verificationCode = await this.observer.requestVerificationCode(
              verificationCode !== undefined,
              signal,
            );
            if (!/^\d{1,12}$/.test(verificationCode)) {
              throw new WechatIlinkError(
                "PROTOCOL_ERROR",
                "The WeChat verification code is invalid.",
                false,
              );
            }
            break;
          case "verify_code_blocked":
            throw new WechatIlinkError(
              "AUTH_TIMEOUT",
              "Verification attempts were blocked.",
              true,
            );
          case "expired":
            refreshCount += 1;
            if (refreshCount > 3) {
              throw new WechatIlinkError(
                "AUTH_EXPIRED",
                "The WeChat QR code expired too many times.",
                true,
              );
            }
            {
              const response = await this.api.beginQr(
                active.localTokens,
                signal,
              );
              active.qrCode = requiredString(response.qrcode, "qrcode");
              active.pollBaseUrl = "https://ilinkai.weixin.qq.com";
              currentChallenge = {
                id: challenge.id,
                qrCodeUrl: requiredTencentQrUrl(response.qrcode_img_content),
                createdAt: Date.now(),
              };
            }
            verificationCode = undefined;
            await this.observer.onEvent?.({
              status: "qr-refreshed",
              challenge: currentChallenge,
            });
            break;
          case "binded_redirect":
            throw new WechatIlinkError(
              "AUTH_ALREADY_BOUND",
              "This WeChat connection is already bound.",
              false,
            );
          case "scaned_but_redirect":
            if (
              !status.redirect_host ||
              !/^[A-Za-z0-9.-]+$/.test(status.redirect_host)
            ) {
              throw new WechatIlinkError(
                "BAD_RESPONSE",
                "iLink returned an invalid authorization redirect.",
                true,
              );
            }
            active.pollBaseUrl = validateTencentIlinkBaseUrl(
              `https://${status.redirect_host}`,
            ).origin;
            break;
          case "confirmed":
            validateTencentIlinkBaseUrl(
              requiredString(status.baseurl, "baseurl"),
            );
            return {
              token: requiredString(status.bot_token, "bot_token"),
              botId: requiredString(status.ilink_bot_id, "ilink_bot_id"),
              userId: requiredString(status.ilink_user_id, "ilink_user_id"),
              baseUrl: requiredString(status.baseurl, "baseurl"),
            };
          default:
            throw new WechatIlinkError(
              "BAD_RESPONSE",
              "iLink returned an unknown authorization status.",
              true,
            );
        }
      }
      throw new WechatIlinkError(
        "ABORTED",
        "The iLink operation was cancelled.",
        true,
      );
    } finally {
      this.active.delete(challenge.id);
    }
  }
}
