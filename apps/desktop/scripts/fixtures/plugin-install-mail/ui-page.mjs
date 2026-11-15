import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export default {
  name: 'plugin-install-mail',
  entry: './fixture.tsx',
  viewport: { width: 700, height: 600 },
  real: 'MailPreviewBody provider chooser and unavailable/failed reader states, MailHtmlPreview image opt-in and link activation, GhostInstallConsentHost, shared confirmation dialog, buttons and five locales',
  notCovered:
    'Mailbox tools, installer writes, account credentials, live mail content, native mobile rendering and external network connections',
  stubs: {
    'src/renderer/features/right-sidebar/lib/mailPreview':
      'export async function openMailPreview(){} export async function readMailPreview(){ const c=window.__uiPage.ctx.case; if(c==="no-reader")return {supported:false}; if(c==="not-ready")return {supported:true,error:"MAIL_PROVIDER_NOT_READY"}; if(c==="read-failed")return {supported:true,error:"MAIL_READ_FAILED"}; return {providers:[{id:"root",name:"Mail",namespace:null},{id:"team",name:"Mail for a very long organization name",namespace:"long-organization-identity-example"}]}; }',
    'src/renderer/features/right-sidebar/registry': 'export function registerTabKind(){} export function getTabKind(){return undefined;}',
    'src/renderer/features/right-sidebar/plugins/mail-preview/MailCardBody':
      'export function MailCardBody(){return null;}',
  },
  cases: {
    'participant-avatars': { about: 'Real reader with Google contact, public email, domain logo and initials; image endpoints use fixture bytes', viewport: { width: 360, height: 720 } },
    'read-mail-body': { about: 'External images require a click; links follow chat navigation', viewport: { width: 360, height: 600 } },
    'two-mail-views': { about: 'Typing in either editor updates its peer without iframe navigation or blank paint' },
    'edit-mail-body': { about: 'Native whole-body selection, replace, delete, undo, and saved HTML round trip' },
    'refresh-mail-body': { about: 'Source updates with identical sanitized HTML must reveal the mail body' },
    'expanded-recipients': { about: 'Sidebar recipient rows retain expand/collapse with compact spacing', viewport: { width: 360, height: 600 } },
    default: { about: 'Two configured plugin instances' },
    narrow: {
      about: 'Long organization and plugin names in a narrow sidebar',
      viewport: { width: 360, height: 600 },
    },
    'source-change': { about: 'Source replacement and duplicate account impact' },
    'no-reader': { about: 'A restored tab with no mail plugin; original URL remains accessible', viewport: { width: 360, height: 600 } },
    'not-ready': { about: 'An unconfigured mail plugin without a pointless retry', viewport: { width: 360, height: 600 } },
    'read-failed': { about: 'A real read failure offers both original URL and retry', viewport: { width: 360, height: 600 } },
  },
  async check(page, ui) {
    const selected = await page.evaluate(() => window.__uiPage.ctx.case);
    if (selected === 'participant-avatars') {
      const imageData = name => 'data:image/png;base64,' + readFileSync(new URL('../../../resources/' + name, import.meta.url)).toString('base64');
      const hash = createHash('sha256').update('alex@example.test').digest('hex');
      const images = {
        'https://lh3.googleusercontent.com/fixture-contact': imageData('companion-preset-avatars/cindy.png'),
        [`https://gravatar.com/avatar/${hash}?s=64&d=404&r=g`]: imageData('legacy-teammate-avatars/lizi.png'),
        'https://icons.duckduckgo.com/ip3/company.example.com.ico': imageData('icon.png'),
      };
      const hashes = Object.fromEntries(['alex@example.test', 'team@company.example.com', 'guest@gmail.com'].map(email =>
        [email, Array.from(createHash('sha256').update(email).digest())]));
      await page.evaluate(({ images, hashes }) => {
        // The isolated harness blocks all off-origin requests and has no
        // SubtleCrypto. Substitute image bytes at the DOM boundary, retaining
        // the real component's source selection/load/error handlers. URL and
        // SHA-256 behavior is separately exercised by MailPreview.test.tsx.
        if (!crypto.subtle) Object.defineProperty(crypto, 'subtle', { configurable: true, value: {
          digest: async (_algorithm, bytes) => Uint8Array.from(hashes[new TextDecoder().decode(bytes)]).buffer,
        } });
        function substitute(node, value) {
          if (String(value).startsWith('https://')) {
            if (images[value]) return images[value];
            if (String(value).startsWith('https://gravatar.com/')) {
              queueMicrotask(() => node.dispatchEvent(new Event('error')));
              return null;
            }
            throw new Error('Unexpected avatar endpoint: ' + value);
          }
          return value;
        }
        const original = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
          const mapped = this instanceof HTMLImageElement && name === 'src' ? substitute(this, value) : value;
          if (mapped !== null) return original.call(this, name, mapped);
        };
        const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value) {
          const mapped = substitute(this, value);
          if (mapped !== null) src.set.call(this, mapped);
        } });
      }, { images, hashes });
      await page.getByRole('button', { name: 'Open preview' }).click();
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('section img')];
        return images.length === 3 && images.every(img => img.complete && img.naturalWidth > 0 && !img.classList.contains('invisible'));
      });
      await ui.capture('avatars');
      await page.locator('main').evaluate(node => { node.style.width = '320px'; });
      await ui.capture('avatars-narrow-320');
      await page.locator('main').evaluate(node => { node.style.width = ''; });
      await page.getByRole('button', { name: await ui.t('mailReader.showExternalImages') }).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      await page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelector('img').naturalWidth > 0);
      await ui.capture('avatars-and-images');
      return;
    }
    if (selected === 'read-mail-body') {
      await page.locator('iframe[aria-busy="false"]').waitFor();
      const frame = page.frameLocator('iframe');
      if (await frame.locator('img').getAttribute('src') !== null) throw new Error('Image requested before consent');
      const decorations = await page.evaluate(() => {
        const doc = document.querySelector('iframe').contentDocument;
        return [...doc.querySelectorAll('a')].map(node => doc.defaultView.getComputedStyle(node).textDecorationLine);
      });
      if (!decorations[0].includes('underline')) throw new Error('Sender CSS hid the web link underline');
      const email = frame.getByText('person@example.test', { exact: true });
      if (decorations[1].includes('underline')) throw new Error('Unsupported mailto looks clickable');
      await email.click();
      if (await page.getByTestId('opened-link').textContent()) throw new Error('Unsupported mailto reached web navigation');
      await ui.capture('images-blocked');
      await page.getByRole('button', { name: await ui.t('mailReader.showExternalImages') }).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      await frame.getByText('Hello Alex,', { exact: true }).waitFor();
      await frame.getByRole('link', { name: 'View details' }).click();
      if (await page.getByTestId('opened-link').textContent() !== 'https://example.test/details') throw new Error('Mail link was not delegated to the host');
      await page.waitForFunction(() => !!document.querySelector('iframe').contentDocument.querySelector('img').getAttribute('src'));
      await page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelector('img').naturalWidth > 0);
      await ui.capture('images-visible');
      return;
    }
    if (selected === 'two-mail-views') {
      await page.waitForFunction(() => document.querySelectorAll('iframe[aria-busy="false"]').length === 2);
      await page.evaluate(() => {
        window.mailViewProof = [...document.querySelectorAll('iframe')].map(frame => {
          const proof = { frame, doc: frame.contentDocument, src: frame.srcdoc, loads: 0 };
          frame.addEventListener('load', () => proof.loads++);
          return proof;
        });
      });
      for (const side of [1, 0, 1]) {
        const body = page.getByTestId(`mail-side-${side}`).frameLocator('iframe').locator('body');
        await body.getByText('Last paragraph', { exact: true }).click();
        await page.keyboard.press('End');
        await page.keyboard.type(' xyz');
        await page.waitForFunction(() => {
          const frames = [...document.querySelectorAll('iframe')];
          const text = frames[0].contentDocument.body.textContent;
          return text.includes(' xyz') && text === frames[1].contentDocument.body.textContent;
        });
        const stable = await page.evaluate(() => window.mailViewProof.every(p =>
          p.frame.isConnected && p.frame.contentDocument === p.doc && p.frame.srcdoc === p.src &&
          p.loads === 0 && p.frame.style.visibility === 'visible' && p.frame.getAttribute('aria-busy') === 'false'));
        if (!stable) throw new Error('Peer editor navigated or hid during synchronization');
        // Undo the last keystroke and check that the receiving view follows it.
        await page.keyboard.press('ControlOrMeta+z');
        await page.waitForFunction(() => [...document.querySelectorAll('iframe')].every(frame => frame.contentDocument.body.textContent === 'First paragraphLast paragraph'));
      }
      await ui.capture('synced');
      return;
    }
    // Browser integration: the former per-run editor only selected one run.
    // Exercise actual keyboard editing and the onChange/autosave echo, not DOM mocks.
    if (selected === 'edit-mail-body') {
      await page.locator('iframe[aria-busy="false"]').waitFor();
      const body = page.frameLocator('iframe');
      await body.getByText('Last paragraph', {exact: true}).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('New paragraph');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('New paragraph'));
      const split = await page.getByTestId('saved-body').textContent();
      if (split.includes('color-mix') || split.includes('data-cindy') || split.includes('!important')) throw new Error('Native paragraph insertion saved preview paint');
      await body.getByText('formatted', {exact: true}).click();
      const selectAll = async () => {
        await page.keyboard.press('ControlOrMeta+a');
        const selection = await page.evaluate(() => document.querySelector('iframe').contentDocument.getSelection().toString());
        if (!selection.includes('First paragraph') || !selection.includes('Last paragraph')) throw new Error('Selection is not the entire body');
      };
      await selectAll();
      await page.keyboard.type('Replacement text');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('Replacement text'));
      let saved = await page.getByTestId('saved-body').textContent();
      if (saved.includes('First paragraph') || saved.includes('Last paragraph')) throw new Error('Replacement retained old text');
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('Last paragraph'));
      await selectAll();
      await page.keyboard.press('Backspace');
      await page.waitForFunction(() => !document.querySelector('[data-testid="saved-body"]').textContent.includes('Last paragraph'));
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('Last paragraph'));
      saved = await page.getByTestId('saved-body').textContent();
      // Native paragraph insertion may normalize #123456 to rgb(18, 52, 86).
      // Verify the authored color rather than its equivalent CSS spelling.
      const savedColor = await page.evaluate(html => new DOMParser().parseFromString(html, 'text/html').body.style.color, saved);
      if (!saved.includes('cid:logo') || saved.includes('data:image') || saved.includes('data-cindy') || savedColor !== 'rgb(18, 52, 86)') throw new Error(`Saved HTML leaked preview state or lost authored styles/CID: ${saved}`);
      await page.getByRole('button', {name:'Reopen saved'}).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      await body.getByText('formatted', {exact:true}).waitFor();
      await body.getByText('formatted', {exact:true}).click();
      await selectAll();
      await page.evaluate(() => {
        const doc = document.querySelector('iframe').contentDocument;
        const data = new DataTransfer();
        data.setData('text/plain', '你好\nSecond line <script>literal</script>');
        doc.activeElement.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}));
      });
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('你好'));
      saved = await page.getByTestId('saved-body').textContent();
      if (saved.includes('<script>') || saved.includes('First paragraph') || saved.includes('color-mix')) throw new Error('Paste was not plain text or saved preview paint');
      await page.getByRole('button', {name:'Reopen saved'}).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      const rendered = await page.evaluate(() => document.querySelector('iframe').contentDocument.body.innerText);
      if (!rendered.includes('你好\n') || !rendered.includes('<script>literal</script>')) throw new Error('Multiline paste did not survive saving');
      return;
    }
    if (selected === 'refresh-mail-body') {
      await page.locator('iframe[aria-busy="false"]').waitFor();
      await page.getByRole('button', { name: 'Refresh source' }).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      if (!await page.locator('iframe').isVisible()) throw new Error('Refreshed body stayed hidden');
      const text = await page.evaluate(() => document.querySelector('iframe').contentDocument.body.textContent);
      if (!text.includes('First paragraph') || !text.includes('Last paragraph')) throw new Error('Body content lost');
      return;
    }
    if (selected === 'expanded-recipients') {
      await page.locator('button[aria-expanded="false"]').click();
      for (const label of ['To', 'Cc', 'Bcc']) await page.getByRole('textbox', { name: label, exact: true }).waitFor();
      await ui.capture('expanded');
      await page.locator('button[aria-expanded="true"]').click();
      await page.locator('button[aria-expanded="false"]').waitFor();
      return;
    }
    const message = { 'no-reader': 'unavailable', 'not-ready': 'notReady', 'read-failed': 'failed' }[selected];
    if (message) {
      await page.getByText(await ui.t(`mailReader.${message}`)).waitFor();
      await page.getByRole('button', { name: await ui.t('mailReader.openMailbox'), exact: true }).waitFor();
      return;
    }
    if (selected !== 'source-change') {
      await page.getByText(await ui.t('mailReader.choosePlugin')).waitFor();
      return;
    }
    await ui.emit('installConsent', {
      requestId: 'fixture-install',
      initiator: 'user',
      origin: 'local-file',
      target: { namespace: null, sourceChanged: true, otherCopies: 1 },
      facts: {
        kind: 'update',
        ghostId: 'mail-fixture',
        name: 'Mail',
        version: '2.0.0',
        previousVersion: '1.0.0',
        added: [],
        removed: [],
        unchangedCount: 2,
        builtinOauthClientChanged: false,
      },
    });
    await page
      .getByRole('button', {
        name: await ui.t('settings.ghosts.installConsent.confirmUpdate'),
        exact: true,
      })
      .waitFor();
    await ui.capture('confirmation');
  },
};
