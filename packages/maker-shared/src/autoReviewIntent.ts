export type AutoReviewUserIntent =
  | string
  | {
      readonly earlierUserMessages: readonly string[];
      readonly currentUserMessage: string;
      /** Omitted history may contain standing restrictions; never silently treat it as unrestricted. */
      readonly historyOmitted?: true;
      /**
       * Host-stamped content the current message explicitly points at. Belongs to
       * `currentUserMessage` only: appending a newer message drops it.
       */
      readonly currentUserReferences?: AutoReviewUserReferences;
    };

/**
 * What the current channel message points at, captured by the Host from channel
 * adapter / Hook source facts (never from wire-reported fields): its attachments
 * and the message(s) it replies to or quotes. Quoted text is third-party data —
 * it can show what "this" refers to, but it is not user-authored and never grants.
 */
export interface AutoReviewUserReferences {
  /** Everything delivered with this message, including attachments a channel merged in from the quote. */
  readonly attachments?: { readonly images: number; readonly files: number };
  readonly quotedMessages?: readonly AutoReviewQuotedMessage[];
}

export interface AutoReviewQuotedMessage {
  readonly author: string;
  readonly text: string;
  readonly isBot?: true;
  /** How many of `attachments` came from this quoted message; absent when the channel cannot tell. */
  readonly attachmentCount?: number;
}

/**
 * The single projection for review references. Channels map their Host-owned
 * reply/attachment facts into this shape; anything malformed is dropped and all
 * text is bounded independently of the user-intent budget. Returns undefined
 * when nothing is referenced, so unreferenced messages keep their exact intent.
 */
export function projectAutoReviewUserReferences(
  value: unknown,
): AutoReviewUserReferences | undefined {
  return sharedProjection().projectReferences(value);
}

/**
 * Separate references from user-authored intent before showing either to a
 * reviewer: references must never be presented as text the user wrote.
 */
export function splitAutoReviewUserReferences(intent: AutoReviewUserIntent): {
  intent: AutoReviewUserIntent;
  references?: AutoReviewUserReferences;
} {
  return sharedProjection().splitReferences(intent);
}

let sharedProjectionInstance: ReturnType<typeof createAutoReviewIntentProjection> | undefined;
function sharedProjection(): ReturnType<typeof createAutoReviewIntentProjection> {
  return (sharedProjectionInstance ??= createAutoReviewIntentProjection());
}

export interface AutoReviewHistoryMessage {
  clientId: string;
  role: string;
  content: unknown;
  createdAt?: number;
  agentMeta: Record<string, unknown> | null;
}

