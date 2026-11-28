// Run by macos-system-proxy-compare.mjs (macOS CI only) with the repository's Electron: prints, as one
// JSON line, Chromium's PAC result (session.defaultSession.resolveProxy) for each URL in the JSON array
// given as the last argument. The default session uses the system proxy settings, as the desktop's does
// (the desktop never calls setProxy). Reads settings only; changes nothing.
const { app, session } = require('electron');

if (process.env.CINDY_COMPARE_USER_DATA) app.setPath('userData', process.env.CINDY_COMPARE_USER_DATA);
app.dock?.hide();

app.whenReady().then(async () => {
  const urls = JSON.parse(process.argv[process.argv.length - 1]);
  const results = {};
  for (const url of urls) results[url] = await session.defaultSession.resolveProxy(url);
  process.stdout.write(`${JSON.stringify(results)}\n`);
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  app.exit(1);
});
