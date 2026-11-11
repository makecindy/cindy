// Explicit Electron integration fixture. Only native touch samples are stubbed;
// the production host, webview, OOPIF and debugger teardown are real.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { installNativeTrackpad } = require(process.argv.at(-1));
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});
let arms = 0,
  detaches = 0,
  completed = 0;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(
    req.url === '/host'
      ? '<webview style="width:100vw;height:100vh" src="http://localhost:' +
          server.address().port +
          '/"></webview>'
      : req.url === '/child'
        ? '<body style="margin:0"><div data-cindy-trackpad="contacts" style="width:100vw;height:100vh">Trackpad teardown regression</div>'
        : '<meta name="cindy-native-trackpad" content="touch"><body style="margin:0"><iframe style="border:0;width:100vw;height:100vh" src="http://127.0.0.1:' +
          server.address().port +
          '/child"></iframe>',
  );
});
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await app.whenReady();
  for (let cycle = 0; cycle < 30; cycle++) {
    const win = new BrowserWindow({
      width: 400,
      height: 400,
      webPreferences: {
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
        webviewTag: true,
      },
    });
    const host = win.webContents;
    const ready = new Promise((resolve) => host.once('did-attach-webview', (_e, g) => resolve(g)));
    const loading = host.loadURL('http://localhost:' + server.address().port + '/host');
    const guest = await ready;
    let armed = false;
    const native = {
      start() {
        armed = true;
        arms++;
        return arms;
      },
      stop() {},
    };
    guest.debugger.on('message', (_e, m) => {
      if (m === 'Target.detachedFromTarget') detaches++;
    });
    installNativeTrackpad(host, guest, () => true, {
      platform: 'darwin',
      load: () => native,
      window: () => win,
    });
    await loading;
    await new Promise((r) => (guest.isLoading() ? guest.once('did-stop-loading', r) : r()));
    win.focus();
    guest.focus();
    const start = Date.now();
    while (!armed && Date.now() - start < 10000) {
      guest.emit('before-mouse-event', {}, { type: 'mouseMove', x: 100, y: 100 });
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!armed) throw new Error('capture never armed');
    await host.executeJavaScript('document.querySelector("webview").remove()');
    await new Promise((r) => setTimeout(r, 30));
    win.destroy();
    completed++;
  }
  console.log(JSON.stringify({ arms, detaches, completed }));
  server.close();
  app.exit(detaches === 30 ? 0 : 2);
})().catch((e) => {
  console.error(e);
  app.exit(2);
});
setTimeout(() => app.exit(3), 30000).unref();
