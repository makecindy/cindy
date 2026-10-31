/** Visual-mock mail reader (synthetic data only). Open with
 * /mail-preview?deviceId=<mock>&sessionId=<any>&url=<one of VISUAL_MAIL_URLS>. */
const BASE = 'https://mail.example.com/visual/';
export const VISUAL_MAIL_URLS = { newsletter: `${BASE}visual-newsletter`, thread: `${BASE}visual-thread-3` };

const NEWSLETTER = `<html><body style="margin:0;background:#f2f2f2">
<table width="600" cellpadding="0" cellspacing="0" align="center" style="width:600px;background:#ffffff;font-family:Arial,sans-serif">
<tr><td style="background:#e99a4e;padding:40px 48px;color:#ffffff"><div style="font-size:14px;letter-spacing:2px">ORBIT GARDEN</div>
<div style="font-size:34px;font-weight:bold;line-height:42px;margin-top:12px">Your playtest pass is here!</div></td></tr>
<tr><td style="padding:32px 48px;color:#222;font-size:17px;line-height:27px">
<p>Hi Robin,</p><p>Thanks for signing up for the Orbit Garden spring playtest. Your pass is ready — show it at the door or keep it on your phone.</p>
<table width="100%" cellpadding="16" style="background:#fff4e8;border-radius:8px;margin:16px 0"><tr><td style="font-size:15px;line-height:24px">
<b>Pass number</b><br>OG-2026-0417<br><br><b>Session</b><br>Saturday 14 November, 10:00–12:00</td></tr></table>
<p>The build includes the new greenhouse level and the reworked tutorial. We would love to hear what you think afterwards.</p>
<p style="text-align:center;margin:32px 0"><a href="https://example.com/playtest" style="background:#2b6cb0;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none">View my pass</a></p>
<p>See you soon,<br>The Orbit Garden team</p></td></tr>
<tr><td style="background:#333;color:#bbb;padding:24px 48px;font-size:12px;line-height:18px">You received this email because you registered for a playtest. Orbit Garden Studio · 1 Example Street · Example City</td></tr>
</table></body></html>`;

const summary = (id: string, from: string, date: string, snippet: string) =>
  ({ messageId: id, url: `${BASE}${id}`, from, date, subject: 'Greenhouse level feedback', snippet });
const THREAD = [
  summary('visual-thread-1', 'Avery Lin <avery@orbit-garden.test>', 'Mon, 26 Oct 2026 09:12:00 +1300', 'Sharing the first round of notes from Saturday’s session.'),
  summary('visual-thread-2', 'Sam Ortiz <sam@orbit-garden.test>', 'Tue, 27 Oct 2026 16:40:00 +1300', 'Thanks — the camera issue is fixed in build 214.'),
  summary('visual-thread-3', 'Avery Lin <avery@orbit-garden.test>', 'Sat, 31 Oct 2026 11:05:00 +1300', 'Confirmed on build 214. Two small things left.'),
];

function message(url: string) {
  if (url === VISUAL_MAIL_URLS.newsletter) return {
    accountId: 'visual', messageId: 'visual-newsletter', from: 'Orbit Garden <hello@orbit-garden.test>',
    to: 'robin@example.com', cc: '', bcc: '', subject: 'Robin, your playtest pass is here!',
    date: 'Wed, 21 Oct 2026 09:55:03 +1300', bodyText: 'Your playtest pass is here.', bodyHtml: NEWSLETTER, attachments: [],
  };
  const item = THREAD.find(m => m.url === url);
  if (!item) return null;
  return {
    accountId: 'visual', messageId: item.messageId, from: item.from,
    to: 'Robin Park <robin@example.com>, Sam Ortiz <sam@orbit-garden.test>', cc: 'Playtest Team <playtest@orbit-garden.test>', bcc: '',
    subject: 'Re: Greenhouse level feedback', date: item.date, bodyHtml: '',
    bodyText: `${item.snippet}\n\n1. The watering can tooltip overlaps the inventory on small screens.\n2. The night cycle starts a few seconds early after loading a save.\n\nEverything else felt great. Happy to jump on a call next week.\n\nAvery`,
    attachments: [{ key: 'notes', filename: 'playtest-notes.pdf', mimeType: 'application/pdf', bytes: 248_000 }],
    conversation: { threadId: 'visual-thread', messages: THREAD },
  };
}

