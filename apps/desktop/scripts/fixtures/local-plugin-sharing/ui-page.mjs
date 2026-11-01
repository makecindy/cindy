export default {
  name: 'local-plugin-sharing',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 850 },
  real: 'PluginShareButton, ShareDialog, LocalPluginShareView and original permission dialog',
  notCovered: 'Installed detail eligibility, real login, package transport, native clipboard and durable installation; host APIs are scene data',
  stubs: {
    'src/renderer/contexts/AuthContext': `import { useSyncExternalStore } from 'react';
      const subscribe = fn => { window.addEventListener('local-share-demo-change', fn); return () => window.removeEventListener('local-share-demo-change', fn); };
      export function useAuth() { const signedIn = useSyncExternalStore(subscribe, () => window.__localShareDemoSignedIn ?? window.__uiPage.ctx.case !== 'login'); return { isAuthenticated: signedIn, mode: signedIn ? 'cloud' : 'local', dataOwnerId: 'fixture', dataOwnerGeneration: 1, exitLocalMode: async () => { window.__localShareDemoSignedIn = true; window.dispatchEvent(new Event('local-share-demo-change')); } }; }
      export function useOptionalAuthUser() { return null; }
      export function useOptionalDataOwnerGeneration() { return 1; }
      export function useOptionalAuthDeviceId() { return 'fixture-self'; }`,
  },
  async ready(page) {
    // The isolated HTTP fixture is not a secure context. Production runs in the
    // trusted app renderer; fake only UUID generation at this native boundary.
    await page.evaluate(() => {
      if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      } });
    });
  },
  cases: {
    interactive: { about: 'Manual sharing demo with original detail pages, two versions, login states and device choices', viewport: { width: 1100, height: 850 } },
    default: { about: 'The existing share button requires confirmation before uploading a local package' },
    reused: { about: 'An unchanged uploaded package opens share material without another confirmation' },
    narrow: { about: 'Local upload confirmation uses the existing dialog at narrow width', viewport: { width: 360, height: 740 } },
    changed: { about: 'Changed content requires reopening to check and confirm the new package', viewport: { width: 360, height: 740 } },
    recipient: { about: 'Exact shared version, explicit installation and real permission confirmation' },
    'recipient-narrow': { about: 'Exact shared package at narrow width', viewport: { width: 360, height: 740 } },
    'recipient-replace': { about: 'Explicit same-ID replacement and existing account/data notice', viewport: { width: 320, height: 740 } },
    'remote-select': { about: 'Choose another computer and confirm that computer’s permissions', viewport: { width: 900, height: 850 } },
    'remote-narrow': { about: 'Remote package and permission confirmation at minimum width', viewport: { width: 320, height: 740 } },
    'remote-replace': { about: 'Same replacement action and data notice on the selected computer', viewport: { width: 320, height: 740 } },
    'remote-offline': { about: 'Keep the offline target selected and disable installation', viewport: { width: 320, height: 740 } },
    'remote-unsupported': { about: 'Explain the required target update without local fallback', viewport: { width: 320, height: 740 } },
    login: { about: 'No package read until login', viewport: { width: 360, height: 740 } },
  },
  async check(page, ui) {
    if (ui.case === 'interactive') {
      await page.getByRole('heading', { name: '本地笔记助手', exact: true }).waitFor();
      await page.getByRole('button', { name: await ui.t('sharing.title'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('sharing.uploadLocal') }).waitFor();
      await ui.capture('upload-confirmation');
      await page.getByRole('button', { name: await ui.t('sharing.uploadLocal') }).click();
      await page.getByRole('button', { name: await ui.t('sharing.copyLink') }).waitFor();
      await ui.capture('share-ready');
      await page.getByRole('button', { name: await ui.t('sharing.close'), exact: true }).click();
      await page.getByRole('combobox', { name: '打开分享记录' }).selectOption('00000000000000000000000000000001');
      await page.getByRole('button', { name: await ui.t('sharing.localInstallButton', { version: '1.0.0' }) }).click();
      await page.getByRole('button', { name: await ui.t('settings.ghosts.installConsent.confirmInstall'), exact: true }).click();
      await page.getByText('模拟安装成功：本机', { exact: true }).waitFor();
      await page.getByRole('button', { name: await ui.t('settings.ghosts.remote.device'), exact: true }).click();
      await page.getByRole('menuitem', { name: '工作电脑', exact: true }).click();
      await page.getByRole('button', { name: await ui.t('sharing.localInstallButton', { version: '1.0.0' }) }).click();
      await ui.capture('remote-confirmation');
      await page.getByRole('button', { name: await ui.t('settings.ghosts.installConsent.confirmInstall'), exact: true }).click();
      await page.getByText('模拟安装成功：工作电脑', { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'login') {
      await page.getByRole('button', { name: await ui.t('sharing.localSignIn') }).waitFor();
      return;
    }
    if (ui.case.startsWith('remote')) {
      await page.getByText('v1.0.0', { exact: true }).waitFor();
      if (ui.case === 'remote-select') {
        await page.getByRole('button', { name: await ui.t('settings.ghosts.remote.device') }).click();
        await ui.capture('device-options');
        await page.getByRole('menuitem', { name: await ui.t('settings.ghosts.remote.thisComputer') }).click();
        await page.getByRole('button', { name: await ui.t('settings.ghosts.remote.device') }).click();
        await page.getByRole('menuitem', { name: 'Studio Computer' }).click();
      }
      const button = page.getByRole('button', { name: await ui.t('sharing.localInstallButton', { version: '1.0.0' }) });
      if (ui.case === 'remote-offline' || ui.case === 'remote-unsupported') {
        await page.getByText(await ui.t(ui.case === 'remote-offline' ? 'settings.ghosts.remote.offlineNotice' : 'sharing.localTargetUnsupported', { device: 'Studio Computer' }), { exact: true }).waitFor();
        if (await button.isEnabled()) throw new Error('Unavailable target enabled installation');
        return;
      }
      await ui.capture('target-device');
      await button.click();
      await page.getByRole('alertdialog').waitFor();
      if (ui.case === 'remote-replace') {
        await page.getByRole('button', { name: await ui.t('sharing.localReplaceButton'), exact: true }).waitFor();
        await page.getByText(await ui.t('sharing.localReplaceRetainsState'), { exact: true }).waitFor();
      }
      await ui.capture('target-permissions');
      return;
    }
    if (ui.case.startsWith('recipient')) {
      await page.getByText('v1.0.0', { exact: true }).waitFor();
      await ui.capture('fixed-version');
      await page.getByRole('button', { name: await ui.t('sharing.localInstallButton', { version: '1.0.0' }) }).click();
      await ui.emit('consent', {
        requestId: 'local-share-fixture', initiator: 'user', origin: 'local-file',
        ...(ui.case === 'recipient-replace' ? { purpose: 'share-replace' } : {}),
        target: { namespace: null, sourceChanged: false, otherCopies: 0 },
        facts: ui.case === 'recipient-replace'
          ? { kind: 'update', ghostId: 'local-share-example', name: '我的本地插件', version: '1.0.0', previousVersion: '1.0.0',
            added: [], removed: [], unchangedCount: 1, builtinOauthClientChanged: false }
          : { kind: 'install', ghostId: 'local-share-example', name: '我的本地插件', version: '1.0.0',
            permissions: [{ key: 'network:host:api.example.test', kind: 'network', labelKey: 'networkHost', labelArgs: { host: 'api.example.test' } }] },
      });
      await page.getByRole('alertdialog').waitFor();
      if (ui.case === 'recipient-replace') {
        await page.getByRole('button', { name: await ui.t('sharing.localReplaceButton'), exact: true }).waitFor();
        await page.getByText(await ui.t('sharing.localReplaceRetainsState'), { exact: true }).waitFor();
      }
      await ui.capture('permissions');
      return;
    }
    await page.getByRole('button', { name: await ui.t('sharing.title') }).click();
    await page.locator('button[aria-busy="true"]').waitFor();
    if (await page.getByRole('dialog').count()) throw new Error('Share dialog opened before the upload decision');
    await ui.capture('checking-before-open');
    await page.evaluate(() => window.dispatchEvent(new Event('local-share-check-complete')));
    if (ui.case === 'changed') {
      await page.getByText(await ui.t('sharing.localChanged'), { exact: true }).waitFor();
      if (await page.getByRole('button', { name: await ui.t('sharing.retry') }).count()) throw new Error('Obsolete confirmation can still be retried');
      await ui.capture('content-changed');
      return;
    }
    if (ui.case !== 'reused') {
      await page.getByRole('button', { name: await ui.t('sharing.uploadLocal') }).waitFor();
      await ui.capture('upload-confirmation');
      await page.getByRole('button', { name: await ui.t('sharing.uploadLocal') }).click();
    }
    await page.getByRole('button', { name: await ui.t('sharing.copyLink') }).waitFor();
    if (await page.getByRole('button', { name: await ui.t('sharing.uploadLocal') }).count()) throw new Error('Repeated upload confirmation');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent && !button.disabled && button.querySelector('svg.lucide-copy')));
    await ui.capture('share-material');
  },
};
