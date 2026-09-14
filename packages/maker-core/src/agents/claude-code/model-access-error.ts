/** Recognize model authorization failures without treating every 403 as one. */
export function isModelAccessDenied(message: string, errorStatus?: number): boolean {
  const jsonStart = message.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const payload: unknown = JSON.parse(message.slice(jsonStart));
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const error = payload.error;
        if (error && typeof error === 'object') {
          if (('type' in error && error.type === 'user_model_access_denied')
            || ('code' in error && error.code === 'user_model_access_denied')) return true;
        }
      }
    } catch {
      // SDKs may flatten or truncate an upstream JSON error. Only the specific
      // denial phrase paired with an HTTP status is a safe textual fallback.
    }
  }
  const forbidden = errorStatus === 403
    || /\b(?:API Error:|HTTP(?: status)?[:=]?|status(?:_code)?["']?\s*[:=])\s*["']?403\b/i.test(message);
  return forbidden && /\buser not allowed to access model\b/i.test(message);
}