export function mailVisualFixture(channel: string, args: unknown[]): unknown {
  const ref = (args[0] as { ref?: { collectionId?: string; kind?: string; id?: string } } | undefined)?.ref;
  if (channel !== 'maker:remote-resources:get' || ref?.collectionId !== 'mail-messages' || !ref.id) return undefined;
  let url = '';
  try { url = String((JSON.parse(ref.id) as unknown[])[1]); } catch { /* unknown id */ }
  const found = message(url);
  return { ref, revision: '1', display: { title: found?.subject || 'Mail' }, actions: [], links: [],
    blocks: [{ id: 'message', primitive: 'mail-message', fallbackMarkdown: found?.bodyText || '',
      data: found ? { supported: true, message: found, providerId: 'visual-mail' } : { supported: true, error: 'MAIL_READ_FAILED' } }] };
}

/** Compose card in a chat: open /sessions/visual-mail-draft?deviceId=<mock>. */
export const VISUAL_MAIL_DRAFT_SESSION_ID = 'visual-mail-draft';
export const VISUAL_MAIL_DRAFT_CALL_ID = 'visual-mail-card';
const DRAFT_KEY = '0f6c1b9e-3a47-4d2a-9b1e-7c2f5d8a4e10';
const DRAFT_HTML = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:23px">
<p>Hi Avery,</p><p>Thanks for confirming build 214. I've logged both issues:</p>
<ol><li>The watering can tooltip will move above the inventory on small screens.</li><li>The night cycle timer will start after the save finishes loading.</li></ol>
<p>Next week works for a call — Tuesday or Wednesday afternoon?</p><p>Robin</p></div>`;
const DRAFT_TEXT = 'Hi Avery,\n\nThanks for confirming build 214. I\'ve logged both issues.\n\nNext week works for a call — Tuesday or Wednesday afternoon?\n\nRobin';

function draftCard() {
  const fields = [
    { name: 'to', label: '收件人', value: 'Avery Lin <avery@orbit-garden.test>', kind: 'recipients', row: 'recipients' },
    { name: 'cc', label: '抄送', value: 'Sam Ortiz <sam@orbit-garden.test>, Playtest Team <playtest@orbit-garden.test>', kind: 'recipients', row: 'recipients' },
    { name: 'bcc', label: '密送', value: '', kind: 'recipients', collapsed: true },
    { name: 'subject', label: '主题', value: 'Re: Greenhouse level feedback' },
    { name: 'body', label: '正文', value: DRAFT_TEXT, multiline: true, kind: 'hidden' },
    { name: 'bodyHtml', label: '正文', value: DRAFT_HTML, kind: 'mail-html' },
    { name: 'quoteHtml', label: '引用', value: '', kind: 'hidden' },
    { name: 'attachmentItems', label: 'Attachments', value: JSON.stringify([{ key: 'notes', filename: 'playtest-notes.pdf', mimeType: 'application/pdf', bytes: 248_000 }]), kind: 'mail-attachments' },
  ];
  return {
    pluginId: 'google-gmail', revision: 'visual-1', form: fields, changeAction: `mail:change:${DRAFT_KEY}`, mailUpload: true,
    items: [{ id: `mail:send:${DRAFT_KEY}`, label: '发送', disabled: false, submit: true }],
    mail: { key: DRAFT_KEY, accountId: 'visual', draftId: 'visual-draft', from: 'robin@example.com', fields,
      attachments: ['playtest-notes.pdf'], state: 'draft', status: '已保存草稿', sendLabel: '发送', fromLabel: '发件人', deleteLabel: '删除草稿' },
  };
}

export function mailDraftCardFixture(channel: string, args: unknown[]): unknown {
  const ref = (args[0] as { ref?: { collectionId?: string; kind?: string; id?: string } } | undefined)?.ref;
  if (channel !== 'maker:remote-resources:get' || ref?.collectionId !== 'plugin-results' || ref.id !== JSON.stringify([VISUAL_MAIL_DRAFT_SESSION_ID, VISUAL_MAIL_DRAFT_CALL_ID])) return undefined;
  return { ref, revision: 'visual-1', display: { title: 'google-gmail' }, actions: [], links: [],
    blocks: [{ id: 'actions', primitive: 'plugin-card-actions', fallbackMarkdown: '', data: draftCard() }] };
}
