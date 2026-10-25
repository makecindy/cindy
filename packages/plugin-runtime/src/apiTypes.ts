/** Host transport options shared by the plugin catalog and publisher. */
export interface PluginApiFetchOptions {
  method?: string;
  body?: unknown;
  bodyFactory?: () => unknown;
  headers?: Record<string, string>;
  cache?: RequestCache;
  token?: string | null;
  skipAutoRefresh?: boolean;
  skipSessionInvalidation?: boolean;
  timeoutMs?: number;
  redactErrorDetails?: boolean;
  logLabel?: string;
  allowedRedactedErrorCodes?: readonly string[];
}
