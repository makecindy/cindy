import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { MAIL_DOMAIN, openMail, request, listMessages, readMessage, pickCode, requirePositiveInt } from './helpers.js';

cli({
  site: 'proton', name: 'inbox', access: 'read',
  description: 'List sender-filtered inbox metadata via API; optionally read the newest message for a code',
  example: 'opencli proton inbox --from ifood --read-code -f json',
  domain: MAIL_DOMAIN, strategy: Strategy.COOKIE, browser: true,
  siteSession: 'persistent', navigateBefore: false,
  args: [
    { name: 'from', type: 'str', help: 'Case-insensitive substring of the sender name or address' },
    { name: 'limit', type: 'int', default: 20, help: 'Maximum matching messages (1..100)' },
    { name: 'since', type: 'int', default: 0, help: 'Only messages at or after this Unix timestamp (seconds)' },
    { name: 'read-code', type: 'bool', default: false, help: 'Open the newest match and extract a code; may mark that message read' },
    { name: 'timeout', type: 'int', default: 30, help: 'Seconds to wait for selected message decryption (1..900)' },
  ],
  columns: ['id', 'sender', 'subject', 'time', 'code'],
  func: async (page, kwargs) => {
    const limit = requirePositiveInt(kwargs.limit, 20, 100, '--limit');
    const timeout = requirePositiveInt(kwargs.timeout, 30, 900, '--timeout');
    const since = Number(kwargs.since ?? 0);
    if (!Number.isSafeInteger(since) || since < 0) throw new ArgumentError('--since must be a non-negative Unix timestamp in seconds');
    const sender = String(kwargs.from ?? '').trim();
    await openMail(page);
    const identity = await request(page, 'identity');
    const expected = { id: identity.account.id, localID: identity.localID };
    const { messages, localID } = await listMessages(page, sender, limit, since, expected);
    if (!messages.length) throw new EmptyResultError('proton inbox', 'No inbox messages matched the sender and time filters.');
    let code = null;
    if (kwargs['read-code']) {
      const { text } = await readMessage(page, messages[0], localID, timeout, expected);
      code = pickCode(`${messages[0].subject}\n${text}`) || null;
    }
    return messages.map((message, index) => ({
      id: message.id,
      sender: message.address,
      subject: message.subject,
      time: message.timestamp,
      code: index === 0 ? code : null,
    }));
  },
});
