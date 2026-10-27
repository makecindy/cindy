/**
 * 错误卡「诊断」的预填提示：与桌面 lib/errorDiagnosisPrompt 同形，经 /sessions/new 的
 * draft 参数填进新任务输入框，不自动发送。
 */
import type { TFunction } from "i18next";
import { redactSensitiveText } from "@cindy/maker-shared/error-redaction";

export interface ErrorDiagnosisSource {
  /** 卡片上给用户看的错误提示。 */
  message: string;
  /** 展开详情里的原始错误。 */
  details: string;
  reason?: string | null;
}

export function buildErrorDiagnosisPrompt(
  t: TFunction,
  sessionUrl: string,
  source: ErrorDiagnosisSource,
): string {
  const details = redactSensitiveText(source.details).trim();
  return t("session.tail.diagnosePrompt", {
    sessionUrl,
    message: redactSensitiveText(source.message).trim(),
    details: source.reason
      ? `${details}\nreason: ${redactSensitiveText(source.reason).trim()}`
      : details,
  });
}
