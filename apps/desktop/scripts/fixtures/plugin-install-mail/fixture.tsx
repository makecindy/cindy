import { mountPage, subscription } from '../../ui-page/harness';
import { MailPreviewBody } from '../../../src/renderer/features/right-sidebar/plugins/mail-preview';
import { GhostInstallConsentHost } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import { GhostCardForm } from '../../../src/renderer/components/chat/GhostCardForm';
import { MailHtmlPreview } from '../../../src/renderer/components/chat/MailHtmlPreview';
import { MailConversationView } from '../../../src/renderer/features/right-sidebar/plugins/mail-preview/MailConversationView';
import { useState } from 'react';
import previewImage from '../../../resources/icon.png';

function MailAvatarsFixture() {
  const [opened, setOpened] = useState(false);
  const message = { accountId: 'fixture-account', messageId: 'fixture-message',
    from: 'Cindy <cindy@example.test>', to: 'Alex <alex@example.test>, 设计团队 <team@company.example.com>', cc: '访客 <guest@gmail.com>', bcc: '',
    subject: '本周设计更新', date: '2026-10-25T09:00:00+13:00', bodyText: '',
    bodyHtml: `<p>大家好，</p><p>新版邮件阅读界面已准备好，请查看设计预览。</p><img src="${new URL(previewImage, location.href).href}" alt="Preview image" width="120" height="120"><p><a href="https://example.test/details">查看设计说明</a></p>`, attachments: [],
    participantPhotos: [{ email: 'cindy@example.test', url: 'https://lh3.googleusercontent.com/fixture-contact' }] };
  return opened ? <MailConversationView mail={message} read={async () => ({ message })} retry={() => {}} openMailbox={null} />
    : <button onClick={() => setOpened(true)}>Open preview</button>;
}

function MailTwoViewsFixture() {
  const [value, setValue] = useState('<p>First paragraph</p><p>Last paragraph</p>');
  return <div className="grid grid-cols-2 gap-4">
    {[0, 1].map(side => <section key={side} data-testid={`mail-side-${side}`}>
      <p>{side ? 'Sidebar editor' : 'Chat card'}</p>
      <MailHtmlPreview value={value} onChange={html => setValue(html)} />
    </section>)}
  </div>;
}

function MailReadFixture() {
  return <section className="p-4">
    <MailHtmlPreview reading value={`<style>a{text-decoration:none!important}</style><p>Hello Alex,</p><p>Here is the image from our latest update.</p><img src="${new URL(previewImage, location.href).href}" alt="Preview image" width="160" height="160"><p><a style="text-decoration:none!important" href="https://example.test/details">View details</a></p><p><a style="text-decoration:underline!important" href="mailto:person@example.test">person@example.test</a></p>`} />
    <output data-testid="opened-link" hidden />
  </section>;
}

function MailRefreshFixture() {
  const [version, setVersion] = useState(0);
  return <>
    <button onClick={() => setVersion(version + 1)}>Refresh source</button>
    <MailHtmlPreview value={`<p>First paragraph</p><p>Last paragraph</p><!--${version}-->`} onChange={() => {}} />
  </>;
}

function MailEditFixture() {
  const [value, setValue] = useState('<html><head><style>p{margin:12px 0}</style></head><body style="color:#123456"><p>First paragraph</p><p>Second <strong>formatted</strong> paragraph</p><p>Last paragraph</p><img src="cid:logo"></body></html>');
  const [saved, setSaved] = useState('');
  const [instance, setInstance] = useState(0);
  return <>
    <button onClick={() => setInstance(instance + 1)}>Reopen saved</button>
    <MailHtmlPreview key={instance} value={value} images={[{cid: 'logo', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}]} onChange={html => { setValue(html); setSaved(html); }} />
    <output data-testid="saved-body" hidden>{saved}</output>
  </>;
}

void mountPage({
  host: {
    openExternal: async (url: string) => {
      const output = document.querySelector('[data-testid="opened-link"]');
      if (output) output.textContent = url;
      return { success: true };
    },
    ghosts: {
      onInstallConsentRequest: subscription('installConsent'),
      onInstallConsentDismissed: subscription('installDismissed'),
      resolveInstallConsent: async () => ({ handled: true }),
    },
  },
  render: (ctx) => (
    <main className="h-screen w-full">
      {ctx.case === 'participant-avatars' ? (
        <MailAvatarsFixture />
      ) : ctx.case === 'read-mail-body' ? (
        <MailReadFixture />
      ) : ctx.case === 'two-mail-views' ? (
        <MailTwoViewsFixture />
      ) : ctx.case === 'edit-mail-body' ? (
        <MailEditFixture />
      ) : ctx.case === 'refresh-mail-body' ? (
        <MailRefreshFixture />
      ) : ctx.case === 'expanded-recipients' ? (
        <GhostCardForm expanded disabled={false} onChange={() => {}} fields={[
          { name: 'to', label: 'To', kind: 'recipients', value: 'Alex <alex@example.test>' },
          { name: 'cc', label: 'Cc', kind: 'recipients', value: '' },
          { name: 'bcc', label: 'Bcc', kind: 'recipients', value: 'private@example.test', collapsed: true },
        ]} />
      ) : ctx.case === 'source-change' ? (
        <GhostInstallConsentHost />
      ) : (
        <MailPreviewBody
          state={{ url: 'https://mail.example.test/a' }}
          ctx={{
            tabId: 'mail',
            sessionId: 'fixture',
            workdir: '',
            remoteHostId: null,
            deviceLinkDeviceId: null,
            patchState() {},
            onVisibilityChange() {},
            setCloseInterceptor: () => () => {},
          }}
        />
      )}
    </main>
  ),
});
