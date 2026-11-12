import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';

export const MAIL_DOMAIN = 'mail.proton.me';
export const MAIL_URL = 'https://mail.proton.me/';

export function requirePositiveInt(value, fallback, max, label) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ArgumentError(`${label} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

// Runs entirely in the browser. Never return session credentials or User.Keys.
export async function requestInPage(operation, params = {}, expected = null) {
  if (location.origin !== 'https://mail.proton.me') return { failure: 'auth' };
  const localID = location.pathname.match(/^\/u\/(\d+)(?:\/|$)/)?.[1];
  if (localID === undefined) return { failure: 'auth' };
  let session;
  try { session = JSON.parse(localStorage.getItem(`ps-${localID}`) || 'null'); }
  catch { return { failure: 'auth' }; }
  const uid = session?.UID;
  const userID = session?.UserID;
  if (typeof uid !== 'string' || !uid || typeof userID !== 'string' || !userID) return { failure: 'auth' };
  if (expected && (expected.localID !== localID || expected.id !== userID)) return { failure: 'auth' };
  const sameSession = () => {
    const current = JSON.parse(localStorage.getItem(`ps-${localID}`) || 'null');
    return location.pathname.split('/')[2] === localID && current?.UID === uid && current?.UserID === userID;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Derive the version from the deployed client rather than pinning a stale one.
    const script = Array.from(document.scripts).find((el) => {
      const url = new URL(el.src, location.href);
      return url.origin === location.origin && /^\/assets\/static\/index\.[\w-]+\.js$/.test(url.pathname);
    });
    if (!script) return { failure: 'client' };
    const source = await fetch(script.src, { credentials: 'same-origin', signal: controller.signal });
    if (!source.ok) return { failure: 'http', status: source.status };
    const version = (await source.text()).match(/APP_NAME:\s*["']proton-mail["'],\s*APP_VERSION:\s*["']([\d.]+)["']/)?.[1];
    if (!version) return { failure: 'client' };
    const routes = { identity: 'core/v4/users', messages: 'mail/v4/messages', settings: 'mail/v4/settings' };
    if (!Object.hasOwn(routes, operation)) return { failure: 'shape' };
    const url = new URL(`/api/${routes[operation]}`, location.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url.href, {
      credentials: 'include',
      headers: { Accept: 'application/vnd.protonmail.v1+json', 'x-pm-uid': uid, 'x-pm-appversion': `web-mail@${version}` },
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 401) return { failure: 'auth' };
    if (!response.ok) return { failure: 'http', status: response.status };
    let data;
    try { data = await response.json(); } catch { return { failure: 'shape' }; }
    if (!sameSession()) return { failure: 'auth' };
    if (data?.Code !== 1000) return { failure: 'api', status: data?.Code };
    if (operation === 'identity') {
      const user = data.User;
      if (!user || typeof user.ID !== 'string' || !user.ID || typeof user.Name !== 'string') return { failure: 'shape' };
      if (user.ID !== userID) return { failure: 'auth' };
      return { account: { id: user.ID, username: user.Name, email: typeof user.Email === 'string' ? user.Email : null }, localID };
    }
    if (operation === 'settings') {
      if (![0, 1].includes(data.MailSettings?.ViewMode)) return { failure: 'shape' };
      return { grouped: data.MailSettings.ViewMode === 0 };
    }
    if (!Array.isArray(data.Messages) || !Number.isInteger(data.Total) || data.Total < 0) return { failure: 'shape' };
    const messages = [];
    for (const item of data.Messages) {
      if (!item || typeof item.ID !== 'string' || !item.ID || typeof item.ConversationID !== 'string'
        || typeof item.Sender?.Address !== 'string' || !item.Sender.Address
        || typeof item.Subject !== 'string' || !Number.isFinite(item.Time) || !Array.isArray(item.LabelIDs)) return { failure: 'shape' };
      messages.push({ id: item.ID, conversationID: item.ConversationID, address: item.Sender.Address,
        senderName: typeof item.Sender.Name === 'string' ? item.Sender.Name : '', subject: item.Subject,
        timestamp: item.Time, labels: item.LabelIDs });
    }
    return { messages, total: data.Total, localID };
  } catch {
    return { failure: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export async function request(page, operation, params, expected) {
  const result = await page.evaluate(requestInPage, operation, params ?? {}, expected ?? null);
  if (result?.failure === 'auth') throw new AuthRequiredError(MAIL_DOMAIN, 'No authenticated Proton Mail session', 'Run `opencli proton login`.');
  if (result?.failure === 'timeout') throw new TimeoutError('Proton API', 15);
  if (!result || result.failure) throw new CommandExecutionError(`Proton ${operation} request failed (${result?.failure ?? 'empty response'}${result?.status ? `: ${result.status}` : ''})`);
  return result;
}

export async function readIdentity(page) {
  return (await request(page, 'identity')).account;
}

export async function openMail(page) {
  const current = await page.evaluate(() => ({ origin: location.origin, path: location.pathname }));
  // Preserve the active account in multi-account sessions.
  if (current.origin !== MAIL_URL.slice(0, -1) || !/^\/u\/\d+(?:\/|$)/.test(current.path)) {
    await page.goto(MAIL_URL);
    await page.wait(2);
  }
}

export async function listMessages(page, sender, limit, since, expected) {
  const results = [];
  const seen = new Set();
  let consumed = 0;
  let previousTime = Infinity;
  let localID;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const batch = await request(page, 'messages', {
      LabelID: '0', Sort: 'Time', Desc: 1, Page: pageNumber, PageSize: 50,
      ...(sender ? { From: sender } : {}), ...(since ? { Begin: since } : {}),
    }, expected);
    if (localID !== undefined && batch.localID !== localID) throw new CommandExecutionError('Proton account changed during pagination');
    localID = batch.localID;
    for (const message of batch.messages) {
      if (seen.has(message.id) || message.timestamp > previousTime || !message.labels.includes('0')) {
        throw new CommandExecutionError('Proton returned repeated, unordered, or non-inbox messages');
      }
      seen.add(message.id);
      previousTime = message.timestamp;
      consumed++;
      const from = `${message.senderName}\n${message.address}`.toLowerCase();
      if ((!sender || from.includes(sender.toLowerCase())) && message.timestamp >= since) results.push(message);
    }
    if (results.length >= limit) return { messages: results.slice(0, limit), localID };
    if (consumed >= batch.total) return { messages: results, localID };
    if (batch.messages.length === 0) throw new CommandExecutionError('Proton pagination ended before the reported total');
  }
  throw new CommandExecutionError('Proton pagination limit reached before completing the requested result');
}

export function messageUrl(localID, message, grouped) {
  const path = grouped ? `${encodeURIComponent(message.conversationID)}/${encodeURIComponent(message.id)}` : encodeURIComponent(message.id);
  return `${MAIL_URL}u/${localID}/inbox/${path}`;
}

// Message IDs, not text snippets or titles, bind the decrypted body to the API result.
export function readMessageInPage(messageID, localID, userID) {
  if (location.origin !== 'https://mail.proton.me' || location.pathname.split('/')[2] !== localID) return { state: 'account-changed' };
  let current;
  try { current = JSON.parse(localStorage.getItem(`ps-${localID}`) || 'null'); } catch { return { state: 'account-changed' }; }
  if (!current?.UID || current.UserID !== userID) return { state: 'account-changed' };
  const containers = Array.from(document.querySelectorAll('[data-message-id]'))
    .filter((node) => node.getAttribute('data-message-id') === messageID && node.getAttribute('data-expanded') === 'true');
  if (containers.length !== 1) return { state: 'waiting' };
  const frame = containers[0].querySelector('[data-testid="message-content:body"] iframe[data-testid="content-iframe"]');
  const body = frame?.contentDocument?.body;
  if (!body || !body.textContent?.trim()) return { state: 'waiting' };
  const clone = body.cloneNode(true);
  // Quoted history can contain older codes from the same conversation.
  clone.querySelectorAll('blockquote, .protonmail_quote, script, style').forEach((node) => node.remove());
  clone.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  clone.querySelectorAll('div, p, section, article, header, footer, li, tr, td, th, h1, h2, h3, h4, h5, h6, pre').forEach((node) => {
    node.prepend('\n');
    node.append('\n');
  });
  return { state: 'ready', text: (clone.textContent || '').trim() };
}

export async function readMessage(page, message, localID, timeout, expected) {
  const { grouped } = await request(page, 'settings', {}, expected);
  const url = messageUrl(localID, message, grouped);
  await page.goto(url);
  const deadline = Date.now() + timeout * 1000;
  do {
    const result = await page.evaluate(readMessageInPage, message.id, localID, expected.id);
    if (result?.state === 'account-changed') throw new AuthRequiredError(MAIL_DOMAIN, 'Proton account changed while opening the message');
    if (result?.state === 'ready') return { text: result.text, url };
    await page.wait(0.5);
  } while (Date.now() < deadline);
  throw new TimeoutError('Selected Proton message decryption', timeout, 'Unlock the mailbox in Chrome and verify that the selected message opens.');
}

export function pickCode(text) {
  // Never truncate a long number into an OTP or guess between competing codes.
  const codes = [...new Set((String(text).match(/(?<![\p{L}\p{N}])\d{4,8}(?![\p{L}\p{N}])/gu) || [])
    .filter((value) => !/^20\d{2}$/.test(value)))];
  const six = codes.filter((value) => value.length === 6);
  const candidates = six.length ? six : codes;
  return candidates.length === 1 ? candidates[0] : '';
}
