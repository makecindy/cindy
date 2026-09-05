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

/** Prepare selected, visible content only; source URLs never enter the export document. */
export async function prepareConversationShareImages(
  messages: readonly ConversationShareMessage[],
  load: (url: string) => Promise<ConversationShareImage | null>,
  context: ConversationShareImageContext = {},
  isActive: () => boolean = () => true,
): Promise<ConversationShareMessage[]> {
  const result: ConversationShareMessage[] = [];
  // Per-export reuse, with sequential reads to bound simultaneous decoded images.
  const loaded = new Map<string, ConversationShareImage | null>();
  let remainingCharacters = 32 * 1024 * 1024;
  for (const message of messages) {
    if (!isActive()) return [];
    const sources = new Map<string, string>();
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "image" && attachment.uri) {
        sources.set(attachment.uri, attachment.uri);
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
        if (url) sources.set(image.url, url);
      }
    }
    const images = new Map<string, ConversationShareImage>();
    for (const [source, url] of sources) {
      if (!isActive()) return [];
      if (!loaded.has(url)) {
        const candidate =
          remainingCharacters > 0 ? await load(url).catch(() => null) : null;
        const image =
          candidate && candidate.uri.length <= remainingCharacters
            ? candidate
            : null;
        if (image) remainingCharacters -= image.uri.length;
        loaded.set(url, image);
      }
      const image = loaded.get(url);
      if (
        image &&
        image.uri.startsWith("data:image/") &&
        Number.isFinite(image.width) &&
        Number.isFinite(image.height) &&
        image.width > 0 &&
        image.height > 0
      ) {
        images.set(source, image);
      }
    }
    result.push({ ...message, images });
  }
  return result;
}
