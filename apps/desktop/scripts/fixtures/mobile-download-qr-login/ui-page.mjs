export default {
  name: 'mobile-download-qr-login',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 640 },
  real: 'MobileDownloadDialog with useQrLoginHandoff: the login QR shown to a signed-in computer and the Allow / Deny prompt after a phone claims it',
  notCovered:
    'Auth server, the 2-second polling cadence and Allow / Deny results are synthetic or forbidden here; covered by useQrLoginHandoff.test.ts and cindy-server#1690',
  cases: {
    default: { about: 'Signed in: the dialog QR doubles as a login code for the Cindy phone app', data: { claimed: false } },
    claimed: { about: 'A phone scanned the code: Allow or Deny on this computer', data: { claimed: true } },
  },
  async check(page, ui) {
    const card = page.getByTestId('mobile-download-qr-card');
    await card.locator('img').waitFor();
    await page.getByText(await ui.t('sidebar.mobileDownload.scanToLogin'), { exact: true }).waitFor();
    if (ui.case === 'claimed') {
      // 第一次轮询在 2 秒后，认领后出现允许 / 拒绝。
      await page.getByTestId('mobile-download-qr-approval').waitFor({ timeout: 8_000 });
    }
    await ui.capture('dialog', { locator: page.getByRole('dialog') });
  },
};
