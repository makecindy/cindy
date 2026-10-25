import type { Logger } from "@cindy/maker-core";
import type { createImAccountBoundary } from "./accountBoundary";
export interface MessageIngressHost extends Pick<
  ReturnType<typeof createImAccountBoundary>,
  | "captureImAccountGeneration"
  | "runInImAccountGeneration"
  | "isImAccountScopeClosedError"
> {
  createLogger(scope: string): Pick<Logger, "info" | "warn" | "error">;
  getControlScope(botId: string, userId: string): string | null;
  isInControl(botId: string, userId: string): boolean;
  looksLikeSlashCommand(text: string): boolean;
}
