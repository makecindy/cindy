// Test-only single-page host. Never imports Cindy bootstrap, auth, stores or agent runtimes.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const profile = process.env.CINDY_UI_PROFILE;
const bundleDir = process.env.CINDY_UI_BUNDLE_DIR;
const evidenceDir = process.env.CINDY_UI_EVIDENCE_DIR;
const preview = process.env.CINDY_UI_PREVIEW === '1';
if (![profile, bundleDir, evidenceDir].every((dir) => dir && path.isAbsolute(dir)))
  throw new Error('Missing isolated UI profile, bundle or evidence directory');
// Same policy the runner sends with the page document in Chromium mode.
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setName('Cindy UI Check');
// Fixed 2x density regardless of the attached display, matching a Retina Mac.
app.commandLine.appendSwitch('force-device-scale-factor', '2');
const origin = 'http://cindy-ui.test';
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};
// Background checks must not take focus or add a Dock icon to the user's desktop.
if (!preview) app.dock?.hide();
app.whenReady().then(() => {
  const ownSession = session.fromPartition('ui-check');
  // Only the local fixture's DOM fullscreen is needed by video assertions.
  // Screen capture, media devices and every other permission remain denied.
  const canFullscreen = (wc, permission) =>
    permission === 'fullscreen' && wc?.getURL().startsWith(origin + '/');
  ownSession.setPermissionRequestHandler((wc, permission, callback) => callback(canFullscreen(wc, permission)));
  ownSession.setPermissionCheckHandler((wc, permission) => canFullscreen(wc, permission));
  ownSession.on('will-download', (event) => event.preventDefault());
  ownSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({
      cancel: !['about:', 'data:', 'blob:'].includes(url.protocol) && url.origin !== origin,
    });
  });
  // Everything on the test origin is a file the runner wrote for this run: variant documents,
  // bundle files, and (for the overview) evidence screenshots. Other http requests are refused.
  ownSession.protocol.handle('http', async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const [base, relative] = pathname.startsWith('/__evidence/')
      ? [evidenceDir, pathname.slice('/__evidence/'.length)]
      : [bundleDir, pathname];
    const file = path.join(base, relative);
    if (url.origin !== origin || !file.startsWith(base + path.sep))
      return new Response(null, { status: 403 });
    try {
      const type = types[path.extname(file)] ?? 'application/octet-stream';
      return new Response(await fs.promises.readFile(file), {
        headers: {
          'content-type': type,
          ...(type === 'text/html' && base === bundleDir ? { 'content-security-policy': csp } : {}),
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  const win = new BrowserWindow({
    width: Number(process.env.CINDY_UI_WIDTH),
    height: Number(process.env.CINDY_UI_HEIGHT),
    useContentSize: true,
    // Native decorations round at forced 2x DPI on Windows (400 CSS px became
    // 401). Background captures need only the content, not a platform frame.
    frame: preview,
    show: preview,
    title: 'Cindy UI Check',
    webPreferences: {
      // A hidden native Windows window can retain its old renderer size and
      // stop producing frames. Offscreen rendering keeps checks hidden while
      // allowing exact resizing and screenshots without showing a native window.
      offscreen: !preview && process.platform === 'win32',
      // Exercise the real DOM Fullscreen API/top layer without entering a native
      // macOS Space. A hidden check window cannot complete that OS transition,
      // and its pending resize would otherwise contaminate subsequent variants.
      disableHtmlFullscreenWindowResize: !preview,
      session: ownSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  void win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
