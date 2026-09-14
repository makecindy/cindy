/** Real Chromium + production Desktop viewer, with a loopback synthetic host.
 * Usage: node apps/desktop/scripts/remote-desktop-viewer-smoke.mjs <Vite origin> <Chrome path> [win32|darwin]
 * No account, OS capture, credential, or remote input. Artifacts live in a unique OS temp dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const origin = new URL(process.argv[2]);
assert(['localhost', '127.0.0.1'].includes(origin.hostname));
const controllerPlatform = process.argv[4] ?? 'win32';
assert(['win32', 'darwin'].includes(controllerPlatform));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-viewer-smoke-'));
const browser = await chromium.launch({
  executablePath: process.argv[3],
  headless: true,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 780 },
    colorScheme: 'light',
  });
  const host = await context.newPage(),
    viewer = await context.newPage();
  const hostUrl = new URL('/remote-desktop-smoke-host', origin.origin).href;
  await host.route(hostUrl, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<canvas width="1280" height="720"></canvas>',
    }),
  );
  await host.goto(hostUrl);
  await host.evaluate(() => {
    window.inputs = [];
    window.inputRoutes = { bridge: [], datachannel: [] };
  });
  const errors = [];
  viewer.on('pageerror', (error) => {
    errors.push(error.message);
  });
  const requests = [];
  let controlling = false;
  await viewer.exposeFunction('viewerRequest', async (request) => {
    requests.push(request.op);
    switch (request.op) {
      case 'capabilities':
        return {
          version: 1,
          enabled: true,
          canControl: true,
          clipboardText: true,
          automaticReconnect: true,
          videoSettings: true,
          platform: 'win32',
          displays: [
            {
              id: 'one',
              name: 'PG32UCDP — a long monitor name that must stay inside the selector',
              width: 1280,
              height: 720,
            },
            { id: 'two', name: 'Second monitor', width: 1920, height: 1080 },
          ],
        };
      case 'start':
        return {
          lease: 'test-lease',
          controlling: false,
          display: { id: 'one', width: 1280, height: 720 },
        };
      case 'control':
        controlling = request.enabled;
        return { controlling: request.enabled };
      case 'heartbeat':
        return { controlling };
      case 'input':
        await host.evaluate((events) => {
          window.inputs.push(...events);
          window.inputRoutes.bridge.push(...events);
        }, request.events);
        return { ok: true };
      case 'frame':
        return { jpeg: null };
      case 'stop':
        return { ok: true };
      case 'offer':
        return {
          sdp: await host.evaluate(async (sdp) => {
            window.peer?.close();
            clearInterval(window.paint);
            const canvas = document.querySelector('canvas'),
              ctx = canvas.getContext('2d');
            let tick = 0;
            window.paint = setInterval(() => {
              ctx.fillStyle = '#eee';
              ctx.fillRect(0, 0, 1280, 720);
              ctx.fillStyle = '#222';
              ctx.font = '36px sans-serif';
              ctx.fillText('Local WebRTC test · ' + ++tick, 50, 90);
            }, 60);
            const rtc = new RTCPeerConnection({ iceServers: [] });
            window.peer = rtc;
            const stream = canvas.captureStream(15);
            stream.getTracks().forEach((track) => rtc.addTrack(track, stream));
            rtc.ondatachannel = ({ channel }) => {
              channel.onmessage = ({ data }) => {
                const events = JSON.parse(data).events;
                window.inputs.push(...events);
                window.inputRoutes.datachannel.push(...events);
              };
            };
            await rtc.setRemoteDescription({ type: 'offer', sdp });
            await rtc.setLocalDescription(await rtc.createAnswer());
            if (rtc.iceGatheringState !== 'complete')
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, 5000);
                rtc.onicegatheringstatechange = () => {
                  if (rtc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                  }
                };
              });
            return rtc.localDescription.sdp;
          }, request.sdp),
        };
      default:
        return {};
    }
  });
  await viewer.addInitScript((controllerPlatform) => {
    window.viewerPeers = [];
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(...args) {
        super(...args);
        window.viewerPeers.push(this);
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        if (channel.label === 'input-v1') this.inputChannel = channel;
        return channel;
      }
    };
    const noop = () => {},
      off = () => noop;
    const scope = {
      target: { deviceId: 'test-host', name: 'Test computer' },
      generation: 1,
      active: true,
    };
    window.clipboardActions = [];
    window.confirmedCloses = [];
    window.electronAPI = {
      platform: controllerPlatform,
      preferredSystemLocale: 'en',
      logToMain: noop,
      appearanceSettings: { getSync: () => null, onChanged: off },
      localThemes: { listSync: () => ({ success: true, themes: [], diagnostics: [] }) },
      authHasPersistedSessionHintSync: () => true,
      appShortcuts: {
        getState: () => ({ overrides: {}, platform: controllerPlatform }),
        onChanged: off,
      },
      theme: { applyVibrancy: noop },
      getFullscreenState: async () => false,
      onFullscreenChange: (listener) => {
        window.applyViewerFullscreen = listener;
        return noop;
      },
      windowMinimize: noop,
      windowMaximize: noop,
      windowClose: noop,
      remoteDesktopViewer: {
        state: async () => scope,
        onActive: off,
        onLocale: (listener) => {
          window.applyViewerLocale = listener;
          return noop;
        },
        rendererReady: async () => {},
        presentationReady: async () => {},
        request: (_generation, request) => window.viewerRequest(request),
        ice: async () => [],
        inputFocus: async () => {},
        close: async (generation) => {
          window.confirmedCloses.push(generation);
        },
        onCloseRequested: () => () => {},
        fullscreen: async () => {},
        clipboard: async (_generation, action) => {
          window.clipboardActions.push(action);
        },
      },
    };
  }, controllerPlatform);
  await viewer.goto(new URL('/?remoteDesktopViewer=1', origin.origin).href);
  await viewer.waitForFunction(
    () => document.querySelector('video')?.videoWidth > 0,
    {},
    { timeout: 25000 },
  );
  await viewer.waitForFunction(() => document.querySelector('.remote-viewer-network') !== null);
  const readVideoStats = () =>
    viewer.evaluate(async () => {
      const peer = window.viewerPeers.at(-1);
      const stats = [...(await peer.getStats()).values()].find(
        (report) => report.type === 'inbound-rtp' && report.kind === 'video',
      );
      return {
        peers: window.viewerPeers.length,
        connection: peer.connectionState,
        width: document.querySelector('video').videoWidth,
        framesDecoded: stats?.framesDecoded ?? 0,
        bytesReceived: stats?.bytesReceived ?? 0,
      };
    });
  const initialVideo = await readVideoStats();
  assert(initialVideo.framesDecoded > 0 && initialVideo.bytesReceived > 0);
  const stage = await viewer.locator('#stage').boundingBox();
  assert(stage);
  assert.equal(await viewer.locator('#stage').evaluate((element) => element.style.cursor), 'none');
  await viewer.mouse.move(stage.x + 400, stage.y + 300);
  await host.waitForFunction(() => window.inputs.some((event) => event.kind === 'move'));
  await viewer.mouse.down();
  await host.waitForFunction(() =>
    window.inputs.some((event) => event.kind === 'button' && event.button === 0 && event.down),
  );
  await viewer.mouse.move(stage.x + 520, stage.y + 370, { steps: 5 });
  await viewer.mouse.up();
  await host.waitForFunction(() =>
    window.inputs.some((event) => event.kind === 'button' && event.button === 0 && !event.down),
  );
  const mouseEvents = await host.evaluate(() => window.inputs);
  const down = mouseEvents.findIndex((event) => event.kind === 'button' && event.down);
  const up = mouseEvents.findIndex(
    (event, index) => index > down && event.kind === 'button' && !event.down,
  );
  assert(
    mouseEvents.slice(down + 1, up).some((event) => event.kind === 'move'),
    'drag moves reach the host while the button is held',
  );
  assert(
    !mouseEvents.slice(down + 1, up).some((event) => event.kind === 'release'),
    'focus does not cancel a held mouse button',
  );
  await viewer.keyboard.type('desktop');
  await host.waitForFunction(() =>
    window.inputs.some((event) => event.kind === 'text' && event.text.includes('d')),
  );
  await viewer.waitForFunction(() => window.viewerPeers.at(-1).inputChannel.readyState === 'open');
  await viewer.keyboard.press('ArrowRight');
  await host.waitForFunction(() =>
    window.inputRoutes.datachannel.some(
      (event) => event.kind === 'key' && event.code === 'ArrowRight' && !event.down,
    ),
  );
  await viewer.evaluate(() => window.viewerPeers.at(-1).inputChannel.close());
  await viewer.waitForFunction(
    () => window.viewerPeers.at(-1).inputChannel.readyState === 'closed',
  );
  const bridgedRequests = requests.filter((op) => op === 'input').length;
  const bridgedInputs = await host.evaluate(() => window.inputRoutes.bridge.length);
  await viewer.mouse.move(stage.x + 480, stage.y + 330);
  await viewer.keyboard.type('bridge');
  await host.waitForFunction((before) => {
    const events = window.inputRoutes.bridge.slice(before);
    return (
      events.some((event) => event.kind === 'move') &&
      events.some((event) => event.kind === 'text' && event.text.includes('b'))
    );
  }, bridgedInputs);
  assert(
    requests.filter((op) => op === 'input').length > bridgedRequests,
    'mouse and keyboard input fall back to the preload bridge when the data channel closes',
  );
  const checkSelect = async (trigger, screenshot) => {
    const control = await trigger.boundingBox();
    await trigger.click();
    const menu = viewer.getByRole('listbox');
    await menu.waitFor();
    const panel = await menu.boundingBox();
    const viewport = viewer.viewportSize();
    assert(control && panel && viewport);
    assert(Math.abs(control.width - panel.width) < 1, 'menu matches its trigger width');
    assert(
      panel.x >= 0 && panel.x + panel.width <= viewport.width,
      'menu stays within horizontal bounds',
    );
    assert(
      panel.y >= 0 && panel.y + panel.height <= viewport.height,
      'menu stays within vertical bounds',
    );
    assert(
      await menu.evaluate((element) => element.scrollWidth <= element.clientWidth),
      'long options wrap inside the menu',
    );
    await viewer.keyboard.press('ArrowDown');
    await viewer.screenshot({ animations: 'disabled', path: path.join(artifacts, screenshot) });
    await viewer.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await viewer.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
  };
  await checkSelect(viewer.getByRole('combobox'), 'display-select.png');
  assert(
    !(await host.evaluate(() => window.inputs)).some(
      (event) => event.kind === 'key' && ['ArrowDown', 'Escape'].includes(event.code),
    ),
    'menu keyboard navigation never reaches the remote computer',
  );
  const checkExitDialog = async (theme) => {
    const labels = await viewer.evaluate(async () => {
      const catalog = (await import('/i18n/index.ts')).default;
      return {
        exit: catalog.t('remoteDesktop.disconnect'),
        cancel: catalog.t('commonUi.confirmDialog.cancel'),
      };
    });
    await viewer.getByRole('button', { name: labels.exit, exact: true }).click();
    const dialog = viewer.getByRole('alertdialog');
    await dialog.waitFor();
    assert.deepEqual(await viewer.evaluate(() => window.confirmedCloses), []);
    await viewer.screenshot({
      animations: 'disabled',
      path: path.join(artifacts, 'exit-' + theme + '.png'),
    });
    await dialog.getByRole('button', { name: labels.cancel, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await viewer.evaluate(() => window.confirmedCloses), []);
  };
  await viewer.screenshot({ animations: 'disabled', path: path.join(artifacts, 'light.png') });
  await checkExitDialog('light');
  await viewer.locator('#stage').click();
  const modifier = controllerPlatform === 'darwin' ? 'Meta' : 'Control';
  await viewer.keyboard.press(modifier + '+c');
  await viewer.keyboard.press(modifier + '+v');
  await viewer.waitForFunction(() => window.clipboardActions.length === 2);
  assert.deepEqual(await viewer.evaluate(() => window.clipboardActions), ['copy', 'paste']);
  await viewer.evaluate(async () => {
    const { themeService } = await import('/themes/theme-service.ts');
    const { cindyDark } = await import('/themes/builtin/cindy-dark.ts');
    themeService.applyTheme(cindyDark);
  });
  await viewer.screenshot({ animations: 'disabled', path: path.join(artifacts, 'dark.png') });
  await checkExitDialog('dark');
  await host.evaluate(() => window.peer.close());
  await viewer.evaluate(() => {
    const peer = window.viewerPeers.at(-1);
    peer.close();
    peer.dispatchEvent(new Event('connectionstatechange'));
  });
  await viewer.waitForFunction(
    () =>
      document
        .querySelector('.remote-viewer-network')
        ?.textContent.includes('Server screenshot relay'),
    {},
    { timeout: 12000 },
  );
  assert.equal(
    await viewer.locator('.remote-viewer-latency').count(),
    0,
    'screenshots do not inherit video RTT',
  );
  await viewer.screenshot({
    animations: 'disabled',
    path: path.join(artifacts, 'screenshot-relay.png'),
  });
  await viewer.waitForFunction(
    () => document.querySelector('.remote-viewer-network')?.textContent.includes('Direct'),
    {},
    { timeout: 25000 },
  );
  assert.equal(
    requests.filter((op) => op === 'start').length,
    1,
    'media recovery must retain its lease',
  );
  const recoveredVideo = await readVideoStats();
  assert(recoveredVideo.peers > initialVideo.peers, 'media recovery creates a new peer');
  assert.equal(recoveredVideo.connection, 'connected');
  assert(
    recoveredVideo.width > 0 &&
      recoveredVideo.framesDecoded > 0 &&
      recoveredVideo.bytesReceived > 0,
    'media recovery must decode new WebRTC frames, not just retain the old frame',
  );
  assert.deepEqual(errors, []);
  await viewer.evaluate(() => window.applyViewerLocale('zh-CN'));
  await viewer.getByRole('button', { name: '操作', exact: true }).click();
  const settings = viewer.getByRole('complementary', { name: '操作' });
  await settings.locator('label').filter({ hasText: '帧率' }).waitFor();
  assert(
    !/\?{2,}|\uFFFD/u.test(await settings.innerText()),
    'Chinese settings must remain readable',
  );
  await viewer.screenshot({
    animations: 'disabled',
    path: path.join(artifacts, 'settings-zh-dark.png'),
  });
  await checkSelect(settings.getByRole('combobox').first(), 'fps-select-zh-dark.png');
  await viewer.evaluate(async () => {
    const { themeService } = await import('/themes/theme-service.ts');
    const { cindyLight } = await import('/themes/builtin/cindy-light.ts');
    themeService.applyTheme(cindyLight);
  });
  await viewer.screenshot({
    animations: 'disabled',
    path: path.join(artifacts, 'settings-zh-light.png'),
  });
  await checkSelect(settings.getByRole('combobox').nth(1), 'quality-select-zh-light.png');
  const releaseLabel = await viewer.evaluate(async () =>
    (await import('/i18n/index.ts')).default.t('remoteDesktop.releaseControl'),
  );
  await viewer.getByRole('button', { name: releaseLabel, exact: true }).click();
  const desktopButton = settings.getByRole('button', { name: '桌面', exact: true });
  assert(await desktopButton.isDisabled(), 'view-only actions explain why control is required');
  await settings.getByText('当前仅查看，取得控制权后可使用剪贴板和桌面操作。').waitFor();
  const takeLabel = await viewer.evaluate(async () =>
    (await import('/i18n/index.ts')).default.t('remoteDesktop.takeControl'),
  );
  await settings.getByRole('button', { name: takeLabel, exact: true }).click();
  await viewer.waitForFunction(() => {
    const button = [...document.querySelectorAll('aside button')].find(
      (item) => item.textContent === '桌面',
    );
    return button && !button.disabled;
  });
  assert.equal(
    requests.filter((op) => op === 'start').length,
    1,
    'locale updates retain the desktop lease',
  );
  const network = viewer.locator('header .remote-viewer-network');
  assert(
    (await network.innerText()).includes('电脑直连'),
    'the toolbar identifies the active transport',
  );
  await viewer.setViewportSize({ width: 720, height: 420 });
  const bounds = await network.boundingBox();
  assert(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 720,
    'transport remains visible at minimum window width',
  );
  await viewer.screenshot({
    animations: 'disabled',
    path: path.join(artifacts, 'transport-compact.png'),
  });
  await viewer.setViewportSize({ width: 480, height: 420 });
  const toolbar = await viewer.locator('header').boundingBox();
  const settingsBounds = await settings.boundingBox();
  assert(
    await viewer.locator('header').evaluate((element) => element.scrollWidth <= innerWidth),
    'wrapped toolbar does not overflow',
  );
  assert(
    toolbar && settingsBounds && settingsBounds.y >= toolbar.y + toolbar.height,
    'settings follow the wrapped toolbar',
  );
  await checkSelect(settings.getByRole('combobox').first(), 'fps-select-narrow.png');
  await viewer.setViewportSize({ width: 720, height: 420 });
  if (controllerPlatform === 'darwin') {
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    await viewer.locator('#stage').click({ position: { x: 100, y: 100 } });
    await viewer.evaluate(() => window.applyViewerFullscreen(true));
    const overlay = viewer.locator('.remote-viewer-network-overlay');
    await overlay.waitFor();
    await viewer.waitForFunction(
      () => document.querySelector('.remote-viewer-toolbar').getBoundingClientRect().bottom <= 9,
    );
    assert(
      (await overlay.innerText()).includes('电脑直连'),
      'fullscreen retains the transport indicator',
    );
    await viewer.screenshot({
      animations: 'disabled',
      path: path.join(artifacts, 'transport-fullscreen.png'),
    });
    await viewer.mouse.move(400, 2);
    await viewer.waitForFunction(
      () => document.querySelector('header').getBoundingClientRect().top >= -1,
    );
    const displaySelect = viewer.getByRole('combobox');
    await displaySelect.click();
    await viewer.getByRole('listbox').hover();
    assert(
      (await viewer.locator('header').boundingBox()).y >= -1,
      'portalled menu keeps the fullscreen toolbar visible',
    );
    await viewer.keyboard.press('Escape');
    await viewer.getByRole('listbox').waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      video: true,
      keyboard: true,
      mouse: true,
      dataChannelInput: true,
      bridgeInput: true,
      clipboardShortcuts: true,
      exitConfirmation: true,
      controllerPlatform,
      mediaRecovery: true,
      recoveryFault: 'closed-peer-event',
      initialVideo,
      recoveredVideo,
      chineseSettings: true,
      localeKeepsLease: true,
      lightDarkArtifacts: artifacts,
    }),
  );
} finally {
  await browser.close();
}
