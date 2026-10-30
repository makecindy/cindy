import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { probeGoogleAccount, waitForGoogleReturn } from '../_shared/google-account.js';

async function readIdentity(page) {
  const result = await probeGoogleAccount(page, 'gemini.google.com');
  return { name: result.name };
}

registerSiteAuthCommands({
  site: 'gemini',
  domain: 'gemini.google.com',
  loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2F',
  columns: ['name'],
  verify: async (page) => {
    await page.goto('https://gemini.google.com/app');
    await page.wait(3);
    return readIdentity(page);
  },
  poll: async (page) => {
    await waitForGoogleReturn(page, 'gemini.google.com');
    return readIdentity(page);
  },
});
