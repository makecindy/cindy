import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { probeGoogleAccount, waitForGoogleReturn } from '../_shared/google-account.js';

async function readIdentity(page) {
  const result = await probeGoogleAccount(page, 'notebooklm.google.com');
  return { name: result.name, authuser: result.authuser };
}

registerSiteAuthCommands({
  site: 'notebooklm',
  domain: 'notebooklm.google.com',
  loginUrl: 'https://accounts.google.com/ServiceLogin?service=lso&continue=https%3A%2F%2Fnotebooklm.google.com%2F',
  columns: ['name', 'authuser'],
  verify: async (page) => {
    await page.goto('https://notebooklm.google.com/');
    await page.wait(3);
    return readIdentity(page);
  },
  poll: async (page) => {
    await waitForGoogleReturn(page, 'notebooklm.google.com');
    return readIdentity(page);
  },
});
