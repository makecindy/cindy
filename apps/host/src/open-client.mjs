import { resolveHostDataDir } from './profile-path.mjs';
import { openHostBrowser } from './browser-open.mjs';

// Pair through the owner-only profile token. Neither the token nor the temporary
// browser code goes to stdout, disk, query parameters or the referrer header.
try {
  await openHostBrowser(resolveHostDataDir());
  console.log('Opened Cindy Host in your browser.');
} catch {
  console.error('Cannot open Cindy Host. Start it first and use the same CINDY_HOST_DATA_DIR.');
  process.exitCode = 1;
}
