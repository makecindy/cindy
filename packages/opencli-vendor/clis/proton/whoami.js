import { AuthRequiredError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { MAIL_DOMAIN, openMail, readIdentity } from './helpers.js';

cli({
  site: 'proton', name: 'whoami', access: 'read',
  description: 'Show the Proton account verified by the authenticated Mail API',
  domain: MAIL_DOMAIN, strategy: Strategy.COOKIE, browser: true,
  siteSession: 'persistent', navigateBefore: false,
  args: [], columns: ['logged_in', 'site', 'id', 'username', 'email'],
  authStatus: {
    quickCheck: async (page) => {
      try { await readIdentity(page); return { logged_in: true }; }
      catch (error) {
        if (error instanceof AuthRequiredError) return { logged_in: false };
        throw error;
      }
    },
  },
  func: async (page) => {
    await openMail(page);
    return { logged_in: true, site: 'proton', ...await readIdentity(page) };
  },
});
