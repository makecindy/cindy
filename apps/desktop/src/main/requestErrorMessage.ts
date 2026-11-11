import { redact } from './log-upload/redact';

/** Keep the original explanation (including nested fetch causes), not request/response objects. */
export function requestErrorMessage(error: unknown): string {
  try {
    const messages: string[] = [];
    for (let depth = 0; error != null && depth < 4; depth++) {
      if (typeof error !== 'object') {
        messages.push(String(error));
        break;
      }
      const value = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
      // JSON parsers can quote response contents in both the message and stack.
      if (value.name === 'SyntaxError') {
        messages.push('SyntaxError');
        break;
      }
      const message = typeof value.message === 'string' ? value.message : 'Unknown error';
      messages.push(typeof value.code === 'string' ? `${message} (${value.code})` : message);
      error = value.cause;
    }
    // Resource paths can contain account/object IDs; retain only the transport origin.
    const message = (messages.join('\nCaused by: ') || 'Unknown error').replace(/https?:\/\/\S+/gi, (url) => {
      try { return new URL(url).origin; }
      catch { return '[redacted-url]'; }
    });
    return redact(message).slice(0, 8000);
  } catch {
    return '[error message unavailable]';
  }
}
