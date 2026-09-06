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

/** Prepare selected, visible content only; source URLs never enter the export document. */
export async function prepareConversationShareImages(
  messages: readonly ConversationShareMessage[],
  load: (url: string) => Promise<ConversationShareImage | null>,
  context: ConversationShareImageContext = {},
  isActive: () => boolean = () => true,
): Promise<ConversationShareMessage[]> {
  const result: ConversationShareMessage[] = [];
  // Per-export byte reuse. Native renderers mount only the budgeted result.
  const loaded = new Map<string, ConversationShareImage | null>();
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
      if (!isActive()) return [];
      let image = loaded.get(url);
      if (!loaded.has(url)) {
        const candidate =
          remainingCharacters > 0 && remainingPixels > 0
            ? await load(url).catch(() => null)
            : null;
        image =
          candidate && candidate.uri.length <= remainingCharacters
            ? candidate
            : null;
        if (!image) loaded.set(url, null);
      }
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
        pixels <= MAX_IMAGE_PIXELS &&
        pixels * occurrences <= remainingPixels &&
        image.uri.length * occurrences <= remainingCharacters
      ) {
        // Retain bytes only once they fit an output occurrence budget.
        loaded.set(url, image);
        images.set(source, image);
        // Byte reuse saves reads, but each rendered occurrence embeds a URI.
        remainingCharacters -= image.uri.length * occurrences;
        remainingPixels -= pixels * occurrences;
      }
    }
    result.push({ ...message, images });
  }
  return result;
}
