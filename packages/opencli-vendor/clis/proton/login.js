import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { MAIL_DOMAIN, MAIL_URL, openMail, readIdentity } from './helpers.js';

registerSiteAuthCommands({
  site: 'proton',
  domain: MAIL_DOMAIN,
  loginUrl: MAIL_URL,
  registerWhoami: false,
  columns: ['id', 'username', 'email'],
  verify: async (page) => {
    await openMail(page);
    return readIdentity(page);
  },
  poll: readIdentity,
});
