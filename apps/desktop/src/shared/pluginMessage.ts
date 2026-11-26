import {
  PLUGIN_REFERENCE_MATERIAL_CLOSE,
  PLUGIN_REFERENCE_MATERIAL_OPEN,
} from '@cindy/maker-shared/message-source';

/**
 * Inverse of {@link buildPluginMessage}: the plugin's visible text and its reference material.
 * Pass the stored pasted-text ranges; the split never searches the body for the markers.
 * Shared with Mobile through `@cindy/maker-shared/message-source`.
 */
export { splitPluginMessage } from '@cindy/maker-shared/message-source';

/** Plugin context remains ordinary, untrusted user-message material. */
export const PLUGIN_MESSAGE_CONTEXT_MAX_CHARS = 32768;

export function validPluginMessageContext(text: string, context: unknown): context is string | undefined {
  return context === undefined || (typeof context === 'string'
    && context.length <= PLUGIN_MESSAGE_CONTEXT_MAX_CHARS
    && text.length + context.length <= 64000);
}

export function pluginMessageText(text: string, context?: string): string {
  if (!context) return text;
  return `${text}\n\n${PLUGIN_REFERENCE_MATERIAL_OPEN}\n${context}\n${PLUGIN_REFERENCE_MATERIAL_CLOSE}`;
}

/** Reuse long-text atoms: one canonical body, plus display-only range metadata. */
export function buildPluginMessage(text: string, context: string | undefined, label: string): {
  text: string;
  pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
} {
  const message = pluginMessageText(text, context);
  return { text: message, ...(context ? {
    pastedTextRanges: [{ start: text.length + 2, end: message.length, display: label }],
  } : {}) };
}