/** Dependency-free factory shared by harnesses and both database worker transports. */
export function createAutoReviewIntentProjection() {
  const MAX_USER_INTENT_CHARS = 2_000;
  const OMITTED_USER_INTENT =
    "User message omitted because it exceeds the review budget; it cannot establish authorization.";

  function compactCurrentUserIntent(
    text: string,
    maxChars = MAX_USER_INTENT_CHARS,
  ): string {
    const normalized = text.trim();
    if (normalized.length <= maxChars) return normalized;
    return OMITTED_USER_INTENT;
  }

  // Kept inside the factory: the database worker evaluates this function's source.
  const MAX_REFERENCED_QUOTES = 3;
  const MAX_REFERENCED_AUTHOR_CHARS = 80;
  const MAX_REFERENCED_QUOTE_CHARS = 600;
  const MAX_REFERENCED_QUOTES_TOTAL_CHARS = 1_200;
  const MAX_REFERENCED_COUNT = 99;
  const REFERENCE_TRUNCATED = "…[truncated]";

  function boundedReferenceText(value: string, maxChars: number): string {
    const text = value.trim();
    return text.length <= maxChars
      ? text
      : `${text.slice(0, Math.max(0, maxChars - REFERENCE_TRUNCATED.length))}${REFERENCE_TRUNCATED}`;
  }

  function referenceCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(Math.floor(value), MAX_REFERENCED_COUNT)
      : 0;
  }

  function projectAutoReviewUserReferences(
    value: unknown,
  ): AutoReviewUserReferences | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const rawAttachments =
      input.attachments && typeof input.attachments === "object" && !Array.isArray(input.attachments)
        ? (input.attachments as Record<string, unknown>)
        : {};
    const images = referenceCount(rawAttachments.images);
    const files = referenceCount(rawAttachments.files);
    const quotedMessages: AutoReviewQuotedMessage[] = [];
    let remaining = MAX_REFERENCED_QUOTES_TOTAL_CHARS;
    // The newest quotes are the ones nearest the user's words.
    const rawQuotes = Array.isArray(input.quotedMessages)
      ? input.quotedMessages.slice(-MAX_REFERENCED_QUOTES)
      : [];
    for (const raw of rawQuotes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const quote = raw as Record<string, unknown>;
      if (typeof quote.text !== "string" || !quote.text.trim() || remaining <= REFERENCE_TRUNCATED.length) continue;
      const text = boundedReferenceText(quote.text, Math.min(MAX_REFERENCED_QUOTE_CHARS, remaining));
      remaining -= text.length;
      const attachmentCount = referenceCount(quote.attachmentCount);
      quotedMessages.push({
        author: boundedReferenceText(
          typeof quote.author === "string" ? quote.author : "",
          MAX_REFERENCED_AUTHOR_CHARS,
        ),
        text,
        ...(quote.isBot === true ? { isBot: true as const } : {}),
        ...(attachmentCount > 0 ? { attachmentCount } : {}),
      });
    }
    if (images === 0 && files === 0 && quotedMessages.length === 0) return undefined;
    return {
      ...(images > 0 || files > 0 ? { attachments: { images, files } } : {}),
      ...(quotedMessages.length > 0 ? { quotedMessages } : {}),
    };
  }

  function splitAutoReviewUserReferences(intent: AutoReviewUserIntent): {
    intent: AutoReviewUserIntent;
    references?: AutoReviewUserReferences;
  } {
    if (typeof intent === "string") return { intent };
    const { currentUserReferences, ...authored } = intent;
    const references = projectAutoReviewUserReferences(currentUserReferences);
    if (!references) return { intent: authored };
    // Attaching references may have promoted a plain string intent to object form.
    return {
      intent:
        authored.earlierUserMessages.length === 0 && !authored.historyOmitted
          ? authored.currentUserMessage
          : authored,
      references,
    };
  }

  /** References have their own budget; they never displace authored history or restrictions. */
  function withAutoReviewUserReferences(
    intent: AutoReviewUserIntent,
    references: unknown,
  ): AutoReviewUserIntent {
    const projected = projectAutoReviewUserReferences(references);
    if (!projected) return intent;
    return typeof intent === "string"
      ? { earlierUserMessages: [], currentUserMessage: intent, currentUserReferences: projected }
      : { ...intent, currentUserReferences: projected };
  }

  function normalizeAutoReviewUserIntent(
    intent: AutoReviewUserIntent,
  ): AutoReviewUserIntent {
    if (typeof intent === "string") return compactCurrentUserIntent(intent);
    const { currentUserReferences, ...authored } = intent;
    if (currentUserReferences === undefined) return normalizeAuthoredUserIntent(authored);
    // A wrapper that only carries references must not count against the authored budget.
    const base =
      authored.earlierUserMessages.length === 0 && !authored.historyOmitted
        ? authored.currentUserMessage
        : authored;
    return withAutoReviewUserReferences(
      normalizeAuthoredUserIntent(base),
      currentUserReferences,
    );
  }

  function normalizeAuthoredUserIntent(
    intent: AutoReviewUserIntent,
  ): AutoReviewUserIntent {
    if (typeof intent === "string") return compactCurrentUserIntent(intent);
    const currentUserMessage = compactCurrentUserIntent(
      intent.currentUserMessage,
    );
    const candidate = {
      earlierUserMessages: [...intent.earlierUserMessages],
      currentUserMessage,
      ...(intent.historyOmitted ? { historyOmitted: true as const } : {}),
    };
    if (
      currentUserMessage !== OMITTED_USER_INTENT &&
      JSON.stringify(candidate).length <= MAX_USER_INTENT_CHARS
    )
      return candidate;
    // Drop all earlier grants together, flag the missing restrictions, and never sample the latest text.
    const omitted = {
      earlierUserMessages: [],
      currentUserMessage,
      historyOmitted: true as const,
    };
    return JSON.stringify(omitted).length <= MAX_USER_INTENT_CHARS
      ? omitted
      : { ...omitted, currentUserMessage: OMITTED_USER_INTENT };
  }

  function appendAutoReviewUserIntent(
    previous: AutoReviewUserIntent | undefined,
    text: string,
  ): AutoReviewUserIntent {
    const latest = text.trim();
    if (!latest || previous === undefined || previous === "")
      return compactCurrentUserIntent(latest);
    const earlierUserMessages =
      typeof previous === "string"
        ? [previous]
        : [...previous.earlierUserMessages, previous.currentUserMessage];
    return normalizeAutoReviewUserIntent({
      earlierUserMessages,
      currentUserMessage: latest,
      ...(typeof previous !== "string" && previous.historyOmitted
        ? { historyOmitted: true as const }
        : {}),
    });
  }
  function interactionAnswer(
    message: AutoReviewHistoryMessage,
  ): { text: string; acceptedAt: number } | null {
    if (message.role !== "ask_user" && message.role !== "plan_review")
      return null;
    const value = message.agentMeta?.autoReviewUserText;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const answer = value as Record<string, unknown>;
    return typeof answer.text === "string" &&
      typeof answer.acceptedAt === "number" &&
      Number.isFinite(answer.acceptedAt)
      ? { text: answer.text, acceptedAt: answer.acceptedAt }
      : null;
  }

  function readAutoReviewUserText(content: unknown): string | null {
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        return content as string;
      }
    }
    if (!content || typeof content !== "object" || Array.isArray(content))
      return null;
    const value = content as Record<string, unknown>;
    if (typeof value.text !== "string") return null;
    if (
      value.quotesEncoded === true ||
      [
        "images",
        "files",
        "mentions",
        "sessionReferences",
        "agentReferences",
        "references",
        "pastedTextRanges",
      ].some((key) => Array.isArray(value[key]) && value[key].length > 0)
    )
      return null;
    return value.text;
  }

  function ambiguousAnswers(
    history: readonly AutoReviewHistoryMessage[],
  ): boolean {
    const counts = new Map<number, number>();
    const times = history.map(
      (message, index) =>
        interactionAnswer(message)?.acceptedAt ?? message.createdAt ?? index,
    );
    times.forEach((at) => counts.set(at, (counts.get(at) ?? 0) + 1));
    return history.some(
      (message, index) =>
        interactionAnswer(message) !== null && counts.get(times[index]!)! > 1,
    );
  }

  function isSynthetic(message: AutoReviewHistoryMessage): boolean {
    if (message.role !== "user") return false;
    const meta = message.agentMeta;
    const receipt = meta?.autoReviewUserText;
    return !!(meta?.autoResume || meta?.contextRebuild ||
      (receipt && typeof receipt === "object" && "kind" in receipt &&
        (receipt.kind === "scheduled-continuation" || receipt.kind === "delegated-continuation")));
  }

  function restoreAutoReviewUserIntent(
    history: readonly AutoReviewHistoryMessage[],
    current?: { clientId: string; content: unknown; authoredText?: string },
  ): AutoReviewUserIntent {
    history = history.filter((message) => !isSynthetic(message));
    let intent: AutoReviewUserIntent = "";
    let replayed = false;
    let omitted = false;
    const latest = current
      ? (current.authoredText ?? readAutoReviewUserText(current.content))
      : null;
    // Cards are created before the user answers; their acceptance time orders authority.
    const ordered = history
      .map((message, index) => ({
        message,
        index,
        at:
          interactionAnswer(message)?.acceptedAt ?? message.createdAt ?? index,
      }))
      .sort((a, b) => a.at - b.at || a.index - b.index);
    if (ambiguousAnswers(history)) return "";
    for (let index = 0; index < ordered.length; index++) {
      const { message } = ordered[index]!;
      if (message.role === "ask_user" || message.role === "plan_review") {
        const answer = interactionAnswer(message);
        if (!answer) {
          intent = "";
          continue;
        }
        // Millisecond ties cannot establish whether a card overrode a newer restriction.
        if (answer.text)
          intent = appendAutoReviewUserIntent(intent, answer.text);
        continue;
      }
      if (message.role !== "user") continue;
      // An already-persisted retry is the same input, not a second authorization.
      if (current && message.clientId === current.clientId) {
        if (message.agentMeta?.autoReviewUserText !== latest) return "";
        replayed = true;
      }
      const meta = message.agentMeta;
      const text = meta?.autoReviewUserText;
      if (typeof text === "string" && text.startsWith("[UI_ACTION_TRIGGER]"))
        omitted = true;
      // delivery/wire alone are not authorship proof: plugin rewrites have the same shape.
      // Old rows without Host-captured text cannot safely restore authorization.
      if (
        typeof text !== "string" ||
        !["turn", "steer"].includes(String(meta?.delivery))
      ) {
        intent = "";
        continue;
      }
      if (readAutoReviewUserText(message.content) === null) intent = "";
      intent = appendAutoReviewUserIntent(intent, text);
    }
    if (replayed || !current) return withOmission(intent, omitted);
    if (readAutoReviewUserText(current.content) === null) intent = "";
    return withOmission(latest !== null ? appendAutoReviewUserIntent(intent, latest) : "", omitted);
  }
  function reviewState(
    history: readonly AutoReviewHistoryMessage[],
    historyComplete = true,
  ): { intent: AutoReviewUserIntent; unverified: boolean } {
    history = history.filter((message) => !isSynthetic(message));
    let intent: AutoReviewUserIntent = "";
    let omitted = !historyComplete;
    const eventTime = (m: AutoReviewHistoryMessage): number => {
      const receipt = m.agentMeta?.autoReviewUserText;
      if (
        (m.role === "ask_user" || m.role === "plan_review") &&
        receipt &&
        typeof receipt === "object" &&
        "acceptedAt" in receipt &&
        typeof receipt.acceptedAt === "number" &&
        Number.isFinite(receipt.acceptedAt)
      ) {
        return receipt.acceptedAt;
      }
      return m.createdAt ?? 0;
    };
    const times = new Set<number>();
    for (const m of [...history].sort((a, b) => eventTime(a) - eventTime(b))) {
      const receipt = m.agentMeta?.autoReviewUserText;
      // Empty authored receipts reset earlier resource consent and need ordering too.
      const authored =
        typeof receipt === "string" ||
        (receipt &&
          typeof receipt === "object" &&
          "text" in receipt &&
          typeof receipt.text === "string");
      if (authored) {
        const at = eventTime(m);
        if (!Number.isFinite(at) || at <= 0 || times.has(at)) omitted = true;
        times.add(at);
      }
      if (m.role === "ask_user" || m.role === "plan_review") {
        // A card answer can constrain the task, but an unanswered card grants nothing.
        if (
          receipt &&
          typeof receipt === "object" &&
          "text" in receipt &&
          typeof receipt.text === "string" &&
          "acceptedAt" in receipt &&
          typeof receipt.acceptedAt === "number" &&
          Number.isFinite(receipt.acceptedAt)
        ) {
          if (receipt.text)
            intent = appendAutoReviewUserIntent(intent, receipt.text);
        } else {
          // Legacy/unverified cards may contain restrictions; absence is not consent.
          omitted = true;
        }
      } else if (m.role === "user") {
        // Legacy UI triggers and literal user text share this string receipt.
        // Keep restrictions, but do not let ambiguous provenance establish Auto consent.
        if (typeof receipt === "string" && receipt.startsWith("[UI_ACTION_TRIGGER]"))
          omitted = true;
        if (
          typeof receipt === "string" &&
          ["turn", "steer"].includes(String(m.agentMeta?.delivery))
        ) {
          if (readAutoReviewUserText(m.content) === null) intent = "";
          intent = appendAutoReviewUserIntent(intent, receipt);
        } else {
          omitted = true;
        }
      }
    }
    return { intent, unverified: omitted };
  }

  function withOmission(
    intent: AutoReviewUserIntent,
    omitted: boolean,
  ): AutoReviewUserIntent {
    if (!omitted) return intent;
    return typeof intent === "string"
      ? {
          earlierUserMessages: [],
          currentUserMessage: intent,
          historyOmitted: true,
        }
      : { ...intent, historyOmitted: true };
  }

  return {
    compact: compactCurrentUserIntent,
    normalize: normalizeAutoReviewUserIntent,
    withReferences: withAutoReviewUserReferences,
    projectReferences: projectAutoReviewUserReferences,
    splitReferences: splitAutoReviewUserReferences,
    append: appendAutoReviewUserIntent,
    readText: readAutoReviewUserText,
    restore: restoreAutoReviewUserIntent,
    ambiguousAnswers,
    isSynthetic,
    reviewState,
    withOmission,
    review: (history: readonly AutoReviewHistoryMessage[], complete = true) => {
      const state = reviewState(history, complete);
      return withOmission(state.intent, state.unverified);
    },
  };
}
