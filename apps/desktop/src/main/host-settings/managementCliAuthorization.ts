import { cloudManagementExecution } from './managementCalls.js';
import { openManagementAuthorization } from './managementAuthorization.js';

/** Present only the bundled CLI's own login URL. The CLI remains the sole
 * verifier, exchanger and credential writer; short callback input is never stored. */
export function cloudCliAuthorization(writeLine: (line: string) => void): ((output: string) => Promise<void>) | undefined {
  const execution = cloudManagementExecution();
  if (!execution) return undefined;
  let buffer = '', presented = false;
  return async (output) => {
    if (presented) return;
    execution.assertCurrent();
    buffer = (buffer + output).slice(-32_768);
    // Strip terminal hyperlinks and styling from the official CLI's fallback line.
    // eslint-disable-next-line no-control-regex
    const plain = buffer.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, '');
    // eslint-disable-next-line no-control-regex
    const line = plain.match(/If the browser didn't open, visit: (https:\/\/[^\s\x00-\x1f]+)\r?\n/);
    if (!line) return;
    const url = new URL(line[1]!);
    if (url.username || url.password) throw new Error('MANAGEMENT_AUTH_URL_INVALID');
    const redirect = url.searchParams.get('redirect_uri');
    if (!redirect) throw new Error('MANAGEMENT_AUTH_CALLBACK_INVALID');
    const callback = new URL(redirect);
    presented = true;
    if (callback.protocol === 'http:') {
      await openManagementAuthorization(url.href, async () => {});
      return;
    }
    // Official CLI also prints a manual code URL. Forward its code#state to CLI stdin,
    // without changing redirect_uri or implementing any token exchange in Cindy.
    const state = url.searchParams.get('state');
    if (callback.protocol !== 'https:' || callback.username || callback.password || !state)
      throw new Error('MANAGEMENT_AUTH_CALLBACK_INVALID');
    let used = false;
    execution.prompt({ kind: 'callback', url: url.href, expiresAt: Date.now() + 5 * 60_000 }, async (value) => {
      execution.assertCurrent();
      const parts = value.trim().split('#');
      // eslint-disable-next-line no-control-regex
      if (used || parts.length !== 2 || !parts[0] || parts[1] !== state || /[\s\x00-\x1f]/.test(value))
        throw new Error('MANAGEMENT_AUTH_CALLBACK_INVALID');
      writeLine(`${parts[0]}#${parts[1]}\n`);
      used = true;
    });
  };
}
