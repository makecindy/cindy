import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

const WHOAMI_PROBE = `(async () => {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        return { kind: 'auth', detail: 'ChatGPT /api/auth/session HTTP ' + res.status };
      }
      if (!res.ok) return { kind: 'http', httpStatus: res.status };
      const d = await res.json();
      const user = d && d.user;
      if (!user || !user.id) {
        return { kind: 'auth', detail: 'ChatGPT /api/auth/session has no user — anonymous' };
      }
      return { ok: true, user_id: String(user.id), name: String(user.name || '') };
    } catch (e) {
      return { kind: 'exception', detail: String(e && e.message || e) };
    }
  })()`;

async function probeChatgptIdentity(page) {
  const result = await page.evaluate(WHOAMI_PROBE);
  if (result?.kind === 'auth') throw new AuthRequiredError('chatgpt.com', result.detail);
  if (result?.kind === 'http') throw new CommandExecutionError(`HTTP ${result.httpStatus} from /api/auth/session`);
  if (result?.kind === 'exception') throw new CommandExecutionError(`ChatGPT whoami failed: ${result.detail}`);
  if (!result?.ok) throw new CommandExecutionError(`Unexpected ChatGPT probe: ${JSON.stringify(result)}`);
  return { user_id: result.user_id, name: result.name };
}

registerSiteAuthCommands({
  site: 'chatgpt',
  domain: 'chatgpt.com',
  loginUrl: 'https://auth.openai.com/log-in',
  columns: ['user_id', 'name'],
  verify: async (page) => {
    await page.goto('https://chatgpt.com/');
    await page.wait(2);
    return probeChatgptIdentity(page);
  },
  poll: async (page) => {
    const host = await page.evaluate('location.hostname');
    if (host !== 'chatgpt.com') throw new AuthRequiredError('chatgpt.com', 'Waiting for ChatGPT sign-in to return');
    return probeChatgptIdentity(page);
  },
});
