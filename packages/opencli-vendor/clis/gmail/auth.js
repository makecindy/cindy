import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { probeGoogleAccount, waitForGoogleReturn } from '../_shared/google-account.js';

async function readIdentity(page) {
  const result = await probeGoogleAccount(page, 'mail.google.com');
  return { email: result.email, name: result.name || null };
}

registerSiteAuthCommands({
  site: 'gmail',
  domain: 'mail.google.com',
  loginUrl: 'https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F%23inbox',
  columns: ['email', 'name'],
  verify: async (page) => {
    await page.goto('https://mail.google.com/mail/u/0/#inbox');
    await page.wait(2);
    return readIdentity(page);
  },
  poll: async (page) => {
    await waitForGoogleReturn(page, 'mail.google.com');
    return readIdentity(page);
  },
});
