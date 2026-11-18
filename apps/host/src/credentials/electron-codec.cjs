/** Private stdio helper: only OS encryption, no renderer, network or database. */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
app.setPath('userData', process.env.CINDY_HOST_DATA_DIR);
app.setName(process.env.CINDY_HOST_CREDENTIAL_APP);
app.dock?.hide();
app.whenReady().then(() => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error();
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    let value;
    if (request.operation === 'encrypt' && typeof request.value === 'string') {
      value = safeStorage.encryptString(request.value).toString('base64');
    } else if (request.operation === 'decrypt' && typeof request.value === 'string') {
      value = safeStorage.decryptString(Buffer.from(request.value, 'base64'));
    } else throw new Error();
    // Quit normally, not app.exit(): on Windows the DPAPI-wrapped key safeStorage just created lives in this
    // profile's `Local State`, which Chromium writes only on a normal shutdown. After an abrupt exit the next
    // process made a new key and could not decrypt the record (Host signed in, then failed at start).
    process.stdout.write(JSON.stringify({ value }), () => app.quit());
  } catch {
    // Never serialize OS errors: they may contain a secret or a profile path.
    process.stdout.write(JSON.stringify({ error: 'CREDENTIAL_STORE_UNAVAILABLE' }), () => app.exit(1));
  }
}).catch(() => app.exit(1));
