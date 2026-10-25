import {
  serializeSessionReferencePayload,
  type AgentInputSessionRef,
  type AgentInputSessionReferenceContext,
  type AgentInputQueuedMessage,
} from "@cindy/maker-shared/agent-input-queue";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import {
  MAX_SESSION_REFERENCES,
  MAX_REFERENCE_MESSAGES,
  MAX_REFERENCE_TOKENS,
  estimateReferenceTokens,
} from "./sessionReferenceBudget.js";
export function createMakerInputValidation(isDeviceLinkInvoke: () => boolean) {
  const requireSessionId = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0) {
      throwIpcError("INVALID_PARAMS", "sessionId required");
    }
    return value;
  };
  const requireClientId = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0) {
      throwIpcError("INVALID_PARAMS", "clientId required");
    }
    return value;
  };
  const requireSessionRefs = (
    value: unknown,
  ): AgentInputSessionRef[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_SESSION_REFERENCES) {
      throwIpcError(
        "INVALID_PARAMS",
        `sessionRefs must contain at most ${MAX_SESSION_REFERENCES} items`,
      );
    }
    const refs = value as AgentInputSessionRef[];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (
        !ref ||
        typeof ref.sessionId !== "string" ||
        ref.sessionId.length === 0 ||
        ref.sessionId.length > 256 ||
        (ref.deviceId !== undefined &&
          (typeof ref.deviceId !== "string" || ref.deviceId.length === 0)) ||
        (typeof ref.deviceId === "string" && ref.deviceId.length > 256) ||
        (ref.messageClientId !== undefined &&
          (typeof ref.messageClientId !== "string" ||
            ref.messageClientId.length === 0 ||
            ref.messageClientId.length > 256))
      ) {
        throwIpcError(
          "INVALID_PARAMS",
          "sessionRefs contains an invalid reference",
        );
      }
      const key = `${ref.deviceId ?? ""}\u0000${ref.sessionId}\u0000${ref.messageClientId ?? ""}`;
      if (seen.has(key))
        throwIpcError("INVALID_PARAMS", "sessionRefs contains duplicates");
      seen.add(key);
    }
    return refs;
  };
  const requireTrustedReferenceContexts = (
    refs: AgentInputSessionRef[] | undefined,
    value: unknown,
  ): AgentInputSessionReferenceContext[] | undefined => {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.length > MAX_SESSION_REFERENCES ||
      value.length !== (refs?.length ?? 0)
    ) {
      throwIpcError(
        "SESSION_REFERENCE_UNAVAILABLE",
        "remote session reference snapshot count is invalid",
      );
    }
    const contexts = value as AgentInputSessionReferenceContext[];
    let totalMessages = 0;
    let totalTokens = 0;
    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      const ref = refs?.[index];
      if (
        !context ||
        typeof context.sessionId !== "string" ||
        context.sessionId.length > 256 ||
        (context.title !== undefined &&
          (typeof context.title !== "string" || context.title.length > 128)) ||
        !Array.isArray(context.messages)
      ) {
        throwIpcError(
          "SESSION_REFERENCE_UNAVAILABLE",
          "remote session reference snapshot is invalid",
        );
      }
      if (
        !ref ||
        ref.sessionId !== context.sessionId ||
        ref.messageClientId !== context.messageClientId ||
        ref.deviceId !== context.deviceId ||
        (context.source !== "local" && context.source !== "device-link") ||
        (context.source === "local" && context.deviceId !== undefined) ||
        (context.source === "device-link" &&
          typeof context.deviceId !== "string") ||
        (context.range !== "recent" && context.range !== "around-anchor") ||
        context.messageCount !== context.messages.length ||
        typeof context.truncated !== "boolean"
      ) {
        throwIpcError(
          "SESSION_REFERENCE_UNAVAILABLE",
          "remote session reference snapshot does not match the request",
        );
      }
      if (context.terminal !== undefined) {
        const terminal = context.terminal;
        if (
          !terminal ||
          typeof terminal !== "object" ||
          Array.isArray(terminal) ||
          terminal.status !== "error" ||
          (terminal.createdAt !== undefined &&
            (typeof terminal.createdAt !== "number" ||
              !Number.isFinite(terminal.createdAt)))
        ) {
          throwIpcError(
            "SESSION_REFERENCE_UNAVAILABLE",
            "remote session reference terminal status is invalid",
          );
        }
        // Strip unknown fields at this trust boundary. The marker is
        // intentionally status-only; provider error details must not cross
        // into the model prompt through a crafted remote snapshot.
        context.terminal = {
          status: "error",
          ...(terminal.createdAt !== undefined
            ? { createdAt: terminal.createdAt }
            : {}),
        };
      }
      totalMessages += context.messages.length;
      for (const message of context.messages) {
        if (
          !message ||
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.content !== "string"
        ) {
          throwIpcError(
            "SESSION_REFERENCE_UNAVAILABLE",
            "remote session reference message is invalid",
          );
        }
        totalTokens += estimateReferenceTokens(message.content);
      }
    }
    const serializedTokens = estimateReferenceTokens(
      serializeSessionReferencePayload(contexts),
    );
    if (
      totalMessages > MAX_REFERENCE_MESSAGES ||
      totalTokens > MAX_REFERENCE_TOKENS ||
      serializedTokens > MAX_REFERENCE_TOKENS - 128
    ) {
      throwIpcError(
        "SESSION_REFERENCE_UNAVAILABLE",
        "remote session reference snapshot exceeds the shared budget",
      );
    }
    return contexts;
  };
  const requireQueuedMessage = (
    value: unknown,
    opts?: { allowMissingTrustedContexts?: boolean },
  ): AgentInputQueuedMessage => {
    if (!value || typeof value !== "object")
      throwIpcError("INVALID_PARAMS", "queued message required");
    const msg = value as AgentInputQueuedMessage;
    if (typeof msg.clientId !== "string" || !msg.clientId) {
      throwIpcError("INVALID_PARAMS", "queued.clientId required");
    }
    if (typeof msg.text !== "string")
      throwIpcError("INVALID_PARAMS", "queued.text required");
    if (typeof msg.persistedContent !== "string")
      throwIpcError("INVALID_PARAMS", "queued.persistedContent required");
    if (!msg.chatMessage || typeof msg.chatMessage !== "object") {
      throwIpcError("INVALID_PARAMS", "queued.chatMessage required");
    }
    if (!msg.createOpts || typeof msg.createOpts !== "object") {
      throwIpcError("INVALID_PARAMS", "queued.createOpts required");
    }
    if (
      msg.createOpts.agentKind !== "claude-code" &&
      msg.createOpts.agentKind !== "codex" &&
      msg.createOpts.agentKind !== "pi"
    ) {
      throwIpcError("INVALID_PARAMS", "queued.createOpts.agentKind invalid");
    }
    const normalized: AgentInputQueuedMessage = { ...msg };
    delete normalized.sharedTaskAuthor;
    delete normalized.autoReviewUserText;
    delete normalized.botTaskCoordination;
    if (normalized.durableDelivery !== true) delete normalized.durableDelivery;
    // Only Main-created welcomes and restored host snapshots may carry this policy.
    delete normalized.toolsDisabled;
    delete normalized.uiLanguage;
    const refs = requireSessionRefs(normalized.sessionRefs);
    if (!isDeviceLinkInvoke()) {
      // preload/renderer 不属于可信边界，不能直接注入历史正文。
      delete normalized.trustedSessionReferenceContexts;
      delete normalized.sessionReferencesRequireTrustedSnapshot;
      return normalized;
    }
    const contexts = requireTrustedReferenceContexts(
      refs,
      normalized.trustedSessionReferenceContexts,
    );
    if ((refs?.length ?? 0) > 0)
      normalized.sessionReferencesRequireTrustedSnapshot = true;
    else delete normalized.sessionReferencesRequireTrustedSnapshot;
    if (
      (normalized.sessionRefs?.length ?? 0) > 0 &&
      !contexts &&
      !opts?.allowMissingTrustedContexts
    ) {
      throwIpcError(
        "SESSION_REFERENCE_UNAVAILABLE",
        "remote session references were not resolved by the controller",
      );
    }
    return normalized;
  };

  return {
    requireSessionId,
    requireClientId,
    requireSessionRefs,
    requireTrustedReferenceContexts,
    requireQueuedMessage,
  };
}
