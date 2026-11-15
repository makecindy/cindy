/** Public application identity only; never include account, task or device data. */
const APP_URL = 'https://cindy.app';

/**
 * Provider-documented attribution, scoped to the actual destination (not a model
 * name or preset). Explicit connection headers, including empty values and the
 * legacy X-Title alias, take precedence over Cindy and SDK defaults.
 * https://openrouter.ai/docs/app-attribution
 * https://vercel.com/docs/ai-gateway/ecosystem/app-attribution
 * https://docs.requesty.ai/quickstart
 */
export function withProviderAppAttribution(
  upstream: string,
  headers: Readonly<Record<string, string>> = {},
  sdkHeaders: Readonly<Record<string, string>> = {},
  headerDelete: readonly string[] = [],
): Record<string, string> {
  const result = { ...sdkHeaders, ...headers };
  let origin: string;
  try { origin = new URL(upstream).origin; } catch { return result; }
  const openRouter = origin === 'https://openrouter.ai';
  if (!openRouter && origin !== 'https://ai-gateway.vercel.sh' &&
      origin !== 'https://router.requesty.ai' && origin !== 'https://router.eu.requesty.ai') {
    return result;
  }
  const explicit = new Set(Object.keys(headers).map(name => name.toLowerCase()));
  const deleted = new Set(headerDelete.map(name => name.toLowerCase()));
  const setDefault = (name: string, value: string, aliases: string[] = []) => {
    const names = new Set([name.toLowerCase(), ...aliases]);
    // SDK identity is not the user's explicit attribution. Remove its aliases
    // too so an inherited "pi" title cannot compete with Cindy on the wire.
    for (const key of Object.keys(result)) {
      if (names.has(key.toLowerCase()) && !Object.hasOwn(headers, key)) delete result[key];
    }
    if (![...names].some(key => explicit.has(key) || deleted.has(key))) result[name] = value;
  };
  setDefault('HTTP-Referer', APP_URL);
  setDefault(openRouter ? 'X-OpenRouter-Title' : 'X-Title', 'Cindy',
    openRouter ? ['x-title'] : []);
  return result;
}
