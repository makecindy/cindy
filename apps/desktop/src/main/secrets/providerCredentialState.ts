/** Shared strict credential states; unreadable encrypted data is never absence. */
export const UNRECOVERABLE_PROVIDER_CREDENTIAL = Symbol('unrecoverable-provider-credential');
export type UnrecoverableProviderCredential = typeof UNRECOVERABLE_PROVIDER_CREDENTIAL;

export function parseCustomProviderHeaders(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('custom provider headers must be an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([name, headerValue]) => !name || typeof headerValue !== 'string')) {
    throw new Error('custom provider headers must be string pairs');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
