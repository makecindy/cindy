import {
  collectMobileMarkdownImages,
  mobileMarkdownImageUrlForWorkdir,
} from "@/session/messageMarkdown";
import type {
  ConversationShareImage,
  ConversationShareMessage,
} from "@/session/conversationShareWebViewHtml";

export interface ConversationShareImageContext {
  workdir?: string;
  remoteHostId?: string;
  sessionId?: string;
}

// Compressed bytes do not bound native bitmap memory. Charge every rendered
// occurrence before either HTML or SVG can mount it (RGBA: 16 / 32 MB).
const MAX_IMAGE_PIXELS = 4_000_000;
const MAX_EXPORT_IMAGE_PIXELS = 8_000_000;
const IMAGE_PREPARATION_CONCURRENCY = 3;

/** Prepare selected, visible content only; source URLs never enter the export document. */
export async function prepareConversationShareImages(
  messages: readonly ConversationShareMessage[],
  load: (url: string) => Promise<ConversationShareImage | null>,
  context: ConversationShareImageContext = {},
  isActive: () => boolean = () => true,
): Promise<ConversationShareMessage[]> {
  const result: ConversationShareMessage[] = [];
  // Group references before starting IO so a stalled source cannot prevent
  // independent sources in later messages from reaching a free worker.
  const requests = new Map<
    string,
    Array<{
      source: string;
      occurrences: number;
      images: Map<string, ConversationShareImage>;
    }>
  >();
  let remainingCharacters = 32 * 1024 * 1024;
  let remainingPixels = MAX_EXPORT_IMAGE_PIXELS;
  for (const message of messages) {
    if (!isActive()) return [];
    const sources = new Map<string, { url: string; occurrences: number }>();
    const addSource = (source: string, url: string) => {
      sources.set(source, {
        url,
        occurrences: (sources.get(source)?.occurrences ?? 0) + 1,
      });
    };
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "image" && attachment.uri) {
        addSource(attachment.uri, attachment.uri);
      }
    }
    const texts = message.bodyParts
      ? message.bodyParts.flatMap((part) =>
          part.kind === "text" ? [part.text] : [],
        )
      : [message.body];
    if (message.secondaryBody) texts.push(message.secondaryBody);
    for (const text of texts) {
      for (const image of collectMobileMarkdownImages(text)) {
        const url = mobileMarkdownImageUrlForWorkdir(
          image.url,
          context.workdir,
          message.clientId,
          context.remoteHostId,
          context.sessionId,
        );
        if (url) addSource(image.url, url);
      }
    }
    const images = new Map<string, ConversationShareImage>();
    for (const [source, { url, occurrences }] of sources) {
      const references = requests.get(url) ?? [];
      references.push({ source, occurrences, images });
      requests.set(url, references);
    }
    result.push({ ...message, images });
  }
  const pending = requests.entries();
  const worker = async () => {
    while (isActive() && remainingCharacters > 0 && remainingPixels > 0) {
      const next = pending.next();
      if (next.done) return;
      const [url, references] = next.value;
      let image: ConversationShareImage | null;
      try {
        image = await load(url);
      } catch {
        continue;
      }
      if (!isActive()) return;
      const pixels = image
        ? Math.ceil(image.width) * Math.ceil(image.height)
        : 0;
      if (
        image &&
        image.uri.startsWith("data:image/") &&
        Number.isFinite(image.width) &&
        Number.isFinite(image.height) &&
        image.width > 0 &&
        image.height > 0 &&
        pixels <= MAX_IMAGE_PIXELS
      ) {
        // Admission is synchronous: completed sources share one budget owner.
        // No unbounded completed-image buffer; rejected candidates are released.
        // Readiness decides admission, while render order stays in the messages.
        for (const { source, occurrences, images } of references) {
          if (
            pixels * occurrences <= remainingPixels &&
            image.uri.length * occurrences <= remainingCharacters
          ) {
            images.set(source, image);
            remainingCharacters -= image.uri.length * occurrences;
            remainingPixels -= pixels * occurrences;
          }
        }
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(IMAGE_PREPARATION_CONCURRENCY, requests.size) },
      worker,
    ),
  );
  return isActive() ? result : [];
}
